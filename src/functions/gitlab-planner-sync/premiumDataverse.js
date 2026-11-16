"use strict";

// Cliente das actions Premium (Dataverse Project / Planner Premium) e
// construtor das tasks no formato `mscrm.crmbaseentity`.
//
// Por que fetch puro e não o cliente axios de tableStorage.js: aquele embrulha
// o body em { data: ... }, e o Dataverse responde "Invalid property 'data'"
// nas actions do Project, mascarando o erro real (ver smoke-premium-pss.js).
//
// Por que operation set: POST direto em /msdyn_projecttasks é bloqueado pelo
// Dataverse ("Não é possível executar diretamente a operação Create para
// msdyn_projecttask"). Toda escrita passa por:
//   msdyn_CreateOperationSetV1 → msdyn_PssCreateV2 / msdyn_PssUpdateV2 →
//   msdyn_ExecuteOperationSetV1
// e o set é descartado em seguida (cota de 10 sets por usuário).

// ─── Limites dos campos (extraídos do $metadata da org Default) ───────────────

const ENTITY_TYPE = "Microsoft.Dynamics.CRM.msdyn_projecttask";
const SUBJECT_MAX_LENGTH = 450;      // msdyn_subject
// msdyn_description (o "notes" da task no Planner Premium): o Dataverse
// Project recusa a task quando o campo passa de 100.000 caracteres
// ("Beyond max limit of 100000 characters field: notes") — o limite é
// exclusivo, então 99.999 já passa. Fica uma margem de 999 caracteres.
const DESCRIPTION_MAX_LENGTH = 99000;

// ─── Construção da task ───────────────────────────────────────────────────────

/**
 * Monta o assunto da task: "[#iid] título".
 * Não duplica o prefixo quando o título já vem prefixado.
 */
function buildSubject(issue) {
  const title = String(issue?.title || "").trim();
  const prefix = `[#${issue?.iid}]`;
  const subject = title.startsWith(prefix) ? title : `${prefix} ${title}`;
  return subject.substring(0, SUBJECT_MAX_LENGTH);
}

/**
 * Notas da task: a linha com TODOS os rótulos do GitLab + a descrição.
 *
 * Por que nas Notas: o Planner Premium tem 25 vagas fixas de rótulo por plano
 * (uma por cor) e o GitLab usa mais de cem rótulos. Os que existem no plano
 * também viram rótulo colorido (synchronizeTaskLabels); a lista nas Notas
 * garante que nenhum rótulo do GitLab se perde.
 */
function buildDescription(issue) {
  const names = [...new Set((issue?.labels || [])
    .map((label) => typeof label === "string" ? label : label?.title || label?.name || "")
    .map((name) => name.trim())
    .filter(Boolean))];
  const text = String(issue?.description || "");
  const full = names.length ? `Rótulos do GitLab: ${names.join(", ")}\n\n${text}` : text;
  return full.substring(0, DESCRIPTION_MAX_LENGTH);
}

/**
 * Constrói o payload de criação de uma task Premium.
 *
 * @param {object}  args
 * @param {object}  args.issue    Issue do GitLab
 * @param {string}  args.projectId GUID do msdyn_project (plano Premium)
 * @param {string}  args.bucketId GUID do msdyn_projectbucket
 * @returns {object} entidade no formato mscrm.crmbaseentity
 */
function buildTaskEntity({ issue, projectId, bucketId, taskId }) {
  const start = require("./premiumSync").toDateOnly(issue?.created_at);
  const finish = require("./premiumSync").computeFinishDate(start, issue?.due_date);
  const scheduledStart = start ? `${start}T09:00:00Z` : null;
  const scheduledEnd = finish ? `${finish}T17:00:00Z` : null;

  return {
    "@odata.type": ENTITY_TYPE,
    msdyn_projecttaskid: taskId || require("node:crypto").randomUUID(),
    msdyn_subject: buildSubject(issue),
    msdyn_description: buildDescription(issue),
    msdyn_start: scheduledStart,
    msdyn_finish: scheduledEnd,
    msdyn_scheduledstart: scheduledStart,
    msdyn_scheduledend: scheduledEnd,
    msdyn_progress: issue?.state === "closed" ? 1 : 0,
    "msdyn_project@odata.bind": `/msdyn_projects(${projectId})`,
    "msdyn_projectbucket@odata.bind": `/msdyn_projectbuckets(${bucketId})`,
  };
}

