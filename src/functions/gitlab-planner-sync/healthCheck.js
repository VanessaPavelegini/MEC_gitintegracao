"use strict";
// Azure Function: healthCheck
//
// Endpoint público para verificar se a Function e suas dependências
// externas estão respondendo. Útil para monitoramento e diagnóstico.
//
// Rota: GET /api/health
//
// Resposta 200: { healthy: true, dependencies: { env, gitlab, dataverse, planner } }
// Resposta 503: { healthy: false, dependencies: { ... } }

const { app } = require("@azure/functions");
const { getGraphClient } = require("../../shared/graphClient");
const { getAccessToken } = require("./tableStorage");
const { getGitLabClient } = require("./gitlabService");

const REQUIRED_ENV = ["AZURE_TENANT_ID", "AZURE_CLIENT_ID", "AZURE_CLIENT_SECRET"];

/**
 * Verifica se variáveis obrigatórias estão presentes
 */
function checkEnvVars() {
  const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
  return {
    ok: missing.length === 0,
    missing,
    configured: {
      tenantId: !!process.env.AZURE_TENANT_ID,
      clientId: !!process.env.AZURE_CLIENT_ID,
      clientSecret: !!process.env.AZURE_CLIENT_SECRET,
      dataverseUrl: !!process.env.DATAVERSE_URL,
      plannerPlanId: !!process.env.PLANNER_PLAN_ID,
      gitlabProjectId: !!process.env.GITLAB_PROJECT_ID,
      gitlabToken: !!process.env.GITLAB_TOKEN,
      webhookSecret: !!process.env.GITLAB_WEBHOOK_SECRET,
      functionKey: !!process.env.FUNCTION_KEY,
    },
  };
}

/**
 * Verifica conectividade com o GitLab
 */
async function checkGitLab() {
  try {
    const client = getGitLabClient();
    const projectPath = process.env.GITLAB_PROJECT_ID || "doc-sis/documentacao-novosistec2";
    const r = await client.get(`/projects/${encodeURIComponent(projectPath)}`);
    return {
      ok: true,
      url: process.env.GITLAB_URL,
      projectId: r.data.id,
      projectName: r.data.name,
    };
  } catch (err) {
    return {
      ok: false,
      url: process.env.GITLAB_URL,
      error: err.message,
      status: err.response?.status,
    };
  }
}

/**
 * Verifica se consegue obter token do Dataverse
 */
async function checkDataverse() {
  try {
    await getAccessToken();
    return {
      ok: true,
      url: process.env.DATAVERSE_URL,
    };
  } catch (err) {
    return {
      ok: false,
      url: process.env.DATAVERSE_URL,
      error: err.message,
    };
  }
}

/**
 * Verifica se consegue ler o plano do Planner via Graph API
 */
async function checkPlanner() {
  try {
    const planId = process.env.PLANNER_PLAN_ID;
    if (!planId) {
      return { ok: false, error: "PLANNER_PLAN_ID não configurado" };
    }
    const client = getGraphClient();
    const r = await client.api(`/planner/plans/${planId}`).get();
    return {
      ok: true,
      planId,
      planTitle: r.data.title,
    };
  } catch (err) {
    return {
      ok: false,
      planId: process.env.PLANNER_PLAN_ID,
      error: err.message,
      status: err.response?.status,
    };
  }
}

app.http("healthCheck", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "health",
  handler: async (request, context) => {
    context.log("[healthCheck] Verificando dependências...");

    const result = {
      timestamp: new Date().toISOString(),
      environment: process.env.AZURE_FUNCTIONS_ENVIRONMENT || "development",
      version: process.env.npm_package_version || "unknown",
      service: "func-gitintegracao",
      dependencies: {
        env: checkEnvVars(),
        gitlab: await checkGitLab(),
        dataverse: await checkDataverse(),
        planner: await checkPlanner(),
      },
    };

    const allOk = Object.values(result.dependencies).every((d) => d.ok);
    result.healthy = allOk;

    context.log(`[healthCheck] healthy=${allOk}`);

    return {
      status: allOk ? 200 : 503,
      jsonBody: result,
    };
  },
});
