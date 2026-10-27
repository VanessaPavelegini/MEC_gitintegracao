"use strict";

// Azure Function: syncGitLabPlannerPremiumHomologacao
//
// Sync GitLab → Planner Premium para o plano de HOMOLOGAÇÃO
// ("Homologação _NOVO SISTEC 2 - Cópia") na org Default.
//
// Endpoints:
//   POST /api/gitlab-planner-premium-homologacao             — sincroniza UMA página
//   GET  /api/gitlab-planner-premium-homologacao             — idem (parâmetros na query)
//   GET  /api/gitlab-planner-premium-homologacao-buckets     — lista os buckets do plano
//
// Quem chama: o flow do Power Automate "Sincronizar GitLab → Planner Premium
// (Homologação)", que repassa o cursor até o fim (o sync de ~720 issues não
// cabe no timeout de 230 s de uma chamada só).
//
// Identidade: a escrita no Planner Premium exige uma identidade com licença
// de projeto — o app user app-pnld (client credentials) é bloqueado com
// UserNotLicensed. Aqui a identidade é a conta de serviço
// portaldedemandas@mec.gov.br, via device code flow (refresh token no Blob).
//
// Variáveis de ambiente:
//   DATAVERSE_URL_PREMIUM           → org Default (https://orgcf194dda.crm.dynamics.com)
//   DATAVERSE_URL                   → org PRD (Aplicativos), onde fica o mapping
//   PREMIUM_HOMOLOGACAO_PLAN_ID     → GUID do msdyn_project do plano
//   PREMIUM_HOMOLOGACAO_BUCKET_NAME → nome do bucket destino (default "Bucket 1")
//   PREMIUM_HOMOLOGACAO_BUCKET_ID   → GUID do bucket destino (default "Bucket 1")
//   AZURE_STORAGE_CONNECTION_STRING → Blob onde fica o refresh token

const { app } = require("@azure/functions");

const gitlabService = require("./gitlabService");
const premiumDataverse = require("./premiumDataverse");
const premiumMapping = require("./premiumMapping");
const premiumSync = require("./premiumSync");
const { runPremiumSync } = require("./premiumHandler");
const tableStorage = require("./tableStorage");
const { getDataverseDelegatedToken } = require("../../shared/dataverseServiceAccountAuth");

const ORG_URL = process.env.DATAVERSE_URL_PREMIUM || "https://orgcf194dda.crm.dynamics.com";
const PRD_URL = process.env.DATAVERSE_URL;
const DEFAULT_PLAN_ID = process.env.PREMIUM_HOMOLOGACAO_PLAN_ID || "c385351a-e450-4d54-87ed-d54c57794f7b";
const DEFAULT_BUCKET_NAME = process.env.PREMIUM_HOMOLOGACAO_BUCKET_NAME || "Bucket 1";
// O plano de homologação tem um único bucket ("Bucket 1"). Fixar o GUID evita
// depender do token delegado só para descobrir o bucket (o dry run roda sem).
const DEFAULT_BUCKET_ID = process.env.PREMIUM_HOMOLOGACAO_BUCKET_ID || "f704c207-84be-f111-a04d-7c1e520d9f67";

// Caches de processo: o token delegado dura ~1 h e os buckets do plano não
// mudam — evita um round-trip ao AAD e ao Dataverse a cada página.
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
  const buckets = await premiumDataverse.listProjectBuckets({
    projectId,
    token,
    baseUrl: ORG_URL,
  });
  _bucketCache.set(projectId, buckets);
  return buckets;
}

// Adaptadores: o syncPage espera estas assinaturas.
const gitlab = {
  listIssuesPage: (filters) => gitlabService.listIssuesPage(filters),
};

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
};

app.http("syncGitLabPlannerPremiumHomologacao", {
  methods: ["GET", "POST"],
  authLevel: "function",
  route: "gitlab-planner-premium-homologacao",
  handler: async (request) => {
    // O runtime v4 entrega query como URLSearchParams e body como stream:
    // normaliza para um objeto simples (o handler é testável isoladamente).
    const query = request.query && typeof request.query.entries === "function"
      ? Object.fromEntries(request.query.entries())
      : (request.query || {});
    const body = await request.json().catch(() => ({}));

    const result = await runPremiumSync({ request: { body, query }, deps });
    return { status: result.status, jsonBody: result.body };
  },
});

app.http("gitlabPlannerPremiumHomologacaoBuckets", {
  methods: ["GET"],
  authLevel: "function",
  route: "gitlab-planner-premium-homologacao-buckets",
  handler: async (request) => {
    try {
      const planId = request.query?.get("planId") || DEFAULT_PLAN_ID;
      const buckets = await listProjectBuckets({ projectId: planId });
      return { status: 200, jsonBody: { ok: true, planId, buckets } };
    } catch (e) {
      return { status: 500, jsonBody: { ok: false, error: e?.message || String(e) } };
    }
  },
});