async function listProjectLabels({ projectId, token, baseUrl, fetchImpl }) {
  const filter = `_msdyn_projectid_value eq '${String(projectId).replace(/'/g, "''")}'`;
  const { body } = await dataverseRequest({
    baseUrl,
    path: `/msdyn_projectlabels?$select=msdyn_projectlabelid,msdyn_projectlabeltext&$filter=${encodeURIComponent(filter)}&$top=5000`,
    method: "GET", token, fetchImpl,
  });
  return body?.value || [];
}

const LABEL_ASSOC_TYPE = "Microsoft.Dynamics.CRM.msdyn_projecttasktolabel";
const LABEL_ASSOC_SELECT = "msdyn_projecttasktolabelid,_msdyn_projectlabelid_value,_msdyn_projecttaskid_value,_msdyn_pfwcreatedby_value";

// Status de msdyn_operationsets.
const SET_PENDING = 192350001;
const SET_DONE = 192350003;

/**
 * A interface do Planner só mostra a associação que o Project gravou — a que
 * tem _msdyn_pfwcreatedby_value preenchido. A gravada pela coleção de
 * navegação da task (versão antiga do sync) existe, mas fica invisível.
 */
function isVisibleAssociation(row) {
  return Boolean(row?._msdyn_pfwcreatedby_value);
}

/**
 * Associações de rótulo de UMA task (visíveis e invisíveis), lidas de
 * msdyn_projecttasktolabels — a tabela que a interface do Planner usa.
 */
async function listTaskLabelAssociations({ taskId, token, baseUrl, fetchImpl }) {
  const filter = `_msdyn_projecttaskid_value eq '${String(taskId).replace(/'/g, "''")}'`;
  const { body } = await dataverseRequest({
    baseUrl,
    path: `/msdyn_projecttasktolabels?$select=${LABEL_ASSOC_SELECT}&$filter=${encodeURIComponent(filter)}&$top=5000`,
    method: "GET", token, fetchImpl,
  });
  return body?.value || [];
}

const LABEL_CHUNK_SIZE = 50;

/**
 * Rótulos VISÍVEIS de várias tasks, em um mapa taskId → conjunto de labelIds.
 * Uma consulta por bloco de 50 tasks (mesmo limite do mapping).
 */
async function listTaskLabelAssociationsForTasks({ taskIds, token, baseUrl, fetchImpl }) {
  const ids = [...new Set((taskIds || []).filter(Boolean))];
  const byTask = new Map(ids.map((id) => [id, new Set()]));
  for (let i = 0; i < ids.length; i += LABEL_CHUNK_SIZE) {
    const chunk = ids.slice(i, i + LABEL_CHUNK_SIZE);
    const filter = chunk.map((id) => `_msdyn_projecttaskid_value eq '${id}'`).join(" or ");
    const { body } = await dataverseRequest({
      baseUrl,
      path: `/msdyn_projecttasktolabels?$select=${LABEL_ASSOC_SELECT}&$filter=${encodeURIComponent(filter)}&$top=5000`,
      method: "GET", token, fetchImpl,
    });
    for (const row of body?.value || []) {
      const taskId = row._msdyn_projecttaskid_value;
      if (!taskId || !byTask.has(taskId) || !isVisibleAssociation(row)) continue;
      byTask.get(taskId).add(row._msdyn_projectlabelid_value);
    }
  }
  return byTask;
}

/**
 * Espera o operation set sair de "Pendente". Apagar o registro do set antes
 * disso CANCELA a gravação — por isso o set só é descartado depois.
 */
async function waitOperationSet({ operationSetId, token, baseUrl, fetchImpl, pollDelayMs = 3000, timeoutMs = 120000 }) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { body } = await dataverseRequest({
      baseUrl,
      path: `/msdyn_operationsets(${operationSetId})?$select=msdyn_status`,
      method: "GET", token, fetchImpl,
    });
    const status = body?.msdyn_status;
    if (status !== SET_PENDING) return status;
    if (Date.now() >= deadline) return status;
    await new Promise((resolve) => setTimeout(resolve, pollDelayMs));
  }
}

/**
 * Espelha os rótulos do GitLab no Planner Premium.
 *
 * Grava pelo operation set — a única via que deixa o rótulo visível no
 * cartão: uma chamada msdyn_PssCreateV2 por rótulo, entidade SEM id (com id o
 * set fica "Pendente" para sempre; dois sem id na mesma chamada são recusados
 * como duplicados). A remoção do rótulo que não existe no GitLab também passa
 * pelo set (msdyn_PssDeleteV2), e só alcança associações visíveis.
 *
 * Associação invisível (gravada pela versão antiga do sync) não é apagável por
 * nenhuma API e o índice único (task, rótulo) impede gravar o mesmo par de
 * novo: o rótulo vai para `blocked` — remover pela interface do Project.
 *
 * Rótulo do GitLab que não existe no plano vai para `missing`: a API não cria
 * rótulo de plano.
 *
 * @returns {Promise<{applied: string[], missing: string[], removed: string[], stale: string[], blocked: string[]}>}
 */
