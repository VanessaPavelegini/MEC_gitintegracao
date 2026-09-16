"use strict";
// Azure Function: syncGitLabPlanner
//
// Recebe webhooks do GitLab quando issues são criadas/alteradas e sincroniza
// com o Microsoft Planner.
//
// Endpoints:
//   POST /api/gitlab-webhook     - Recebe eventos do GitLab
//   GET  /api/gitlab-planner-sync - Sincronização manual (query: iid=123)
//
// Configurações necessárias em local.settings.json:
//   - GITLAB_WEBHOOK_SECRET: Token para validar webhooks
//   - PLANNER_PLAN_ID: ID do plano Planner destino
//   - DATAVERSE_URL + AZURE_TENANT_ID/CLIENT_ID/CLIENT_SECRET: persistência na tabela pmo_mapeamentoplanner
//   - Ver AZURE_SETTINGS.md para a lista completa

const { app } = require("@azure/functions");
const { getGraphClient } = require("../../shared/graphClient");
const { getMapping, saveMapping, deleteMapping, getOrCreateBucket } = require("./tableStorage");
const {
  getIssue,
  listIssues,
  getBoardLists,
  extractStatusLabel,
  mapLabelToBucket,
  GITLAB_PROJECT_ID,
} = require("./gitlabService");

// ─── Configurações ─────────────────────────────────────────────────────────────

const PLANNER_PLAN_ID = process.env.PLANNER_PLAN_ID || "V6eQb5zdBkWHqIzlDh68o2UACro8";
const GITLAB_WEBHOOK_SECRET = process.env.GITLAB_WEBHOOK_SECRET;
const FUNCTION_KEY = process.env.FUNCTION_KEY;
const BUCKET_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutos

// Cache de buckets do plano
let _bucketsCache = null;
let _bucketsCacheTime = 0;

// ─── Validação do Webhook ──────────────────────────────────────────────────────

/**
 * Valida o secret token do GitLab webhook
 * @param {HttpRequest} request
 * @returns {boolean}
 */
function validateGitLabToken(request) {
  // Se não há secret configurado, permite em desenvolvimento
  if (!GITLAB_WEBHOOK_SECRET) {
    console.warn("[syncGitLabPlanner] GITLAB_WEBHOOK_SECRET não configurado - pulando validação");
    return true;
  }

  const token = request.headers.get("x-gitlab-token");

  if (!token) {
    console.error("[syncGitLabPlanner] Token não encontrado no header X-Gitlab-Token");
    return false;
  }

  if (token !== GITLAB_WEBHOOK_SECRET) {
    console.error("[syncGitLabPlanner] Token inválido");
    return false;
  }

  return true;
}

// ─── Operações do Planner ──────────────────────────────────────────────────────

/**
 * Obtém buckets do plano (com cache)
 * @param {string} planId
 * @returns {Promise<Array>}
 */
async function getPlanBuckets(planId) {
  const now = Date.now();

  if (_bucketsCache && _bucketsCache.planId === planId && (now - _bucketsCacheTime) < BUCKET_CACHE_TTL_MS) {
    return _bucketsCache.buckets;
  }

  const client = getGraphClient();
  const resp = await client.api(`/planner/plans/${planId}/buckets`).get();
  const buckets = resp.value || [];

  _bucketsCache = { planId, buckets };
  _bucketsCacheTime = now;

  return buckets;
}

/**
 * Obtém bucket existente ou cria novo
 * @param {string} planId
 * @param {string} bucketName
 * @returns {Promise<object>}
 */
async function ensureBucketExists(planId, bucketName) {
  // Primeiro verifica no cache
  const buckets = await getPlanBuckets(planId);
  const existing = buckets.find(
    b => b.name && b.name.toLowerCase() === bucketName.toLowerCase()
  );

  if (existing) {
    return existing;
  }

  // Não existe, cria
  const client = getGraphClient();
  const newBucket = await client.api("/planner/buckets").post({
    name: bucketName,
    planId: planId,
    orderHint: " !",
  });

  // Atualiza cache
  if (_bucketsCache && _bucketsCache.planId === planId) {
    _bucketsCache.buckets.push(newBucket);
  }

  console.log(`[syncGitLabPlanner] Bucket criado: ${bucketName} (${newBucket.id})`);
  return newBucket;
}

/**
 * Obtém ou cria bucket baseado na label da issue
 * @param {string} planId
 * @param {string[]} labels
 * @returns {Promise<object>}
 */
async function getBucketByLabels(planId, labels) {
  const statusLabel = extractStatusLabel(labels);
  const bucketName = mapLabelToBucket(statusLabel);
  return ensureBucketExists(planId, bucketName);
}

