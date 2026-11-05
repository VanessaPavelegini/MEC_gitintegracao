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
    msdyn_description: String(issue?.description || "").substring(0, DESCRIPTION_MAX_LENGTH),
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

async function listTaskLabelAssociations({ taskId, token, baseUrl, fetchImpl }) {
  const filter = `_msdyn_projecttaskid_value eq '${String(taskId).replace(/'/g, "''")}'`;
  const { body } = await dataverseRequest({
    baseUrl,
    path: `/msdyn_projecttasktolabels?$select=_msdyn_projectlabelid_value&$filter=${encodeURIComponent(filter)}&$top=5000`,
    method: "GET", token, fetchImpl,
  });
  return body?.value || [];
}

const LABEL_CHUNK_SIZE = 50;

/**
 * Associações de rótulo de várias tasks, em um mapa taskId → conjunto de
 * labelIds. Uma consulta por bloco de 50 tasks (mesmo limite do mapping).
 */
async function listTaskLabelAssociationsForTasks({ taskIds, token, baseUrl, fetchImpl }) {
  const ids = [...new Set((taskIds || []).filter(Boolean))];
  const byTask = new Map(ids.map((id) => [id, new Set()]));
  for (let i = 0; i < ids.length; i += LABEL_CHUNK_SIZE) {
    const chunk = ids.slice(i, i + LABEL_CHUNK_SIZE);
    const filter = chunk.map((id) => `_msdyn_projecttaskid_value eq '${id}'`).join(" or ");
    const { body } = await dataverseRequest({
      baseUrl,
      path: `/msdyn_projecttasktolabels?$select=_msdyn_projectlabelid_value,_msdyn_projecttaskid_value&$filter=${encodeURIComponent(filter)}&$top=5000`,
      method: "GET", token, fetchImpl,
    });
    for (const row of body?.value || []) {
      const taskId = row._msdyn_projecttaskid_value;
      if (!taskId || !byTask.has(taskId)) continue;
      byTask.get(taskId).add(row._msdyn_projectlabelid_value);
    }
  }
  return byTask;
}

/**
 * Espelha os rótulos do GitLab no Planner Premium.
 *
 * O Planner Premium guarda o rótulo da task em msdyn_projecttasktolabel (com
 * o nome do rótulo e o vínculo com a task e com o rótulo do plano). O registro
 * é criado pela COLEÇÃO DE NAVEGAÇÃO da task — o POST direto na entidade é
 * recusado ("Não é possível executar diretamente a operação Create").
 *
 * Remover é diferente: o Delete dessa entidade é bloqueado em todas as rotas
 * (direto, coleção de navegação e operation set). Por isso o sync ADICIA os
 * rótulos que faltam e devolve em `stale` os que existem no Planner e não
 * existem no GitLab — a remoção delas precisa ser feita na interface.
 *
 * @returns {Promise<{applied: string[], missing: string[], stale: string[]}>}
 */
async function synchronizeTaskLabels({ taskId, projectId, labels, token, baseUrl, fetchImpl, currentLabelIds }) {
  const names = [...new Set((labels || []).map((label) => typeof label === "string" ? label : label?.title || label?.name || "").map((name) => name.trim()).filter(Boolean))];
  const projectLabels = await listProjectLabels({ projectId, token, baseUrl, fetchImpl });
  const labelByName = new Map(projectLabels.map((label) => [String(label.msdyn_projectlabeltext || "").toLocaleLowerCase(), label]));
  const missing = names.filter((name) => !labelByName.has(name.toLocaleLowerCase()));

  const current = currentLabelIds instanceof Set
    ? currentLabelIds
    : new Set((await listTaskLabelAssociations({ taskId, token, baseUrl, fetchImpl })).map((row) => row._msdyn_projectlabelid_value));

  const wanted = new Set(names.filter((name) => labelByName.has(name.toLocaleLowerCase())).map((name) => labelByName.get(name.toLocaleLowerCase()).msdyn_projectlabelid));
  const stale = [...current].filter((id) => !wanted.has(id));

  for (const id of wanted) {
    if (current.has(id)) continue;
    const name = projectLabels.find((label) => label.msdyn_projectlabelid === id)?.msdyn_projectlabeltext;
    try {
      await dataverseRequest({
        baseUrl,
        path: `/msdyn_projecttasks(${taskId})/msdyn_projecttask_projecttasktolabel`,
        method: "POST",
        body: {
          "msdyn_name": name,
          "msdyn_ProjectLabelId@odata.bind": `${baseUrl}/api/data/${API_VERSION}/msdyn_projectlabels(${id})`,
        },
        token, fetchImpl, allowStatuses: [204],
      });
    } catch (error) {
      // O Project grava o registro e falha só ao montar a resposta (500 com
      // "Unable to cast object of type EntityMetadata..."). O vínculo existe
      // nesse caso — a leitura confirma antes de tratar como erro.
      const depois = await listTaskLabelAssociations({ taskId, token, baseUrl, fetchImpl });
      if (!depois.some((row) => row._msdyn_projectlabelid_value === id)) throw error;
    }
  }
  return {
    applied: names.filter((name) => wanted.has(labelByName.get(name.toLocaleLowerCase())?.msdyn_projectlabelid)),
    missing,
    stale: stale.map((id) => projectLabels.find((label) => label.msdyn_projectlabelid === id)?.msdyn_projectlabeltext).filter(Boolean),
  };
}

/**
 * Constrói o payload de atualização de uma task Premium (mesmo shape da
 * criação + o id da task).
 */
function buildUpdateEntity({ issue, projectId, bucketId, taskId }) {
  return {
    ...buildTaskEntity({ issue, projectId, bucketId }),
    msdyn_projecttaskid: taskId,
  };
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