async function synchronizeTaskLabels({ taskId, projectId, labels, token, baseUrl, fetchImpl, pollDelayMs, timeoutMs }) {
  const names = [...new Set((labels || []).map((label) => typeof label === "string" ? label : label?.title || label?.name || "").map((name) => name.trim()).filter(Boolean))];
  const projectLabels = await listProjectLabels({ projectId, token, baseUrl, fetchImpl });
  const labelByName = new Map(projectLabels.map((label) => [String(label.msdyn_projectlabeltext || "").toLocaleLowerCase(), label]));
  const textOf = (id) => projectLabels.find((label) => label.msdyn_projectlabelid === id)?.msdyn_projectlabeltext;
  const missing = names.filter((name) => !labelByName.has(name.toLocaleLowerCase()));
  const wanted = new Map(names
    .filter((name) => labelByName.has(name.toLocaleLowerCase()))
    .map((name) => [labelByName.get(name.toLocaleLowerCase()).msdyn_projectlabelid, labelByName.get(name.toLocaleLowerCase()).msdyn_projectlabeltext]));

  const rows = await listTaskLabelAssociations({ taskId, token, baseUrl, fetchImpl });
  const visibleIds = new Set(rows.filter(isVisibleAssociation).map((row) => row._msdyn_projectlabelid_value));
  const invisibleIds = new Set(rows.filter((row) => !isVisibleAssociation(row)).map((row) => row._msdyn_projectlabelid_value));

  const toCreate = [...wanted.keys()].filter((id) => !visibleIds.has(id) && !invisibleIds.has(id));
  const blocked = [...wanted.keys()].filter((id) => !visibleIds.has(id) && invisibleIds.has(id));
  const toDelete = rows.filter((row) => isVisibleAssociation(row) && !wanted.has(row._msdyn_projectlabelid_value));
  const staleInvisible = rows.filter((row) => !isVisibleAssociation(row) && !wanted.has(row._msdyn_projectlabelid_value));

  if (toCreate.length || toDelete.length) {
    const operationSetId = await createOperationSet({
      projectId,
      description: `Sync GitLab → Planner Premium (rótulos) — task ${taskId}`,
      token, baseUrl, fetchImpl,
    });
    try {
      for (const id of toCreate) {
        await queueCreateTasks({
          operationSetId,
          entities: [{
            "@odata.type": LABEL_ASSOC_TYPE,
            msdyn_name: wanted.get(id),
            "msdyn_ProjectLabelId@odata.bind": `/msdyn_projectlabels(${id})`,
            "msdyn_ProjectTaskId@odata.bind": `/msdyn_projecttasks(${taskId})`,
          }],
          token, baseUrl, fetchImpl,
        });
      }
      for (const row of toDelete) {
        await queueDeleteTasks({
          operationSetId,
          entities: [{ "@odata.type": LABEL_ASSOC_TYPE, msdyn_projecttasktolabelid: row.msdyn_projecttasktolabelid }],
          token, baseUrl, fetchImpl,
        });
      }
      await executeOperationSet({ operationSetId, token, baseUrl, fetchImpl });
    } catch (error) {
      await discardOperationSet({ operationSetId, token, baseUrl, fetchImpl }).catch(() => {});
      throw error;
    }
    const status = await waitOperationSet({ operationSetId, token, baseUrl, fetchImpl, pollDelayMs, timeoutMs });
    if (status === SET_PENDING) {
      // Ainda gravando: NÃO apaga o registro (cancelaria a gravação). A
      // próxima rodada encontra o rótulo pronto.
      throw new Error(`rótulos da task ${taskId}: o operation set ${operationSetId} ainda está pendente`);
    }
    await discardOperationSet({ operationSetId, token, baseUrl, fetchImpl }).catch(() => {});
    if (status !== SET_DONE) {
      throw new Error(`rótulos da task ${taskId}: o operation set ${operationSetId} falhou (status ${status})`);
    }
  }

  return {
    applied: [...wanted.keys()].filter((id) => !blocked.includes(id)).map((id) => wanted.get(id)),
    missing,
    removed: toDelete.map((row) => textOf(row._msdyn_projectlabelid_value)).filter(Boolean),
    stale: staleInvisible.map((row) => textOf(row._msdyn_projectlabelid_value)).filter(Boolean),
    blocked: blocked.map((id) => wanted.get(id)),
  };
}