/**
 * Cria nova task no Planner
 * @param {object} issue - Dados da issue do GitLab
 * @param {string} bucketId - ID do bucket destino
 * @returns {Promise<object>}
 */
async function createPlannerTask(issue, bucketId) {
  const client = getGraphClient();

  const taskBody = {
    planId: PLANNER_PLAN_ID,
    bucketId: bucketId,
    title: `[#${issue.iid}] ${issue.title}`.substring(0, 500),
  };

  // Due date
  if (issue.due_date) {
    taskBody.dueDateTime = `${issue.due_date}T00:00:00Z`;
  }

  // Percentual - 0% para issues abertas
  taskBody.percentComplete = issue.state === "closed" ? 100 : 0;

  const created = await client.api("/planner/tasks").post(taskBody);
  console.log(`[syncGitLabPlanner] Task criada: ${created.id}`);

  // Adiciona descrição e detalhes
  if (created.id) {
    await updateTaskDetails(created.id, issue, created["@odata.etag"]);
  }

  return created;
}

/**
 * Atualiza detalhes da task (descrição e referências)
 * @param {string} taskId
 * @param {object} issue
 * @param {string} etag
 */
async function updateTaskDetails(taskId, issue, etag) {
  const client = getGraphClient();

  const description = buildDescription(issue);

  try {
    await client
      .api(`/planner/tasks/${taskId}/details`)
      .header("If-Match", etag || "*")
      .patch({ description });
  } catch (err) {
    console.warn(`[syncGitLabPlanner] Não foi possível atualizar detalhes: ${err.message}`);
  }
}

/**
 * Atualiza task existente no Planner
 * @param {string} taskId
 * @param {object} issue - Dados atualizados da issue
 * @param {string} newBucketId - ID do novo bucket (se mudou)
 * @param {string} currentEtag - ETAG atual da task
 * @returns {Promise<object>}
 */
async function updatePlannerTask(taskId, issue, newBucketId, currentEtag) {
  const client = getGraphClient();

  const patchBody = {
    title: `[#${issue.iid}] ${issue.title}`.substring(0, 500),
    percentComplete: issue.state === "closed" ? 100 : 0,
  };

  // Se mudou de bucket
  if (newBucketId) {
    patchBody.bucketId = newBucketId;
  }

  // Due date
  if (issue.due_date) {
    patchBody.dueDateTime = `${issue.due_date}T00:00:00Z`;
  } else {
    patchBody.dueDateTime = null;
  }

  const updated = await client
    .api(`/planner/tasks/${taskId}`)
    .header("If-Match", currentEtag || "*")
    .patch(patchBody);

  console.log(`[syncGitLabPlanner] Task atualizada: ${taskId}`);

  // Atualiza descrição
  await updateTaskDetails(taskId, issue, updated["@odata.etag"]);

  return updated;
}

/**
 * Monta descrição da task com info do GitLab
 * @param {object} issue
 * @returns {string}
 */
function buildDescription(issue) {
  const lines = [
    `**GitLab Issue:** [#${issue.iid}](${issue.web_url || ""})`,
    `**Estado:** ${issue.state === "closed" ? "✅ Encerrada" : "🔄 Aberta"}`,
    `**Labels:** ${(issue.labels || []).join(", ") || "Nenhuma"}`,
    ``,
    `---`,
    ``,
  ];

  if (issue.description) {
    lines.push("## Descrição");
    lines.push(issue.description);
    lines.push("");
  }

  if (issue.assignees && issue.assignees.length > 0) {
    const assignees = issue.assignees.map(a => `@${a.username}`).join(", ");
    lines.push(`**Responsáveis:** ${assignees}`);
    lines.push("");
  }

  if (issue.due_date) {
    lines.push(`**Data de Vencimento:** ${issue.due_date}`);
    lines.push("");
  }

  lines.push("---");
  lines.push(`*Sincronizado do GitLab em ${new Date().toISOString()}*`);

  return lines.join("\n");
}

// ─── Sincronização ────────────────────────────────────────────────────────────

/**
 * Sincroniza uma issue do GitLab com o Planner
 * @param {object} issue - Dados da issue
 * @param {object} context - Contexto do logging
 * @returns {Promise<object>}
 */
