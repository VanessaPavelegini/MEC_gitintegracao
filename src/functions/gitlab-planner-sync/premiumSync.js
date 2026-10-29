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

  // O Dataverse grava o DateTime com precisão de SEGUNDO, mas o GitLab manda
  // milissegundos ("2026-10-19T18:08:47.258Z"). Comparar no milissegundo
  // faria toda issue parecer alterada — logo, compara em segundos.
  const issueUpdated = Math.floor(new Date(issue?.updated_at || 0).getTime() / 1000);
  const lastSynced = Math.floor(new Date(lastSync).getTime() / 1000);
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
 * Impressão digital do texto da descrição.
 *
 * O Planner Premium não guarda a descrição como foi enviada: ele a trata
 * como HTML e a devolve reescrita (tags em minúsculas, `>` virando `&gt;`,
 * `"` virando `&quot;`, espaço duplo virando `&#160;` e o comentário HTML
 * inicial (`<!-- ... -->`) descartado). Comparar o texto exato daria falso
 * negativo em quase toda issue com descrição. A impressão digital neutraliza
 * essas transformações e olha só o começo do texto (o fim pode ser
 * truncado pelo próprio Planner).
 */
function descriptionFingerprint(value) {
  return String(value ?? "")
    // as entidades primeiro: o Planner devolve "&lt;ul&gt;" onde o texto tinha
    // "<ul>", e o texto "< Acessar o Sistec >" volta escapado — só depois de
    // desescapar dá para tratar tag e texto igual
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&amp;/g, "&")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

/**
 * A task do plano já materializou com o conteúdo esperado?
 *
 * Só assunto, descrição e progresso são comparados: o Planner Premium
 * reAgenda as datas (start/finish) pelo calendário de trabalho do projeto —
 * o fim gravado é o último dia útil ANTES da data pedida, e o início é o
 * primeiro dia útil em cima da data pedida. Comparar as datas daria falso
 * negativo.
 */