/**
 * Constrói o payload de atualização de uma task Premium (mesmo shape da
 * criação + o id da task).
 */
function buildUpdateEntity({ issue, projectId, bucketId, taskId }) {
  // Sem o vínculo com o projeto: com ele no update o Project ignora a troca
  // de bucket (validado em 16/11/2026 — só o bucket, sem o projeto, move).
  const { "msdyn_project@odata.bind": _project, ...entity } = buildTaskEntity({ issue, projectId, bucketId });
  return { ...entity, msdyn_projecttaskid: taskId };
}

// ─── Cliente HTTP (fetch puro) ────────────────────────────────────────────────

const DEFAULT_BASE_URL = process.env.DATAVERSE_URL_PREMIUM || "";
const API_VERSION = "v9.2";

function resolveFetch(fetchImpl) {
  return fetchImpl || globalThis.fetch;
}

/**
 * Chamada HTTP ao Dataverse. Lança Error com a mensagem do Dataverse quando
 * a resposta não é 2xx (o corpo de erro do Dataverse vem em { error: { message } }).
 */
async function dataverseRequest({ baseUrl = DEFAULT_BASE_URL, path, method = "GET", body, token, fetchImpl, allowStatuses = [] }) {
  const url = `${baseUrl}/api/data/${API_VERSION}${path}`;
  const doFetch = resolveFetch(fetchImpl);

  const response = await doFetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "OData-MaxVersion": "4.0",
      "OData-Version": "4.0",
      Accept: "application/json",
      Prefer: "return=representation",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }

  if (!response.status || response.status >= 400) {
    if (allowStatuses.includes(response.status)) return { status: response.status, body: parsed };
    const message = parsed?.error?.message || parsed?.message || (typeof parsed === "string" ? parsed : text) || `HTTP ${response.status}`;
    const error = new Error(`Dataverse ${method} ${path} falhou (${response.status}): ${message}`);
    error.status = response.status;
    error.body = parsed;
    throw error;
  }

  return { status: response.status, body: parsed };
}

// ─── Operation sets ───────────────────────────────────────────────────────────

/**
 * Cria um operation set para o plano e devolve o OperationSetId.
 */
async function createOperationSet({ projectId, description, token, baseUrl, fetchImpl }) {
  const { body } = await dataverseRequest({
    baseUrl,
    path: "/msdyn_CreateOperationSetV1",
    method: "POST",
    body: { ProjectId: projectId, Description: description },
    token,
    fetchImpl,
  });
  const setId = body?.OperationSetId || body?.msdyn_OperationSetId;
  if (!setId) throw new Error("msdyn_CreateOperationSetV1 não devolveu OperationSetId");
  return setId;
}

/**
 * Enfileira criações de tasks no set (lote).
 */
async function queueCreateTasks({ operationSetId, entities, token, baseUrl, fetchImpl }) {
  const { body } = await dataverseRequest({
    baseUrl,
    path: "/msdyn_PssCreateV2",
    method: "POST",
    body: { OperationSetId: operationSetId, EntityCollection: entities },
    token,
    fetchImpl,
  });
  return body;
}

/**
 * Enfileira atualizações de tasks no set (lote).
 */
async function queueUpdateTasks({ operationSetId, entities, token, baseUrl, fetchImpl }) {
  const { body } = await dataverseRequest({
    baseUrl,
    path: "/msdyn_PssUpdateV2",
    method: "POST",
    body: { OperationSetId: operationSetId, EntityCollection: entities },
    token,
    fetchImpl,
  });
  return body;
}

/**
 * Enfileira a exclusão de tasks no set (lote).
 *
 * O DELETE direto em /msdyn_projecttasks é recusado pelo Dataverse
 * ("Não é possível executar diretamente a operação Delete"), então a remoção
 * também passa pelo operation set (msdyn_PssDeleteV2).
 */
async function queueDeleteTasks({ operationSetId, entities, token, baseUrl, fetchImpl }) {
  const { body } = await dataverseRequest({
    baseUrl,
    path: "/msdyn_PssDeleteV2",
    method: "POST",
    body: { OperationSetId: operationSetId, EntityCollection: entities },
    token,
    fetchImpl,
  });
  return body;
}

/**
 * Executa o set (aqui as tasks são realmente criadas/atualizadas).
 */
async function executeOperationSet({ operationSetId, token, baseUrl, fetchImpl }) {
  const { body } = await dataverseRequest({
    baseUrl,
    path: "/msdyn_ExecuteOperationSetV1",
    method: "POST",
    body: { OperationSetId: operationSetId },
    token,
    fetchImpl,
  });
  return body;
}