async function syncIssue(issue, context) {
  const gitlabIid = issue.iid;

  if (!gitlabIid) {
    throw new Error("Issue sem IID");
  }

  context.log(`[syncGitLabPlanner] Sincronizando issue #${gitlabIid}: ${issue.title}`);

  // 1. Verifica se a issue está aberta
  if (issue.state !== "opened" && issue.state !== "reopened") {
    context.log(`[syncGitLabPlanner] Issue #${gitlabIid} está ${issue.state} - verificando mapping...`);

    const existingMapping = await getMapping(gitlabIid);
    if (existingMapping && existingMapping.plannerTaskId) {
      // Optionally: marcar task como 100% concluída
      context.log(`[syncGitLabPlanner] Issue #${gitlabIid} fechada - mapping existe`);
      // O mapping permanece para histórico
    }

    return {
      action: "closed",
      gitlabIid,
      message: `Issue #${gitlabIid} está ${issue.state}`,
    };
  }

  // 2. Obtém bucket baseado nas labels
  const bucket = await getBucketByLabels(PLANNER_PLAN_ID, issue.labels || []);
  context.log(`[syncGitLabPlanner] Bucket destino: ${bucket.name} (${bucket.id})`);

  // 3. Verifica se já existe mapping
  const existingMapping = await getMapping(gitlabIid);

  let result;

  if (existingMapping && existingMapping.plannerTaskId) {
    // ── ATUALIZAR task existente ─────────────────────────────────────────────
    context.log(`[syncGitLabPlanner] Atualizando task existente: ${existingMapping.plannerTaskId}`);

    const client = getGraphClient();

    // Busca task atual para obter etag
    const currentTask = await client.api(`/planner/tasks/${existingMapping.plannerTaskId}`).get();
    const etag = currentTask["@odata.etag"];

    // Verifica se bucket mudou
    const newBucketId = bucket.id !== currentTask.bucketId ? bucket.id : null;

    result = await updatePlannerTask(
      existingMapping.plannerTaskId,
      issue,
      newBucketId,
      etag
    );

    // Atualiza mapping
    await saveMapping({
      gitlabIid,
      plannerTaskId: existingMapping.plannerTaskId,
      plannerBucketId: bucket.id,
      issueData: issue,
    });

  } else {
    // ── CRIAR task nova ──────────────────────────────────────────────────────
    context.log(`[syncGitLabPlanner] Criando nova task no Planner`);

    result = await createPlannerTask(issue, bucket.id);

    // Salva mapping
    await saveMapping({
      gitlabIid,
      plannerTaskId: result.id,
      plannerBucketId: bucket.id,
      issueData: issue,
    });

    context.log(`[syncGitLabPlanner] Task criada: ${result.id}`);
  }

  return {
    action: existingMapping ? "updated" : "created",
    gitlabIid,
    plannerTaskId: result.id,
    bucketId: bucket.id,
    bucketName: bucket.name,
    title: issue.title,
  };
}

// ─── Handlers HTTP ─────────────────────────────────────────────────────────────

/**
 * Handler para webhook do GitLab
 */
