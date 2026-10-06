"use strict";
// Azure Function: syncGitLabPlannerPremium
//
// Handler NOVO para integração GitLab → Planner Premium (Aplicativos PRD).
// Diferente do syncGitLabPlanner.js (que usa Microsoft Graph API direto),
// este chama o Power Automate flow "IntegraçãoGitLab" via HTTP trigger,
// que por sua vez executa as actions Premium (CreateOperationSet +
// PssCreate + ExecuteOperationSet) com a identidade licenciada de
// antoniojunior@mec.gov.br — destravando o erro UserNotLicensed do app
// user app-pnld.
//
// Endpoints:
//   POST /api/gitlab-webhook-premium  - Recebe webhook do GitLab
//   GET  /api/premium-health          - Health check do Premium
//
// Variáveis de ambiente necessárias:
//   - POWER_AUTOMATE_PREMIUM_URL     → URL do trigger HTTP do Flow PA
//   - POWER_AUTOMATE_PREMIUM_TRIGGER_NAME → nome do trigger (default "manual")
//   - POWER_AUTOMATE_PREMIUM_PROJECT_ID → GUID do projeto (msdyn_project)
//                                   default: `8ebc738c-bcb3-f111-aaab-00224836dcc6`
//   - POWER_AUTOMATE_PREMIUM_CONNECTION_ID → connection reference do PA
//   - BUCKET_MAP_*                   → JSON com mapeamento label → bucket GUID
//
// Por que Power Automate no lugar de Dataverse direto:
//   O token do app user app-pnld bate em UserNotLicensed no
//   ExecuteOperationSetV1 (ver me-premium-bloqueio-licenca.md).
//   O Flow PA roda com a identidade licenciada do usuário que o criou —
//   destrava o erro sem precisar licenciar app users.

const { app } = require("@azure/functions");
const axios = require("axios");

const {
  mapLabelToBucket,
  normalizeLabel,
} = require("./gitlabService");

// ─── Configurações ─────────────────────────────────────────────────────────────

const POWER_AUTOMATE_URL = process.env.POWER_AUTOMATE_PREMIUM_URL;
const PROJECT_ID = process.env.POWER_AUTOMATE_PREMIUM_PROJECT_ID
  || "8ebc738c-bcb3-f111-aaab-00224836dcc6";
const GITLAB_WEBHOOK_SECRET = process.env.GITLAB_WEBHOOK_SECRET;

// Plano Premium "AutomaçãoTestes" (Aplicativos PRD)
// Buckets descobertos em 02/10/2026 via Listar linhas.
const BUCKET_MAP_GUIDS = {
  backlog: "f3125edd-bcb3-f111-aaab-7ced8db10825",
  "em analise": "f5125edd-bcb3-f111-aaab-7ced8db10825",
  analise: "f5125edd-bcb3-f111-aaab-7ced8db10825",
  "em desenvolvimento": "f6125edd-bcb3-f111-aaab-7ced8db10825",
  desenvolvimento: "f6125edd-bcb3-f111-aaab-7ced8db10825",
  revisao: "a78d5ee0-bcb3-f111-aaac-7ced8da8d8be",
  "em revisao": "a78d5ee0-bcb3-f111-aaac-7ced8da8d8be",
  review: "a78d5ee0-bcb3-f111-aaac-7ced8da8d8be",
  concluido: "628686e0-bcb3-f111-aaac-6045bd3a7abb",
  done: "628686e0-bcb3-f111-aaac-6045bd3a7abb",
  pronto: "628686e0-bcb3-f111-aaac-6045bd3a7abb",
  homologada: "628686e0-bcb3-f111-aaac-6045bd3a7abb",
  "hu homologada": "628686e0-bcb3-f111-aaac-6045bd3a7abb",
  "aprovada no teste": "628686e0-bcb3-f111-aaac-6045bd3a7abb",
  // Labels semânticas (não-status) que aparecem no projeto doc-sis:
  "adequacao - mantis": "f3125edd-bcb3-f111-aaab-7ced8db10825",
  instituicao: "f3125edd-bcb3-f111-aaab-7ced8db10825",
  "pp - 13": "f3125edd-bcb3-f111-aaab-7ced8db10825",
  "sprint 28": "f3125edd-bcb3-f111-aaab-7ced8db10825",
};

const BUCKET_DEFAULT_GUID = BUCKET_MAP_GUIDS.backlog;

