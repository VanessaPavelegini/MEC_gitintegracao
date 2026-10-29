"use strict";

// Azure Function: syncGitLabPlannerPremiumTimer
//
// Dispara o sync do Planner Premium em intervalo fixo — é o que faz o
// "usuário atualizou o GitLab → o Planner reflete" acontecer sem alguém
// precisar chamar nada.
//
// Endpoints:
//   POST /api/gitlab-planner-premium-timer      — roda o sync agora (para teste)
//   GET  /api/gitlab-planner-premium-timer      — idem
//
// O agendamento em si é o app.timer abaixo (schedule no código). A rota HTTP
// existe para:
//   - rodar o sync na hora, sem esperar o próximo disparo;
//   - confirmar o comportamento em produção depois do deploy.
//
// Variáveis de ambiente:
//   PREMIUM_TIMER_INTERVAL_MINUTES  — de quanto em quanto tempo o timer roda
//                                     (default 30)
//   PREMIUM_TIMER_LOOKBACK_MINUTES  — janela lida em cada disparo
//                                     (default 60 — cobre o intervalo com folga)
//   DATAVERSE_URL_PREMIUM / DATAVERSE_URL / PREMIUM_HOMOLOGACAO_*_ID
//
// Por que 30/60: a janela (60 min) é maior que o intervalo (30 min) de
// propósito — se um disparo falhar ou demorar, o próximo ainda cobre a
// janela toda. O que a janela perde é coberto pela varredura completa.

const { app } = require("@azure/functions");

const gitlabService = require("./gitlabService");
const premiumDataverse = require("./premiumDataverse");
const premiumMapping = require("./premiumMapping");
const premiumSync = require("./premiumSync");
const { runPremiumChanges } = require("./premiumChangesHandler");
const { acquireLock, releaseLock } = require("./premiumSyncLock");
const tableStorage = require("./tableStorage");
const { getDataverseDelegatedToken } = require("../../shared/dataverseServiceAccountAuth");

const ORG_URL = process.env.DATAVERSE_URL_PREMIUM || "https://orgcf194dda.crm.dynamics.com";
const PRD_URL = process.env.DATAVERSE_URL;
const DEFAULT_PLAN_ID = process.env.PREMIUM_HOMOLOGACAO_PLAN_ID || "c0ecce95-1107-4343-8c05-bcf7c9a291f8";
const DEFAULT_BUCKET_NAME = process.env.PREMIUM_HOMOLOGACAO_BUCKET_NAME || "Bucket 1";
const DEFAULT_BUCKET_ID = process.env.PREMIUM_HOMOLOGACAO_BUCKET_ID || "be10a1da-0bd2-f111-84dc-7c1e520d9dbb";

const INTERVAL_MINUTES = Number(process.env.PREMIUM_TIMER_INTERVAL_MINUTES || 30);
const LOOKBACK_MINUTES = Number(process.env.PREMIUM_TIMER_LOOKBACK_MINUTES || 60);

let _tokenCache = { token: null, expiresAt: 0 };
const _bucketCache = new Map();

async function getDelegatedToken() {
  if (_tokenCache.token && Date.now() < _tokenCache.expiresAt) return _tokenCache.token;
  const token = await getDataverseDelegatedToken({ orgUrl: ORG_URL });
  _tokenCache = { token, expiresAt: Date.now() + 45 * 60 * 1000 };
  return token;
}

async function listProjectBuckets({ projectId }) {
  if (_bucketCache.has(projectId)) return _bucketCache.get(projectId);
  const token = await getDelegatedToken();
  const buckets = await premiumDataverse.listProjectBuckets({ projectId, token, baseUrl: ORG_URL });
  _bucketCache.set(projectId, buckets);
  return buckets;
}

const gitlab = {
  listIssuesPage: (filters) => gitlabService.listIssuesPage(filters),
};

// Trava de execução: blob com nome fixo no container de service-tokens.
const LOCK_BLOB_NAME = process.env.PREMIUM_SYNC_LOCK_BLOB || "premium-sync-lock.json";

function lockBlobClient() {
  if (!globalThis.crypto) globalThis.crypto = require("node:crypto").webcrypto;
  const { BlobServiceClient } = require("@azure/storage-blob");
  const connStr = process.env.AZURE_STORAGE_CONNECTION_STRING || process.env.AzureWebJobsStorage;
  if (!connStr) {
    throw new Error("AZURE_STORAGE_CONNECTION_STRING não configurada — sem trava, dois syncs podem rodar juntos.");
  }
  const container = process.env.PREMIUM_SYNC_BLOB_CONTAINER || "service-tokens";
  return BlobServiceClient.fromConnectionString(connStr)
    .getContainerClient(container)
    .getBlockBlobClient(LOCK_BLOB_NAME);
}

const deps = {
  planId: DEFAULT_PLAN_ID,
  bucketName: DEFAULT_BUCKET_NAME,
  bucketId: DEFAULT_BUCKET_ID,
  syncPage: (args) =>
    premiumSync.syncPage({
      ...args,
      gitlab,
      mapping: premiumMapping,
      premium: premiumDataverse,
      orgUrl: ORG_URL,
      prdBaseUrl: PRD_URL,
    }),
  getDelegatedToken,
  getPrdToken: () => tableStorage.getAccessToken(),
  listProjectBuckets,
  acquireLock: (args) => acquireLock({ blobClient: lockBlobClient(), ...args }),
  releaseLock: () => releaseLock({ blobClient: lockBlobClient() }),
  lockOwner: "timer",
};

// O cron do Azure Functions é de 6 campos (segundo minuto hora dia mês diaSemana).
// "*/N * * * *" = a cada N minutos.
const schedule = `*/${INTERVAL_MINUTES} * * * *`;

app.timer("syncGitLabPlannerPremiumTimer", {
  schedule,
  handler: async (myTimer, context) => {
    context.log(`[syncGitLabPlannerPremiumTimer] disparado (intervalo=${INTERVAL_MINUTES}min janela=${LOOKBACK_MINUTES}min)`);
    try {
      const result = await runPremiumChanges({
        request: { body: { planId: DEFAULT_PLAN_ID, lookbackMinutes: LOOKBACK_MINUTES }, query: {} },
        deps,
      });
      const b = result.body || {};
      context.log(
        `[syncGitLabPlannerPremiumTimer] ok=${b.ok} processados=${b.processed} criados=${b.created} ` +
        `atualizados=${b.updated} iguais=${b.unchanged} erros=${(b.errors || []).length} duracao=${b.durationMs}ms`
      );
      if (!b.ok) {
        context.error(`[syncGitLabPlannerPremiumTimer] falhou: ${b.error}`);
      }
    } catch (e) {
      context.error(`[syncGitLabPlannerPremiumTimer] exceção: ${e?.message || e}`);
    }
  },
});

app.http("syncGitLabPlannerPremiumTimerHttp", {
  methods: ["GET", "POST"],
  authLevel: "function",
  route: "gitlab-planner-premium-timer",
  handler: async (request) => {
    const query = request.query && typeof request.query.entries === "function"
      ? Object.fromEntries(request.query.entries())
      : (request.query || {});
    const body = await request.json().catch(() => ({}));

    const result = await runPremiumChanges({
      request: {
        body: { lookbackMinutes: LOOKBACK_MINUTES, ...body },
        query: { lookbackMinutes: LOOKBACK_MINUTES, ...query },
      },
      deps,
    });
    return { status: result.status, jsonBody: result.body };
  },
});