async function handleWebhook(request, context) {
  context.log("[syncGitLabPlanner] Webhook recebido");

  // 1. Valida token
  if (!validateGitLabToken(request)) {
    return {
      status: 401,
      jsonBody: { error: "Token inválido ou ausente" },
    };
  }

  // 2. Parse do body
  let event;
  try {
    event = await request.json();
  } catch (err) {
    context.error("[syncGitLabPlanner] Erro ao parsear JSON:", err);
    return {
      status: 400,
      jsonBody: { error: "Body inválido (JSON esperado)" },
    };
  }

  // 3. Identifica tipo de evento
  const eventType = request.headers.get("x-gitlab-event") || event.object_kind || "unknown";
  context.log(`[syncGitLabPlanner] Event type: ${eventType}`);

  // 4. Processa apenas eventos de issues
  if (eventType !== "Issue Hook" && event.object_kind !== "issue") {
    return {
      status: 200,
      jsonBody: { message: `Evento ${eventType} ignorado` },
    };
  }

  // 5. Extrai dados da issue
  const issue = event.object_attributes || event;

  if (!issue.iid) {
    return {
      status: 400,
      jsonBody: { error: "Issue sem IID" },
    };
  }

  // 6. Executa sincronização
  try {
    const result = await syncIssue(issue, context);
    return {
      status: 200,
      jsonBody: {
        success: true,
        ...result,
        message: `Issue #${issue.iid} sincronizada com sucesso`,
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    context.error("[syncGitLabPlanner] Erro ao sincronizar:", msg);

    return {
      status: 500,
      jsonBody: {
        error: `Erro ao sincronizar issue #${issue.iid}: ${msg}`,
      },
    };
  }
}

/**
 * Handler para sincronização manual
 */
async function handleSyncRequest(request, context) {
  const iid = request.query.get("iid");

  if (!iid) {
    return {
      status: 400,
      jsonBody: { error: "Parâmetro 'iid' é obrigatório" },
    };
  }

  context.log(`[syncGitLabPlanner] Sincronização manual para issue #${iid}`);

  try {
    // Busca issue do GitLab
    const issue = await getIssue(iid, GITLAB_PROJECT_ID);
    const result = await syncIssue(issue, context);

    return {
      status: 200,
      jsonBody: {
        success: true,
        ...result,
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    context.error("[syncGitLabPlanner] Erro ao sincronizar:", msg);

    // Erro 404 = issue não encontrada
    if (err.response?.status === 404) {
      return {
        status: 404,
        jsonBody: { error: `Issue #${iid} não encontrada no GitLab` },
      };
    }

    return {
      status: 500,
      jsonBody: {
        error: `Erro ao sincronizar issue #${iid}: ${msg}`,
      },
    };
  }
}

/**
 * Handler para sincronização em massa (todas as issues abertas do projeto)
 * GET /api/gitlab-planner-sync?bulk=true
 */
async function handleBulkSync(request, context) {
  context.log("[syncGitLabPlanner] Iniciando sincronização em massa");

  const results = {
    total: 0,
    created: 0,
    updated: 0,
    errors: 0,
    details: [],
  };

  try {
    // Parâmetros opcionais
    const state = request.query.get("state") || "opened";
    const perPage = parseInt(request.query.get("per_page")) || 100;
    let page = 1;
    let hasMore = true;

    while (hasMore) {
      context.log(`[syncGitLabPlanner] Buscando página ${page}...`);

      const issues = await listIssues({ state });
      results.total = issues.length;

      for (const issue of issues) {
        try {
          const result = await syncIssue(issue, context);

          if (result.action === "created") results.created++;
          else if (result.action === "updated") results.updated++;

          results.details.push({
            iid: issue.iid,
            title: issue.title,
            action: result.action,
            plannerTaskId: result.plannerTaskId,
            bucket: result.bucketName,
          });
        } catch (err) {
          results.errors++;
          const msg = err instanceof Error ? err.message : String(err);
          results.details.push({
            iid: issue.iid,
            title: issue.title,
            error: msg,
          });
          context.error(`[syncGitLabPlanner] Erro na issue #${issue.iid}:`, msg);
        }
      }

      // GitLab retorna no máximo 100 por página
      // Para buscar mais, precisamos usar paginação (X-Next-Page header)
      if (issues.length < perPage) {
        hasMore = false;
      } else {
        page++;
        if (page > 10) {
          // Limite de segurança: 1000 issues por execução
          context.warn("[syncGitLabPlanner] Limite de 10 páginas atingido");
          hasMore = false;
        }
      }
    }

    context.log(`[syncGitLabPlanner] Sincronização concluída: ${results.created} criadas, ${results.updated} atualizadas, ${results.errors} erros`);

    return {
      status: 200,
      jsonBody: {
        success: true,
        message: `Sincronização em massa concluída`,
        summary: {
          total: results.total,
          created: results.created,
          updated: results.updated,
          errors: results.errors,
        },
        details: results.details.slice(0, 50), // Retorna só os primeiros 50 detalhes
        detailsCount: results.details.length,
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    context.error("[syncGitLabPlanner] Erro na sincronização em massa:", msg);

    return {
      status: 500,
      jsonBody: {
        error: `Erro na sincronização em massa: ${msg}`,
        partialResults: results,
      },
    };
  }
}

// ─── Azure Function Definition ────────────────────────────────────────────────

app.http("syncGitLabPlanner", {
  methods: ["POST", "GET"],
  authLevel: "anonymous",
  route: "gitlab-planner-sync",
  handler: async (request, context) => {
    try {
      if (request.method === "POST") {
        return handleWebhook(request, context);
      }

      // GET: valida x-functions-key (para webpart/SPFx)
      // Em dev (sem FUNCTION_KEY configurado), permite sem chave
      if (FUNCTION_KEY) {
        const provided = request.headers.get("x-functions-key");
        if (provided !== FUNCTION_KEY) {
          return {
            status: 401,
            jsonBody: { error: "Function key inválida ou ausente" },
          };
        }
      }

      const isBulk = request.query.get("bulk") === "true";
      if (isBulk) {
        return handleBulkSync(request, context);
      }
      return handleSyncRequest(request, context);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      context.error("[syncGitLabPlanner] Erro não tratado:", msg);
      return {
        status: 500,
        jsonBody: { error: `Erro interno: ${msg}` },
      };
    }
  },
});

module.exports = { syncIssue };