// Labels que NÃO devem gerar/atualizar task no Planner. Quando uma issue
// traz uma dessas labels, o handler responde 200 skipped sem chamar o PA.
// Hoje: HUs canceladas — não vale a pena poluir o Planner com elas.
const SKIP_LABELS = new Set([
  "hu cancelada",
  "hu canceladas",
  "cancelada",
  "cancelado",
]);

function hasSkipLabel(labels) {
  if (!labels || !Array.isArray(labels)) return false;
  for (const label of labels) {
    if (SKIP_LABELS.has(normalizeLabel(labelToString(label)))) return true;
  }
  return false;
}

// ─── Validação do Webhook ──────────────────────────────────────────────────────

function validateGitLabToken(request) {
  if (!GITLAB_WEBHOOK_SECRET) {
    return true; // dev: sem secret, aceita
  }
  const token = request.headers.get("x-gitlab-token");
  if (!token || token !== GITLAB_WEBHOOK_SECRET) {
    return false;
  }
  return true;
}

// ─── Helpers de label ──────────────────────────────────────────────────────────

/**
 * GitLab webhook manda labels como objetos { title, id, color, ... }, mas
 * listIssues e APIs REST às vezes retornam string. Aceita os dois formatos.
 */
function labelToString(label) {
  if (typeof label === "string") return label;
  if (label && typeof label === "object") return label.title || label.name || "";
  return "";
}

// ─── Mapeamento de label → GUID do bucket ──────────────────────────────────────

/**
 * Mapeia uma label do GitLab para o GUID do bucket do Plano Premium.
 * Retorna o bucket "Backlog" se não houver match.
 */
function mapLabelToBucketGuid(label) {
  if (!label) return BUCKET_DEFAULT_GUID;
  const normalized = normalizeLabel(labelToString(label));
  return BUCKET_MAP_GUIDS[normalized] || BUCKET_DEFAULT_GUID;
}

/**
 * Procura a primeira label de status da issue e retorna o GUID do bucket.
 * Ordem de prioridade: homologadas > Revisão > Em Desenvolvimento > Análise > Backlog.
 */
function pickBucketGuidFromLabels(labels) {
  if (!labels || !Array.isArray(labels) || labels.length === 0) {
    return BUCKET_DEFAULT_GUID;
  }

  const priorityKeys = [
    "aprovada no teste", "hu homologada", "homologada", "concluido", "done", "pronto",
    "revisao", "review",
    "em desenvolvimento", "desenvolvimento",
    "em analise", "analise",
    "backlog",
  ];

  for (const key of priorityKeys) {
    for (const label of labels) {
      if (normalizeLabel(labelToString(label)) === key) {
        return BUCKET_MAP_GUIDS[key];
      }
    }
  }

  return BUCKET_DEFAULT_GUID;
}

// ─── Transformação payload GitLab → payload Power Automate ─────────────────────

function gitlabIssueToPlannerTask(issue) {
  // GitLab manda labels como objetos; PA espera strings. Normaliza aqui pra
  // o body chegar limpo pro Flow.
  const labels = (issue.labels || []).map(labelToString).filter(Boolean);
  const bucketGuid = pickBucketGuidFromLabels(labels);
  const startDate = (issue.created_at || new Date().toISOString()).slice(0, 10);
  const finishDate = issue.due_date
    ? issue.due_date.slice(0, 10)
    : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  return {
    subject: `[#${issue.iid}] ${issue.title}`.substring(0, 500),
    bucketGuid,
    startDate,
    finishDate,
    percentComplete: issue.state === "closed" ? 100 : 0,
    description: (issue.description || "").substring(0, 10000),
    labels,
    webUrl: issue.web_url,
    // iid do GitLab vem como número no payload; schema do Power Automate
    // espera string. Coerce aqui pra evitar TriggerInputSchemaMismatch.
    iid: String(issue.iid),
    projectId: PROJECT_ID,
  };
}

// ─── Chamada ao Power Automate ────────────────────────────────────────────────

async function callPowerAutomate(payload, context) {
  if (!POWER_AUTOMATE_URL) {
    throw new Error("POWER_AUTOMATE_PREMIUM_URL não configurada nas settings da Function App");
  }

  context.log(`[syncGitLabPlannerPremium] POST Power Automate: ${JSON.stringify(payload)}`);

  const resp = await axios.post(POWER_AUTOMATE_URL, payload, {
    headers: { "Content-Type": "application/json" },
    timeout: 30000,
  });

  context.log(`[syncGitLabPlannerPremium] Power Automate respondeu: status=${resp.status}`);
  return resp.data;
}

