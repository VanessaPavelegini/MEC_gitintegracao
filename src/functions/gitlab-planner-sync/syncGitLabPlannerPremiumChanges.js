"use strict";

// Azure Function: syncGitLabPlannerPremiumChanges
//
// Detecta o que o usuário mudou no GitLab e leva ao Planner Premium.
//
// Endpoints:
//   POST /api/gitlab-planner-premium-changes             — varre a janela
//   GET  /api/gitlab-planner-premium-changes             — idem (parâmetros na query)
//
// Variáveis de ambiente:
//   DATAVERSE_URL_PREMIUM           → org Default (https://orgcf194dda.crm.dynamics.com)
//   DATAVERSE_URL                   → org PRD (Aplicativos), onde fica o mapping
//   PREMIUM_HOMOLOGACAO_PLAN_ID     → GUID do msdyn_project do plano
//   PREMIUM_HOMOLOGACAO_BUCKET_ID   → GUID do bucket destino

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

// Caches de processo: o token delegado dura ~1 h.
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

// Adaptadores: o syncPage espera estas assinaturas.
const gitlab = {
  listIssuesPage: (filters) => gitlabService.listIssuesPage(filters),
};

// Trava de execução: blob com nome fixo no container de service-tokens.
// Criar o blob é atômico — o primeiro a criar ganha a trava.
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
};

app.http("syncGitLabPlannerPremiumChanges", {
  methods: ["GET", "POST"],
  authLevel: "function",
  route: "gitlab-planner-premium-changes",
  handler: async (request) => {
    const query = request.query && typeof request.query.entries === "function"
      ? Object.fromEntries(request.query.entries())
      : (request.query || {});
    const body = await request.json().catch(() => ({}));

    const result = await runPremiumChanges({ request: { body, query }, deps });
    return { status: result.status, jsonBody: result.body };
  },
});
