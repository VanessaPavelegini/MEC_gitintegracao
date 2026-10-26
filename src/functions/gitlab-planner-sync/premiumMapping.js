"use strict";

// Mapping issue (GitLab) → task (Planner Premium), plan-scoped.
//
// A tabela pmo_mapeamentoplanner vive no Aplicativos PRD e é compartilhada
// com o sync do Planner **clássico** (763 linhas do plano
// hIjg2ZZaY0mWB5gpuJFMZmUABFNv). Por isso toda consulta aqui é filtrada
// também por pmo_plannerplanid — sem isso, um iid do GitLab colidiria com o
// mapping do plano clássico.
//
// A coluna pmo_gitlab_updatedat (updated_at do GitLab visto no último sync)
// é o que permite detectar mudança. Ela é criada por
// scripts/criar-coluna-pmo-gitlab-updatedat.js; se ainda não existir, o
// código cai para pmo_dataultimasincronizacao (fallback do plano §3.3).

const { dataverseRequest } = require("./premiumDataverse");

const ENTITY_SET = "pmo_mapeamentoplanners";
const IID_CHUNK_SIZE = 50;

// ─── Consultas ────────────────────────────────────────────────────────────────

function escapeODataString(value) {
  return String(value).replace(/'/g, "''");
}

/**
 * Mapping de uma issue (iid) dentro de um plano Premium.
 */
async function getMappingByPlan({ baseUrl, token, fetchImpl, planId, iid }) {
  const filter = `pmo_plannerplanid eq '${escapeODataString(planId)}' and pmo_gitlab_iid eq ${Number(iid)}`;
  const query = `?$filter=${encodeURIComponent(filter)}&$top=1`;

  const { body } = await dataverseRequest({
    baseUrl,
    path: `/${ENTITY_SET}${query}`,
    method: "GET",
    token,
    fetchImpl,
  });

  const records = body?.value || [];
  return records.length > 0 ? records[0] : null;
}

/**
 * Mappings de um conjunto de iids dentro do plano (chunks de 50 para não
 * estourar o limite de tamanho de filtro do Dataverse).
 */
async function listMappingsForIids({ baseUrl, token, fetchImpl, planId, iids }) {
  const list = (iids || []).map(Number).filter((n) => Number.isFinite(n));
  if (list.length === 0) return [];

  const result = [];
  for (let i = 0; i < list.length; i += IID_CHUNK_SIZE) {
    const chunk = list.slice(i, i + IID_CHUNK_SIZE);
    const conditions = chunk.map((iid) => `pmo_gitlab_iid eq ${iid}`).join(" or ");
    const filter = `pmo_plannerplanid eq '${escapeODataString(planId)}' and (${conditions})`;
    const query = `?$filter=${encodeURIComponent(filter)}&$top=5000`;

    const { body } = await dataverseRequest({
      baseUrl,
      path: `/${ENTITY_SET}${query}`,
      method: "GET",
      token,
      fetchImpl,
    });
    result.push(...(body?.value || []));
  }

  return result;
}

/**
 * Todos os mappings de um plano.
 */
async function listMappingsByPlan({ baseUrl, token, fetchImpl, planId }) {
  const filter = `pmo_plannerplanid eq '${escapeODataString(planId)}'`;
  const query = `?$filter=${encodeURIComponent(filter)}&$top=5000`;

  const { body } = await dataverseRequest({
    baseUrl,
    path: `/${ENTITY_SET}${query}`,
    method: "GET",
    token,
    fetchImpl,
  });

  return body?.value || [];
}

// ─── Escrita ──────────────────────────────────────────────────────────────────

/**
 * Salva (cria ou atualiza) o mapping de uma issue dentro do plano.
 *
 * @param {boolean} hasUpdatedAtColumn  se a coluna pmo_gitlab_updatedat existe
 */
async function saveMappingPremium({
  baseUrl,
  token,
  fetchImpl,
  planId,
  gitlabIid,
  plannerTaskId,
  plannerBucketId,
  gitlabUpdatedAt,
  hasUpdatedAtColumn = true,
  issueData = {},
}) {
  const title = String(issueData.title || "").trim();
  const prefix = `[#${gitlabIid}]`;
  const labels = Array.isArray(issueData.labels) ? issueData.labels : [];

  const data = {
    pmo_plannerplanid: planId,
    pmo_plannertaskid: plannerTaskId || null,
    pmo_plannerbucketid: plannerBucketId || null,
    pmo_dataultimasincronizacao: new Date().toISOString(),
    pmo_statussincronizacao: "Sincronizado",
    pmo_gitlab_iid: Number(gitlabIid),
    pmo_gitlab_url: issueData.web_url || issueData.webUrl || "",
    pmo_title: (title.startsWith(prefix) ? title : `${prefix} ${title}`).substring(0, 500),
    // pmo_description é String(2000) no Dataverse — a descrição completa vai
    // para a task do Planner, sem truncamento.
    pmo_description: String(issueData.description || "").substring(0, 2000),
    pmo_issue_labels: labels.map((l) => (typeof l === "string" ? l : l?.title || "")).join(",").substring(0, 500),
  };

  if (hasUpdatedAtColumn && gitlabUpdatedAt) {
    data.pmo_gitlab_updatedat = gitlabUpdatedAt;
  }

  const existing = await getMappingByPlan({ baseUrl, token, fetchImpl, planId, iid: gitlabIid });

  if (existing?.pmo_mapeamentoplannerid) {
    const { body } = await dataverseRequest({
      baseUrl,
      path: `/${ENTITY_SET}(${existing.pmo_mapeamentoplannerid})`,
      method: "PATCH",
      body: data,
      token,
      fetchImpl,
    });
    return { ...existing, ...data, ...(body && typeof body === "object" ? body : {}) };
  }

  const { body } = await dataverseRequest({
    baseUrl,
    path: `/${ENTITY_SET}`,
    method: "POST",
    body: data,
    token,
    fetchImpl,
  });

  return { ...data, ...(body && typeof body === "object" ? body : {}) };
}

// ─── Schema ───────────────────────────────────────────────────────────────────

/**
 * A coluna pmo_gitlab_updatedat existe no schema da tabela?
 */
async function hasGitlabUpdatedAtColumn({ baseUrl, token, fetchImpl }) {
  const { body } = await dataverseRequest({
    baseUrl,
    path: "/EntityDefinitions(LogicalName='pmo_mapeamentoplanner')/Attributes",
    method: "GET",
    token,
    fetchImpl,
  });

  return (body?.value || []).some((attr) => attr?.LogicalName === "pmo_gitlab_updatedat");
}

module.exports = {
  ENTITY_SET,
  getMappingByPlan,
  listMappingsForIids,
  listMappingsByPlan,
  saveMappingPremium,
  hasGitlabUpdatedAtColumn,
};