function taskMatches(row, expected) {
  if (!row || !expected) return false;
  if (row.msdyn_subject !== expected.msdyn_subject) return false;
  if (descriptionFingerprint(row.msdyn_description) !== descriptionFingerprint(expected.msdyn_description)) return false;
  if (Number(row.msdyn_progress ?? 0) !== Number(expected.msdyn_progress ?? 0)) return false;
  return true;
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
  materializeTimeoutMs,
  materializeDelayMs,
}) {
  // ─── Operation sets ─────────────────────────────────────────────────────────
  //
  // O Dataverse aplica o operation set de forma ASSÍNCRONA: a task só vira
  // consultável alguns segundos depois do execute. E apagar o registro do set
  // (msdyn_operationsets) antes disso CANCELA a criação pendente — a task
  // nunca chega a existir (foi exatamente o que aconteceu na primeira
  // execução real: 588 tasks "criadas" que não existiam no plano).
  //
  // Ordem correta: execute → espera as tasks materializarem → só então apaga
  // o registro do set (é o DELETE que libera a cota de 10 sets vivos).
  // Medido em 26/10/2026: o lote materializa inteiro de uma vez —
  // 20 tasks em ~18 s e 100 tasks em ~30 s depois do execute. A janela
  // padrão de 120 s cobre o lote com folga mesmo com a org carregada.
  const MATERIALIZE_TIMEOUT_MS = materializeTimeoutMs ?? 120000;
  const MATERIALIZE_PROBE_DELAY_MS = 2000;
  const MATERIALIZE_DELAY_MS = materializeDelayMs ?? 2000;
  const MATERIALIZE_CONCURRENCY = 8;

  async function runSet(setItems, setMode) {
    const description = `Sync GitLab → Planner Premium (${setMode}) — ${setItems.length} task(s) — plano ${planId}`;
    const setId = await premium.createOperationSet({
      projectId: planId,
      description,
      token,
      baseUrl: orgUrl,
      fetchImpl,
    });

    try {
      const entities = setItems.map((item) => item.entity);
      if (setMode === "create") {
        await premium.queueCreateTasks({ operationSetId: setId, entities, token, baseUrl: orgUrl, fetchImpl });
      } else {
        await premium.queueUpdateTasks({ operationSetId: setId, entities, token, baseUrl: orgUrl, fetchImpl });
      }
      await premium.executeOperationSet({ operationSetId: setId, token, baseUrl: orgUrl, fetchImpl });
    } catch (e) {
      // Set com pendências: o abandon cancela o que ficou na fila, mas o
      // registro NÃO é apagado — pode haver criação em background, e a task
      // órfã é adotada na próxima rodada (por assunto).
      try {
        await premium.abandonOperationSet({ operationSetId: setId, token, baseUrl: orgUrl, fetchImpl });
      } catch { /* best effort */ }
      throw e;
    }

    return setId;
  }

  /**
   * Espera as tasks do set aparecerem no plano com o conteúdo esperado.
   * Devolve o conjunto de ids que NÃO materializaram no prazo.
   *
   * O Dataverse materializa o lote INTEIRO de uma vez (medido: 20 tasks em
   * ~18 s, 100 tasks em ~30 s depois do execute). Por isso a espera é em duas
   * fases: primeiro uma sonda barata (1 GET por vez) até o lote começar a
   * aparecer, e só então a confirmação de todas as tasks — consultar as 100
   * tasks a cada 2 s custaria ~100 requests por tentativa e atrasaria tudo.
   */
  async function waitForMaterialization(setItems) {
    const expected = new Map();
    for (const item of setItems) {
      const id = item.entity.msdyn_projecttaskid;
      if (id) expected.set(id, item.entity);
    }
    const pending = new Set(expected.keys());
    if (pending.size === 0) return pending;

    const busca = async (id) =>
      premium.getTaskById({
        taskId: id,
        token,
        baseUrl: orgUrl,
        fetchImpl,
        select: "msdyn_subject,msdyn_progress,msdyn_description",
      }).catch(() => null);

    const deadline = Date.now() + MATERIALIZE_TIMEOUT_MS;

    // Fase 1 — sonda: espera o lote começar a aparecer.
    while (pending.size > 0 && Date.now() < deadline) {
      const row = await busca([...pending][0]);
      if (row) break;
      await new Promise((resolve) => setTimeout(resolve, MATERIALIZE_PROBE_DELAY_MS));
    }

    // Fase 2 — confirmação: confere todas as tasks a cada rodada.
    while (pending.size > 0 && Date.now() < deadline) {
      const ids = [...pending];
      for (const lote of chunk(ids, MATERIALIZE_CONCURRENCY)) {
        const rows = await Promise.all(lote.map((id) => busca(id)));
        lote.forEach((id, i) => {
          if (taskMatches(rows[i], expected.get(id))) pending.delete(id);
        });
      }
      if (pending.size > 0) {
        await new Promise((resolve) => setTimeout(resolve, MATERIALIZE_DELAY_MS));
      }
    }

    return pending;
  }

  async function discardSet(setId) {
    try {
      await premium.discardOperationSet({ operationSetId: setId, token, baseUrl: orgUrl, fetchImpl });
    } catch { /* best effort */ }
  }

  // Na criação, primeiro pergunta o que JÁ existe no plano. Uma task órfã
  // (criada numa rodada que morreu antes de gravar o mapping) é adotada em
  // vez de virada duplicata — e seu conteúdo é atualizado com o da issue.
  let toCreate = [];
  const adopted = [];
  if (mode === "create") {
    const subjects = items.map((item) => item.entity.msdyn_subject);
    const alreadyThere = await premium.findTaskIdsBySubjects({
      projectId: planId, subjects, token, baseUrl: orgUrl, fetchImpl, onlyExisting: true,
    });
    toCreate = [];
    for (const item of items) {
      const found = alreadyThere?.[item.entity.msdyn_subject];
      if (found) {
        adopted.push({
          issue: item.issue,
          entity: require("./premiumDataverse").buildUpdateEntity({
            issue: item.issue,
            projectId: planId,
            bucketId,
            taskId: found,
          }),
          existingTaskId: found,
        });
      } else {
        toCreate.push(item);
      }
    }
  }

  let taskIds = {};
  // Issues cujo id de task não ficou confirmado no plano (não materializou):
  // o erro já foi registrado no bloco do set — aqui só não repetimos.
  const semTask = new Set();

  // 1) Modo "update" (rodada de atualização): o lote inteiro vai num set.
  if (mode !== "create") {
    const setId = await runSet(items, "update");
    const faltando = await waitForMaterialization(items);
    await discardSet(setId);
    for (const item of items) {
      const id = item.entity.msdyn_projecttaskid;
      if (!faltando.has(id)) {
        taskIds[item.entity.msdyn_subject] = id;
        result.updated += 1;
      } else {
        semTask.add(item.issue.iid);
        result.errors.push({
          iid: item.issue.iid,
          message: "a task não refletiu o conteúdo esperado no Planner Premium (atualização não confirmada)",
        });
      }
    }
  }

  // 2) Criações. O id da task criada é o GUID enviado no PssCreateV2 (o
  // Dataverse respeita o id do cliente nesse action).
  if (toCreate.length > 0) {
    const setId = await runSet(toCreate, "create");
    const faltando = await waitForMaterialization(toCreate);
    await discardSet(setId);
    for (const item of toCreate) {
      const id = item.entity.msdyn_projecttaskid;
      if (!faltando.has(id)) {
        taskIds[item.entity.msdyn_subject] = id;
        result.created += 1;
      } else {
        semTask.add(item.issue.iid);
        result.errors.push({
          iid: item.issue.iid,
          message: "task criada mas não apareceu no Planner Premium — mapping não gravado (pode recriar na próxima rodada)",
        });
      }
    }
  }

  // 3) Adotas (task órfã): o conteúdo é atualizado com o da issue.
  if (adopted.length > 0) {
    const setId = await runSet(adopted, "update");
    const faltando = await waitForMaterialization(adopted);
    await discardSet(setId);
    for (const item of adopted) {
      if (!faltando.has(item.existingTaskId)) {
        taskIds[item.entity.msdyn_subject] = item.existingTaskId;
        result.created += 1;
      } else {
        semTask.add(item.issue.iid);
        result.errors.push({
          iid: item.issue.iid,
          message: "task órfã não refletiu o conteúdo esperado no Planner Premium — mapping não gravado",
        });
      }
    }
  }

  const toSave = mode === "create" ? [...toCreate, ...adopted] : items;
  for (const { issue, entity, existingTaskId } of toSave) {
    // Task que não refletiu o conteúdo esperado: o erro já foi registrado no
    // bloco do set. O mapping NÃO pode ser gravado aqui — o pmo_gitlab_updatedat
    // é o que o diff da próxima rodada lê para saber se a issue mudou. Se
    // avançasse, a issue voltaria como "unchanged" e o update perdido nunca
    // mais seria tentado: a falha viraria permanente e silenciosa.
    if (semTask.has(issue.iid)) continue;
    const taskId = existingTaskId || taskIds[entity.msdyn_subject];
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
  updatedAfter,
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
  materializeTimeoutMs,
  materializeDelayMs,
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
    // Janela incremental: só na fase aberta. A fase fechada varre TODAS as
    // issues fechadas — é ela que leva a task a 100% mesmo quando o
    // fechamento aconteceu fora da janela.
    updatedAfter: isClosedPhase ? undefined : updatedAfter,
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

  // A partir daqui os contadores são recontados pelo que foi CONFIRMADO no
  // plano (a task materializou), não pelo que foi enfileirado no set.
  result.created = 0;
  result.updated = 0;

  for (const batch of chunk(creates, batchSize)) {
    await applyBatch({
      items: batch,
      mode: "create",
      premium, mapping, token, prdToken, orgUrl, prdBaseUrl, fetchImpl,
      planId, bucketId, hasUpdatedAtColumn, result,
      materializeTimeoutMs, materializeDelayMs,
    });
  }

  for (const batch of chunk(updates, batchSize)) {
    await applyBatch({
      items: batch,
      mode: "update",
      premium, mapping, token, prdToken, orgUrl, prdBaseUrl, fetchImpl,
      planId, bucketId, hasUpdatedAtColumn, result,
      materializeTimeoutMs, materializeDelayMs,
    });
  }

  result.durationMs = Date.now() - startedAt;
  return result;
}

module.exports = {
  DEFAULT_SKIP_LABELS,
  descriptionFingerprint,
  labelToString,
  isSkippedByLabels,
  toDateOnly,
  computeFinishDate,
  decideAction,
  encodeCursor,
  decodeCursor,
  syncPage,
};
