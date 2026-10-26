"use strict";

// Orquestração do sync GitLab → Planner Premium (plano "Homologação _NOVO
// SISTEC 2 - Cópia" na org Default).
//
// Este módulo tem duas camadas:
//   1. funções puras (decideAction, isSkippedByLabels, toDateOnly,
//      computeFinishDate) — testáveis sem rede;
//   2. o fluxo do sync (syncPage), que recebe as dependências por injeção
//      (fetcher do GitLab, cliente Premium, tableStorage) para poder ser
//      testado sem ambiente.
//
// O writing no Planner Premium acontece em operation sets (ver
// premiumDataverse.js); o mapping issue→task vive na tabela
// pmo_mapeamentoplanner do Aplicativos PRD.

const { normalizeLabel } = require("./gitlabService");

// ─── Labels que não geram task ────────────────────────────────────────────────
//
// Runding: o conjunto abaixo inclui "canceladas" (plural). No projeto GitLab
// 510 as labels de cancelamento são CANCELADAS (134 issues) e HU cancelada
// (32) — o SKIP_LABELS do handler antigo (syncGitLabPlannerPremium.js) só
// tinha a forma singular, então não pulava nada.

const DEFAULT_SKIP_LABELS = [
  "hu cancelada",
  "hu canceladas",
  "cancelada",
  "canceladas",
  "cancelado",
  "cancelados",
];

// ─── Helpers puros ────────────────────────────────────────────────────────────

/**
 * Extrai o texto de uma label, aceitando string ou objeto
 * ({ title } — formato do webhook do GitLab).
 */
function labelToString(label) {
  if (typeof label === "string") return label;
  if (label && typeof label === "object") return label.title || label.name || "";
  return "";
}

/**
 * True quando a issue tem alguma label de cancelamento.
 */
function isSkippedByLabels(labels, skipLabels = DEFAULT_SKIP_LABELS) {
  if (!Array.isArray(labels) || labels.length === 0) return false;
  const skipSet = new Set((skipLabels || []).map(normalizeLabel));
  return labels.some((label) => skipSet.has(normalizeLabel(labelToString(label))));
}

/**
 * "2026-10-08T17:30:55.485Z" → "2026-10-08" (campos DateOnly do Planner Premium).
 */
