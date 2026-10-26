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
const DESCRIPTION_MAX_LENGTH = 100000; // msdyn_description (Memo)

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
function buildTaskEntity({ issue, projectId, bucketId }) {
  const start = require("./premiumSync").toDateOnly(issue?.created_at);
  const finish = require("./premiumSync").computeFinishDate(start, issue?.due_date);

  return {
    "@odata.type": ENTITY_TYPE,
    msdyn_subject: buildSubject(issue),
    msdyn_description: String(issue?.description || "").substring(0, DESCRIPTION_MAX_LENGTH),
    msdyn_start: start,
    msdyn_finish: finish,
    msdyn_progress: issue?.state === "closed" ? 100 : 0,
    "msdyn_project@odata.bind": `/msdyn_projects(${projectId})`,
    "msdyn_projectbucket@odata.bind": `/msdyn_projectbuckets(${bucketId})`,
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

module.exports = {
  ENTITY_TYPE,
  SUBJECT_MAX_LENGTH,
  DESCRIPTION_MAX_LENGTH,
  buildSubject,
  buildTaskEntity,
  buildUpdateEntity,
};
