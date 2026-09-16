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
const { lookupUsersByUsernames } = require("../../shared/azureAdUsers");
const { getMapping, saveMapping, deleteMapping, getOrCreateBucket, listMappings } = require("./tableStorage");
const {
  getIssue,
  listIssues,
  listIssueNotes,
  extractHumanComments,
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

// ─── Resolução de Assignees ───────────────────────────────────────────────────

/**
 * Resolve os assignees do GitLab para o formato `assignments` do Planner.
 * - Lookup no Azure AD via UPN (username + @mec.gov.br)
 * - Falha de lookup é silenciosa (warning), não bloqueia sync
 * - Retorna `assignments` object pronto pro Graph, ou `null` se nenhum assignee foi resolvido
 * @param {object} issue - Issue do GitLab com `assignees: [{ username, ... }, ...]`
 * @returns {Promise<object|null>} - { "<azureUserId>": { "@odata.type": "...", orderHint: " !" } }
 */
async function resolveAssignments(issue) {
  // DESABILITADO: lookup no Azure AD está pendurado sem permissão User.Read.All.
  // Retornando null pra destravar o sync. Reativar após adicionar a permissão
  // no app registration + deploy.
  // TODO: reativar quando User.Read.All estiver configurado
  return null;

  /* eslint-disable no-unreachable */
  if (!issue.assignees || !Array.isArray(issue.assignees) || issue.assignees.length === 0) {
    return null;
  }

  const usernames = issue.assignees.map(a => a.username).filter(Boolean);
  if (usernames.length === 0) return null;

  const resolved = await lookupUsersByUsernames(usernames);

  const found = [];
  const notFound = [];
  const assignments = {};

  for (const username of usernames) {
    const user = resolved.get(username);
    if (user) {
      found.push(user.userPrincipalName);
      assignments[user.id] = {
        "@odata.type": "#microsoft.graph.plannerAssignment",
        orderHint: " !",
      };
    } else {
      notFound.push(username);
    }
  }

  if (notFound.length > 0) {
    console.warn(`[syncGitLabPlanner] Assignees não encontrados no Azure AD: ${notFound.join(", ")} (UPN tentado: ${notFound.map(u => `${u}@mec.gov.br`).join(", ")})`);
  }
  console.log(`[syncGitLabPlanner] Assignees resolvidos: ${found.length}/${usernames.length} (${found.join(", ") || "nenhum"})`);

  return Object.keys(assignments).length > 0 ? assignments : null;
}

/**
 * Cria nova task no Planner
 * @param {object} issue - Dados da issue do GitLab
 * @param {string} bucketId - ID do bucket destino
 * @param {object} context - Contexto da Function (logging)
 * @returns {Promise<object>}
 */
async function createPlannerTask(issue, bucketId, context) {
  const client = getGraphClient();
  const log = context ? context.log : console.log;
  const logErr = context ? context.error : console.error;

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

  // Assignees (lookup Azure AD via UPN)
  try {
    const assignments = await resolveAssignments(issue);
    if (assignments) {
      taskBody.assignments = assignments;
    }
  } catch (err) {
    logErr(`[syncGitLabPlanner] Falha ao resolver assignees da issue #${issue.iid}: ${err.message} — criando task sem assignee`);
  }

  log(`[syncGitLabPlanner] POST /planner/tasks payload: ${JSON.stringify(taskBody, null, 2)}`);

  let created;
  try {
    created = await client.api("/planner/tasks").post(taskBody);
  } catch (err) {
    // Log detalhado do erro do Graph pra debug
    const graphError = err && (err.body || err.statusCode || err.message);
    logErr(`[syncGitLabPlanner] POST /planner/tasks FALHOU (issue #${issue.iid}):`);
    logErr(`[syncGitLabPlanner]   statusCode: ${err.statusCode || "?"}`);
    logErr(`[syncGitLabPlanner]   code: ${err.code || "?"}`);
    logErr(`[syncGitLabPlanner]   body: ${typeof graphError === "string" ? graphError : JSON.stringify(graphError)}`);
    logErr(`[syncGitLabPlanner]   message: ${err.message}`);
    throw err;
  }

  log(`[syncGitLabPlanner] Task criada: ${created.id}`);

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
 * @param {object} context - Contexto da Function (logging)
 * @returns {Promise<object>}
 */
async function updatePlannerTask(taskId, issue, newBucketId, currentEtag, context) {
  const client = getGraphClient();
  const log = context ? context.log : console.log;
  const logErr = context ? context.error : console.error;

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

  // Assignees (sempre recalcula a partir da issue do GitLab)
  // - Só inclui assignments no payload se a issue tiver assignees E foram resolvidos
  // - Quando resolveAssignments retorna null (lookup desabilitado ou vazio),
  //   NÃO envia o campo pra preservar assignments existentes no Planner
  try {
    const assignments = await resolveAssignments(issue);
    if (assignments) {
      patchBody.assignments = assignments;
    }
    // Se assignments === null, não toca no campo — preserva o que tá na task
  } catch (err) {
    logErr(`[syncGitLabPlanner] Falha ao resolver assignees da issue #${issue.iid} no update: ${err.message} — mantendo assignments existentes`);
  }

  log(`[syncGitLabPlanner] PATCH /planner/tasks/${taskId} payload: ${JSON.stringify(patchBody, null, 2)}`);

  let updated;
  try {
    updated = await client
      .api(`/planner/tasks/${taskId}`)
      .header("If-Match", currentEtag || "*")
      .patch(patchBody);
  } catch (err) {
    const graphError = err && (err.body || err.statusCode || err.message);
    logErr(`[syncGitLabPlanner] PATCH /planner/tasks/${taskId} FALHOU (issue #${issue.iid}):`);
    logErr(`[syncGitLabPlanner]   statusCode: ${err.statusCode || "?"}`);
    logErr(`[syncGitLabPlanner]   code: ${err.code || "?"}`);
    logErr(`[syncGitLabPlanner]   body: ${typeof graphError === "string" ? graphError : JSON.stringify(graphError)}`);
    logErr(`[syncGitLabPlanner]   message: ${err.message}`);
    throw err;
  }

  log(`[syncGitLabPlanner] Task atualizada: ${taskId}`);

  // Atualiza descrição
  await updateTaskDetails(taskId, issue, updated["@odata.etag"]);

  return updated;
}

/**
 * Monta descrição da task com info do GitLab
 * @param {object} issue
 * @param {Array} [comments] - Lista de comments humanos (vindo de extractHumanComments)
 * @returns {string}
 */
function buildDescription(issue, comments) {
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

  // ── Seção de Comentários ───────────────────────────────────────────────────
  lines.push("---");
  lines.push("## Comentários do GitLab");
  lines.push("");

  if (comments && Array.isArray(comments) && comments.length > 0) {
    comments.forEach((c) => {
      lines.push(`**@${c.username}** · ${c.date}`);
      lines.push("");
      lines.push(c.body);
      lines.push("");
    });
  } else {
    lines.push("_Nenhum comentário ainda._");
    lines.push("");
  }

  lines.push("---");
  lines.push(`*Sincronizado do GitLab em ${new Date().toISOString()}*`);

  return lines.join("\n");
}

// ─── Comentários ──────────────────────────────────────────────────────────────

/**
 * Busca comments humanos no GitLab e atualiza a descrição da task no Planner
 * - Falha NÃO quebra o fluxo principal (try/catch com warning)
 * - Idempotente: sobrescreve a descrição inteira a cada chamada
 * @param {object} issue - Issue do GitLab (com iid)
 * @param {string} taskId - ID da task no Planner
 * @param {string} etag - ETag atual dos details (ou undefined para usar "*")
 * @param {object} context - Contexto de logging
 */
async function syncIssueComments(issue, taskId, etag, context) {
  try {
    context.log(`[syncGitLabPlanner] Buscando comentários da issue #${issue.iid}...`);

    const rawNotes = await listIssueNotes(issue.iid);
    const comments = extractHumanComments(rawNotes);

    context.log(`[syncGitLabPlanner] ${comments.length} comentário(s) humano(s) encontrado(s) na issue #${issue.iid}`);

    // Buscar etag atualizado dos details (necessário para PATCH)
    const client = getGraphClient();
    let currentDetailsEtag = etag;

    if (!currentDetailsEtag) {
      try {
        const currentDetails = await client
          .api(`/planner/tasks/${taskId}/details`)
          .get();
        currentDetailsEtag = currentDetails["@odata.etag"];
      } catch (e) {
        // Se não conseguir pegar etag, usa "*" (último recurso)
        currentDetailsEtag = "*";
      }
    }

    const description = buildDescription(issue, comments);

    await client
      .api(`/planner/tasks/${taskId}/details`)
      .header("If-Match", currentDetailsEtag || "*")
      .patch({ description });

    context.log(`[syncGitLabPlanner] Descrição da task ${taskId} atualizada com ${comments.length} comentário(s)`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    context.warn(`[syncGitLabPlanner] Falha ao sincronizar comentários da issue #${issue.iid}: ${msg} — continuando sem seção de comentários`);
  }
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
      etag,
      context
    );

    // Atualiza mapping
    await saveMapping({
      gitlabIid,
      plannerTaskId: existingMapping.plannerTaskId,
      plannerBucketId: bucket.id,
      issueData: issue,
    });

    // Sincroniza comentários (não-bloqueante: erro aqui não quebra o fluxo)
    const updatedEtag = result["@odata.etag"] || etag;
    await syncIssueComments(issue, existingMapping.plannerTaskId, updatedEtag, context);

  } else {
    // ── CRIAR task nova ──────────────────────────────────────────────────────
    context.log(`[syncGitLabPlanner] Criando nova task no Planner`);

    result = await createPlannerTask(issue, bucket.id, context);

    // Salva mapping
    await saveMapping({
      gitlabIid,
      plannerTaskId: result.id,
      plannerBucketId: bucket.id,
      issueData: issue,
    });

    context.log(`[syncGitLabPlanner] Task criada: ${result.id}`);

    // Sincroniza comentários (não-bloqueante: erro aqui não quebra o fluxo)
    await syncIssueComments(issue, result.id, result["@odata.etag"], context);
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

  // 4. Note Hook (comentário em issue) — re-busca issue e sincroniza
  if (eventType === "Note Hook" || event.object_kind === "note") {
    const noteableType = event.object_attributes?.noteable_type;
    const issueIid = event.issue?.iid || event.object_attributes?.noteable_iid;

    if (noteableType !== "Issue" || !issueIid) {
      context.log(`[syncGitLabPlanner] Note ignorado: noteable_type=${noteableType}, iid=${issueIid}`);
      return {
        status: 200,
        jsonBody: { message: `Note em ${noteableType || "desconhecido"} ignorado` },
      };
    }

    try {
      const fullIssue = await getIssue(issueIid, GITLAB_PROJECT_ID);
      context.log(`[syncGitLabPlanner] Note em issue #${issueIid} — re-sincronizando issue completa`);
      const result = await syncIssue(fullIssue, context);
      return {
        status: 200,
        jsonBody: {
          message: `Comentário em issue #${issueIid} sincronizado`,
          ...result,
        },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      context.error(`[syncGitLabPlanner] Erro ao processar Note Hook: ${msg}`);
      return {
        status: 500,
        jsonBody: { error: `Falha ao sincronizar comentário: ${msg}` },
      };
    }
  }

  // 5. Processa apenas eventos de issues
  if (eventType !== "Issue Hook" && event.object_kind !== "issue") {
    return {
      status: 200,
      jsonBody: { message: `Evento ${eventType} ignorado` },
    };
  }

  // 6. Extrai dados da issue
  const issue = event.object_attributes || event;

  if (!issue.iid) {
    return {
      status: 400,
      jsonBody: { error: "Issue sem IID" },
    };
  }

  // 7. Executa sincronização
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

/**
 * Handler para backfill de assignees em tasks já migradas.
 * Lista todos os mappings em pmo_mapeamentoplanner, busca a issue correspondente no GitLab,
 * resolve os assignees no Azure AD e faz PATCH na task do Planner.
 *
 * Idempotente — pode rodar várias vezes. Apenas o campo `assignments` é atualizado;
 * título, bucket, descrição etc. permanecem intactos.
 *
 * GET /api/gitlab-planner-sync?backfill=true
 *
 * Query params opcionais:
 *   - dryRun=true  → não faz PATCH, só simula e retorna o que seria feito
 *   - limit=N      → processa no máximo N mappings (útil pra teste)
 */
async function handleBackfillAssignees(request, context) {
  const dryRun = request.query.get("dryRun") === "true";
  const limitParam = request.query.get("limit");
  const limit = limitParam ? parseInt(limitParam, 10) : null;

  context.log(`[syncGitLabPlanner] Backfill de assignees iniciado (dryRun=${dryRun}, limit=${limit || "nenhum"})`);

  const results = {
    total: 0,
    updated: 0,
    skipped: 0,
    errors: 0,
    assigneesNotFound: 0,
    details: [],
  };

  try {
    // 1. Lista todos os mappings de pmo_mapeamentoplanner
    const mappings = await listMappings();
    results.total = mappings.length;

    // Filtra apenas os que têm plannerTaskId (descarta mappings de issues fechadas/excluídas)
    const mappingsToProcess = mappings
      .filter(m => m.pmo_plannertaskid)
      .filter(m => {
        if (limit && results.details.length + results.errors + results.skipped >= limit) return false;
        return true;
      });

    context.log(`[syncGitLabPlanner] ${mappingsToProcess.length} mapping(s) com plannerTaskId para processar`);

    // 2. Para cada mapping, busca issue no GitLab e atualiza assignee no Planner
    for (const mapping of mappingsToProcess) {
      const iid = mapping.pmo_gitlab_iid;
      const taskId = mapping.pmo_plannertaskid;

      try {
        // Busca issue completa (com assignees atualizados)
        const issue = await getIssue(iid, GITLAB_PROJECT_ID);

        const assigneesGitLab = (issue.assignees || []).map(a => a.username).filter(Boolean);

        if (assigneesGitLab.length === 0) {
          // Issue sem assignees no GitLab — pula (não vamos limpar assignments manualmente)
          results.skipped++;
          results.details.push({ iid, action: "skipped", reason: "Sem assignees no GitLab" });
          continue;
        }

        // Resolve assignees no Azure AD
        const assignments = await resolveAssignments(issue);

        if (!assignments) {
          results.assigneesNotFound++;
          results.details.push({
            iid,
            action: "skipped",
            reason: "Nenhum assignee resolvido no Azure AD",
            gitlabUsernames: assigneesGitlab,
          });
          continue;
        }

        if (dryRun) {
          results.updated++;
          results.details.push({
            iid,
            action: "would_update",
            plannerTaskId: taskId,
            gitlabUsernames: assigneesGitlab,
            assignmentsCount: Object.keys(assignments).length,
          });
          continue;
        }

        // PATCH apenas do campo assignments (preserva bucket/title/etc.)
        const client = getGraphClient();
        const currentTask = await client.api(`/planner/tasks/${taskId}`).get();
        const etag = currentTask["@odata.etag"];

        await client
          .api(`/planner/tasks/${taskId}`)
          .header("If-Match", etag || "*")
          .patch({ assignments });

        results.updated++;
        results.details.push({
          iid,
          action: "updated",
          plannerTaskId: taskId,
          gitlabUsernames: assigneesGitlab,
          assignmentsCount: Object.keys(assignments).length,
        });

        context.log(`[syncGitLabPlanner] Backfill issue #${iid} (task ${taskId}): ${Object.keys(assignments).length} assignee(s) aplicado(s)`);
      } catch (err) {
        results.errors++;
        const msg = err instanceof Error ? err.message : String(err);
        context.error(`[syncGitLabPlanner] Erro no backfill da issue #${iid}: ${msg}`);
        results.details.push({
          iid,
          action: "error",
          error: msg,
        });
      }
    }

    context.log(`[syncGitLabPlanner] Backfill concluído: ${results.updated} atualizadas, ${results.skipped} sem assignees, ${results.assigneesNotFound} sem match Azure AD, ${results.errors} erros`);

    return {
      status: 200,
      jsonBody: {
        success: true,
        message: `Backfill de assignees concluído${dryRun ? " (dry-run)" : ""}`,
        summary: {
          totalMappings: results.total,
          processed: mappingsToProcess.length,
          updated: results.updated,
          skippedNoAssignees: results.skipped,
          skippedNoAzureAdMatch: results.assigneesNotFound,
          errors: results.errors,
          dryRun,
        },
        details: results.details.slice(0, 50),
        detailsCount: results.details.length,
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    context.error("[syncGitLabPlanner] Erro no backfill:", msg);

    return {
      status: 500,
      jsonBody: {
        error: `Erro no backfill de assignees: ${msg}`,
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

      const isBackfill = request.query.get("backfill") === "true";
      if (isBackfill) {
        return handleBackfillAssignees(request, context);
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