function toDateOnly(value) {
  if (!value) return null;
  const str = String(value);
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(str);
  if (match) return match[1];
  const parsed = new Date(str);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

/**
 * Data de fim: due_date do GitLab ou start + 7 dias.
 */
function computeFinishDate(startDate, dueDate) {
  const due = toDateOnly(dueDate);
  if (due) return due;
  const start = startDate || toDateOnly(new Date().toISOString());
  const base = new Date(`${start}T00:00:00Z`);
  base.setUTCDate(base.getUTCDate() + 7);
  return base.toISOString().slice(0, 10);
}

/**
 * Decide o que fazer com a issue frente ao mapping existente.
 *
 *   sem mapping (ou mapping sem task id) → create
 *   mapping sem pmo_gitlab_updatedat     → update (idempotente)
 *   issue.updated_at > último sync       → update
 *   caso contrário                        → unchanged
 */
/**
 * Decide o que fazer com a issue: criar task, atualizar ou não tocar.
 *
 * A referência de "última alteração vista" é o `updated_at` da issue gravado
 * no mapping (pmo_gitlab_updatedat). Se a coluna ainda não existir na tabela
 * (schema do PRD não foi alterado), o plano B é comparar com
 * pmo_dataultimasincronizacao — o instante do último sync.
 */
function decideAction(issue, mapping, { hasUpdatedAtColumn = true } = {}) {
  if (!mapping || !mapping.pmo_plannertaskid) return "create";

  const lastSync = hasUpdatedAtColumn
    ? mapping.pmo_gitlab_updatedat
    : (mapping.pmo_gitlab_updatedat || mapping.pmo_dataultimasincronizacao);
  if (!lastSync) return "update";

  const issueUpdated = new Date(issue?.updated_at || 0).getTime();
  const lastSynced = new Date(lastSync).getTime();
  if (Number.isNaN(issueUpdated) || Number.isNaN(lastSynced)) return "update";

  return issueUpdated > lastSynced ? "update" : "unchanged";
}

// ─── Cursor ───────────────────────────────────────────────────────────────────
//
// O cursor é opaco (base64url de { page, phase }) — o handler do Power Automate
// só precisa repassar o valor devolvido na chamada anterior.
//
// A fase distingue as duas passagens do sync:
//   - "opened": issues abertas (criam/atualizam tasks);
//   - "closed": issues fechadas — aqui NADA é criado, só as tasks que já
//     existem são completadas com 100% de progresso.

const PHASES = ["opened", "closed"];

function encodeCursor(page, phase = "opened") {
  return Buffer.from(JSON.stringify({ page: Number(page), phase }), "utf8").toString("base64url");
}

function decodeCursor(cursor) {
  if (cursor === undefined || cursor === null || cursor === "") return { page: 1, phase: "opened" };
  try {
    const parsed = JSON.parse(Buffer.from(String(cursor), "base64url").toString("utf8"));
    const page = Number(parsed.page);
    if (!Number.isInteger(page) || page < 1) throw new Error("page inválida");
    const phase = parsed.phase || "opened";
    if (!PHASES.includes(phase)) throw new Error("phase inválida");
    return { page, phase };
  } catch {
    throw new Error(`Cursor inválido: "${cursor}"`);
  }
}

// ─── Orquestração ─────────────────────────────────────────────────────────────

const BATCH_SIZE = 100;

// Cache da checagem da coluna pmo_gitlab_updatedat (por org).
let _hasUpdatedAtColumnCache = new Map();

function chunk(list, size) {
  const chunks = [];
  for (let i = 0; i < list.length; i += size) chunks.push(list.slice(i, i + size));
  return chunks;
}

/**
 * Executa um lote (criação ou atualização) num operation set e grava os
 * mappings correspondentes.
 */
async function applyBatch({
  items,
  mode,
  premium,
  mapping,
  token,
  prdToken,
  orgUrl,
  prdBaseUrl,
  fetchImpl,
  planId,
  bucketId,
  hasUpdatedAtColumn,
  result,
}) {
  const description = `Sync GitLab → Planner Premium (${mode}) — ${items.length} task(s) — plano ${planId}`;
  const setId = await premium.createOperationSet({
    projectId: planId,
    description,
    token,
    baseUrl: orgUrl,
    fetchImpl,
  });

  try {
    const entities = items.map((item) => item.entity);
    if (mode === "create") {
      await premium.queueCreateTasks({ operationSetId: setId, entities, token, baseUrl: orgUrl, fetchImpl });
    } else {
      await premium.queueUpdateTasks({ operationSetId: setId, entities, token, baseUrl: orgUrl, fetchImpl });
    }
    await premium.executeOperationSet({ operationSetId: setId, token, baseUrl: orgUrl, fetchImpl });
  } catch (e) {
    // Set com pendências: descarta pra não estourar a cota de 10 sets vivos.
    try {
      await premium.discardOperationSet({ operationSetId: setId, token, baseUrl: orgUrl, fetchImpl });
    } catch { /* best effort */ }
    throw e;
  }

  await premium.discardOperationSet({ operationSetId: setId, token, baseUrl: orgUrl, fetchImpl });

  // Descobre o id das tasks criadas (por assunto) — só faz sentido para criação.
  let taskIds = {};
  if (mode === "create") {
    const subjects = items.map((item) => item.entity.msdyn_subject);
    const pending = new Set(subjects);
    for (let attempt = 0; attempt < 3 && pending.size > 0; attempt++) {
      const found = await premium.findTaskIdsBySubjects({ projectId: planId, subjects: [...pending], token, baseUrl: orgUrl, fetchImpl });
      for (const [subject, id] of Object.entries(found || {})) {
        if (id) {
          taskIds[subject] = id;
          pending.delete(subject);
        }
      }
      if (pending.size > 0 && attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }

  for (const { issue, entity, existingTaskId } of items) {
    const taskId = mode === "update" ? existingTaskId : taskIds[entity.msdyn_subject];
    if (!taskId) {
      result.errors.push({
        iid: issue.iid,
        message: "task criada mas o id não foi localizado no Planner — mapping não gravado (pode recriar na próxima rodada)",
      });
      continue;
    }

    try {
      await mapping.saveMappingPremium({
        baseUrl: prdBaseUrl,
        token: prdToken,
        fetchImpl,
        planId,
        gitlabIid: issue.iid,
        plannerTaskId: taskId,
        plannerBucketId: bucketId,
        gitlabUpdatedAt: issue.updated_at,
        hasUpdatedAtColumn,
        issueData: issue,
      });
    } catch (e) {
      result.errors.push({ iid: issue.iid, message: e.message });
    }
  }
}

/**
 * Sincroniza UMA página de issues do GitLab no plano Premium.
 *
 * @param {object}   args
 * @param {string}   args.planId    GUID do msdyn_project (plano Premium)
 * @param {string}   args.bucketId  GUID do msdyn_projectbucket destino
 * @param {number}   args.page      página do GitLab (1-based)
 * @param {number}   args.pageSize  issues por página
 * @param {boolean}  args.dryRun    quando true, só devolve o diff
 * @param {object}   args.gitlab    { listIssuesPage }
 * @param {object}   args.mapping   premiumMapping
 * @param {object}   args.premium   premiumDataverse
 */
async function syncPage({
  planId,
  bucketId,
  page = 1,
  pageSize = 100,
  state = "opened",
  phase = "opened",
  includeClosed = false,
  labels,
  dryRun = false,
  skipLabels = DEFAULT_SKIP_LABELS,
  gitlab,
  mapping,
  premium,
  token,
  prdToken,
  orgUrl,
  prdBaseUrl,
  fetchImpl,
  batchSize = BATCH_SIZE,
}) {
  const startedAt = Date.now();

  const isClosedPhase = phase === "closed";

  const result = {
    ok: true,
    planId,
    page,
    phase,
    state: isClosedPhase ? "closed" : state,
    processed: 0,
    created: 0,
    updated: 0,
    unchanged: 0,
    skipped: 0,
    errors: [],
    nextCursor: null,
    durationMs: 0,
  };

  const { items, nextPage } = await gitlab.listIssuesPage({
    state: isClosedPhase ? "closed" : state,
    per_page: pageSize,
    page,
    order_by: "created_at",
    sort: "asc",
    labels,
  });

  result.processed = items.length;

  // Na fase "closed" o filtro de cancelamento NÃO se aplica: se a task já
  // existe, ela precisa ser completada (100%) mesmo que a issue tenha
  // recebido a label depois. O que decide ali é a existência do mapping.
  const eligible = [];
  for (const issue of items) {
    if (!isClosedPhase && isSkippedByLabels(issue.labels, skipLabels)) {
      result.skipped += 1;
      continue;
    }
    eligible.push(issue);
  }

  const mappings = await mapping.listMappingsForIids({
    baseUrl: prdBaseUrl,
    token: prdToken,
    fetchImpl,
    planId,
    iids: eligible.map((i) => Number(i.iid)),
  });
  const mappingByIid = new Map((mappings || []).map((m) => [Number(m.pmo_gitlab_iid), m]));

  // A coluna pmo_gitlab_updatedat pode não existir no schema do PRD — nesse
  // caso o diff usa pmo_dataultimasincronizacao (plano B).
  let hasUpdatedAtColumn = false;
  if (_hasUpdatedAtColumnCache.has(prdBaseUrl)) {
    hasUpdatedAtColumn = _hasUpdatedAtColumnCache.get(prdBaseUrl);
  } else {
    hasUpdatedAtColumn = await mapping.hasGitlabUpdatedAtColumn({
      baseUrl: prdBaseUrl,
      token: prdToken,
      fetchImpl,
    });
    _hasUpdatedAtColumnCache.set(prdBaseUrl, hasUpdatedAtColumn);
  }

  const creates = [];
  const updates = [];

  for (const issue of eligible) {
    const existing = mappingByIid.get(Number(issue.iid));
    const action = decideAction(issue, existing, { hasUpdatedAtColumn });

    if (action === "unchanged") {
      result.unchanged += 1;
      continue;
    }

    // Fase "closed": issue sem task não gera task (só completa o que existe).
    if (action === "create" && isClosedPhase) {
      result.skipped += 1;
      continue;
    }

    if (action === "update") {
      updates.push({
        issue,
        existingTaskId: existing.pmo_plannertaskid,
        entity: require("./premiumDataverse").buildUpdateEntity({
          issue,
          projectId: planId,
          bucketId,
          taskId: existing.pmo_plannertaskid,
        }),
      });
    } else {
      creates.push({
        issue,
        entity: require("./premiumDataverse").buildTaskEntity({ issue, projectId: planId, bucketId }),
      });
    }
  }

  result.created = creates.length;
  result.updated = updates.length;

  if (nextPage) {
    result.nextCursor = encodeCursor(nextPage, phase);
  } else if (!isClosedPhase && includeClosed) {
    // A fase "opened" acabou: a próxima chamada entra na fase "closed".
    result.nextCursor = encodeCursor(1, "closed");
  } else {
    result.nextCursor = null;
  }

  if (dryRun) {
    result.durationMs = Date.now() - startedAt;
    return result;
  }

  for (const batch of chunk(creates, batchSize)) {
    await applyBatch({
      items: batch,
      mode: "create",
      premium, mapping, token, prdToken, orgUrl, prdBaseUrl, fetchImpl,
      planId, bucketId, hasUpdatedAtColumn, result,
    });
  }

  for (const batch of chunk(updates, batchSize)) {
    await applyBatch({
      items: batch,
      mode: "update",
      premium, mapping, token, prdToken, orgUrl, prdBaseUrl, fetchImpl,
      planId, bucketId, hasUpdatedAtColumn, result,
    });
  }

  result.durationMs = Date.now() - startedAt;
  return result;
}

module.exports = {
  DEFAULT_SKIP_LABELS,
  labelToString,
  isSkippedByLabels,
  toDateOnly,
  computeFinishDate,
  decideAction,
  encodeCursor,
  decodeCursor,
  syncPage,
};