/**
 * Lê uma task pelo id. Devolve null se ela ainda não existe (404) — é assim
 * que o sync confere se o operation set já materializou.
 */
async function getTaskById({ taskId, token, baseUrl, fetchImpl, select }) {
  const query = select ? `?$select=${encodeURIComponent(select)}` : "";
  const { body } = await dataverseRequest({
    baseUrl,
    path: `/msdyn_projecttasks(${taskId})${query}`,
    method: "GET",
    token,
    fetchImpl,
    allowStatuses: [404],
  });
  if (!body || body.error || !body.msdyn_projecttaskid) return null;
  return body;
}

/**
 * Abandona as operações pendentes de um set (sem apagar o registro).
 */
async function abandonOperationSet({ operationSetId, token, baseUrl, fetchImpl }) {
  const { body } = await dataverseRequest({
    baseUrl,
    path: "/msdyn_AbandonOperationSetV1",
    method: "POST",
    body: { OperationSetId: operationSetId },
    token,
    fetchImpl,
  });
  return body;
}

/**
 * Descarta o set: abandona as operações pendentes e apaga o registro
 * msdyn_operationsets (a cota é de 10 sets vivos por usuário).
 *
 * CUIDADO: o Dataverse aplica o operation set de forma ASSÍNCRONA — a task
 * só aparece na consulta alguns segundos depois do execute, e apagar o
 * registro do set nesse intervalo CANCELA a criação pendente (a task nunca
 * chega a existir). Só use este discard quando as tasks já materializaram
 * (ou quando o set falhou de vez).
 *
 * O abandon é best-effort: depois de EXECUTAR, o set já não está "aberto" e o
 * abandon responde 400 ("O conjunto de operações não está em estado aberto") —
 * o que libera a cota é o DELETE do registro do set, que vem logo abaixo.
 */
async function discardOperationSet({ operationSetId, token, baseUrl, fetchImpl }) {
  try {
    await abandonOperationSet({ operationSetId, token, baseUrl, fetchImpl });
  } catch {
    // best effort — o DELETE abaixo é o que importa
  }

  await dataverseRequest({
    baseUrl,
    path: `/msdyn_operationsets(${operationSetId})`,
    method: "DELETE",
    token,
    fetchImpl,
    allowStatuses: [404],
  });
}

/**
 * Buckets (colunas do Planner) de um plano Premium.
 */
async function listProjectBuckets({ projectId, token, baseUrl, fetchImpl }) {
  const filter = `_msdyn_project_value eq '${projectId}'`;
  const query = `?$select=msdyn_projectbucketid,msdyn_name&$filter=${encodeURIComponent(filter)}&$top=100`;

  const { body } = await dataverseRequest({
    baseUrl,
    path: `/msdyn_projectbuckets${query}`,
    method: "GET",
    token,
    fetchImpl,
  });

  return (body?.value || []).map((b) => ({
    id: b.msdyn_projectbucketid,
    name: b.msdyn_name,
  }));
}

/**
 * Mapa assunto → id da task, para as tasks do projeto informado.
 * Usado depois do execute para descobrir o id das tasks recém-criadas.
 */
async function findTaskIdsBySubjects({ projectId, subjects, token, baseUrl, fetchImpl }) {
  const filter = `_msdyn_project_value eq '${projectId}'`;
  const query = `?$select=msdyn_subject,msdyn_projecttaskid&$filter=${encodeURIComponent(filter)}&$top=5000`;

  const { body } = await dataverseRequest({
    baseUrl,
    path: `/msdyn_projecttasks${query}`,
    method: "GET",
    token,
    fetchImpl,
  });

  const map = {};
  for (const row of body?.value || []) {
    if (row?.msdyn_subject) map[row.msdyn_subject] = row.msdyn_projecttaskid;
  }
  return map;
}

module.exports = {
  ENTITY_TYPE,
  SUBJECT_MAX_LENGTH,
  DESCRIPTION_MAX_LENGTH,
  buildSubject,
  buildDescription,
  buildTaskEntity,
  buildUpdateEntity,
  dataverseRequest,
  createOperationSet,
  queueCreateTasks,
  queueUpdateTasks,
  queueDeleteTasks,
  executeOperationSet,
  abandonOperationSet,
  discardOperationSet,
  listProjectBuckets,
  listProjectLabels,
  listTaskLabelAssociations,
  listTaskLabelAssociationsForTasks,
  synchronizeTaskLabels,
  findTaskIdsBySubjects,
  getTaskById,
};