// ─── Handler: webhook do GitLab ───────────────────────────────────────────────

app.http("syncGitLabPlannerPremium", {
  methods: ["POST"],
  authLevel: "function",
  route: "gitlab-webhook-premium",
  handler: async (request, context) => {
    context.log("[syncGitLabPlannerPremium] webhook recebido");

    // 1. Valida token do GitLab
    if (!validateGitLabToken(request)) {
      context.error("[syncGitLabPlannerPremium] token GitLab inválido");
      return {
        status: 401,
        jsonBody: { error: "Invalid GitLab token" },
      };
    }

    // 2. Lê body
    let body;
    try {
      body = await request.json();
    } catch (e) {
      context.error(`[syncGitLabPlannerPremium] body inválido: ${e.message}`);
      return { status: 400, jsonBody: { error: "Invalid body" } };
    }

    // 3. Filtra eventos do GitLab — só processa criação de issue (action=open).
    // Updates de label/título são ignorados: sem idempotência, processar
    // 'update' geraria tasks duplicadas a cada mudança de label.
    const objectKind = body.object_kind || "";
    const eventType = request.headers.get("x-gitlab-event") || "";
    const action = (body.object_attributes && body.object_attributes.action)
      || body.action
      || "";

    if (objectKind !== "issue") {
      context.log(`[syncGitLabPlannerPremium] ignorando evento: object_kind=${objectKind} event=${eventType}`);
      return {
        status: 200,
        jsonBody: { ok: true, skipped: true, reason: `object_kind ${objectKind} ignored` },
      };
    }

    if (action && action !== "open") {
      context.log(`[syncGitLabPlannerPremium] ignorando action=${action} (só processa 'open')`);
      return {
        status: 200,
        jsonBody: { ok: true, skipped: true, reason: `action ${action} ignored` },
      };
    }

    // GitLab webhook põe a issue em object_attributes (ou em .issue no payload
    // do Note Hook). Aceita os dois pra ser tolerante.
    const issue = body.object_attributes || body.issue || {};
    const iid = issue.iid;
    if (!iid) {
      return { status: 400, jsonBody: { error: "issue.iid missing" } };
    }

    // HUs canceladas não viram task no Planner. Loga e sai cedo.
    if (hasSkipLabel(issue.labels)) {
      const skipLabel = issue.labels.find(l => SKIP_LABELS.has(normalizeLabel(labelToString(l))));
      context.log(`[syncGitLabPlannerPremium] ignorando issue #${iid} (label skip: ${labelToString(skipLabel)})`);
      return {
        status: 200,
        jsonBody: { ok: true, skipped: true, reason: `label '${labelToString(skipLabel)}' marcada como skip` },
      };
    }

    // 4. Transforma payload
    const task = gitlabIssueToPlannerTask(issue);
    context.log(`[syncGitLabPlannerPremium] issue #${iid} → task: bucketGuid=${task.bucketGuid} subject="${task.subject}"`);

    // 5. Chama Power Automate
    try {
      const result = await callPowerAutomate(task, context);
      context.log(`[syncGitLabPlannerPremium] OK iid=${iid} result=${JSON.stringify(result)}`);
      return {
        status: 200,
        jsonBody: { ok: true, iid, taskId: result?.taskId || null, result },
      };
    } catch (e) {
      const status = e.response?.status || 500;
      const errBody = e.response?.data || e.message;
      context.error(`[syncGitLabPlannerPremium] FALHOU iid=${iid}: status=${status} body=${JSON.stringify(errBody)}`);
      return {
        status: 502,
        jsonBody: { ok: false, iid, error: "Power Automate call failed", upstream: errBody },
      };
    }
  },
});

// ─── Handler: health check ───────────────────────────────────────────────────

app.http("premiumHealth", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "premium-health",
  handler: async (request, context) => {
    const result = {
      timestamp: new Date().toISOString(),
      service: "syncGitLabPlannerPremium",
      configured: {
        powerAutomateUrl: !!POWER_AUTOMATE_URL,
        webhookSecret: !!GITLAB_WEBHOOK_SECRET,
        projectId: PROJECT_ID,
        bucketMapSize: Object.keys(BUCKET_MAP_GUIDS).length,
      },
      buckets: BUCKET_MAP_GUIDS,
    };

    return { status: 200, jsonBody: result };
  },
});