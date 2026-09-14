"use strict";

const { TableClient } = require("@azure/data-tables");

// ─── Configurações ─────────────────────────────────────────────────────────────

const TABLE_NAME = "GitLabPlannerMapping";
const PARTITION_KEY = "gitlab-planner";

// Cache em memória dos buckets do plano para evitar chamadas repetidas
let _bucketsCache = null;
let _bucketsCacheTime = 0;
const BUCKETS_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutos

// ─── Cliente do Table Storage ─────────────────────────────────────────────────

/**
 * Obtém cliente do Table Storage
 * @returns {TableClient}
 */
function getTableClient() {
  const connString = process.env.TABLE_STORAGE_CONN_STRING;
  if (!connString) {
    throw new Error("TABLE_STORAGE_CONN_STRING não configurado nas settings da Function App");
  }
  return TableClient.fromConnectionString(connString, TABLE_NAME);
}

// ─── Mapeamentos ───────────────────────────────────────────────────────────────

/**
 * Salva ou atualiza um mapping de Issue GitLab -> Task Planner
 * @param {object} mapping
 * @param {number|string} mapping.gitlabIid - IID da issue no GitLab
 * @param {string} mapping.plannerTaskId - ID da task no Planner
 * @param {string} mapping.plannerBucketId - ID do bucket atual
 * @param {object} mapping.issueData - Dados da issue para salvar
 * @returns {Promise<object>} - Entidade salva
 */
async function saveMapping({ gitlabIid, plannerTaskId, plannerBucketId, issueData }) {
  const client = getTableClient();

  const entity = {
    partitionKey: PARTITION_KEY,
    rowKey: String(gitlabIid),
    gitlabIid: Number(gitlabIid),
    plannerTaskId: plannerTaskId,
    plannerBucketId: plannerBucketId || "",
    title: issueData?.title || "",
    description: issueData?.description || "",
    lastSyncedAt: new Date().toISOString(),
    issueLabels: Array.isArray(issueData?.labels) ? issueData.labels.join(",") : (issueData?.labels || ""),
    gitlabUrl: issueData?.webUrl || issueData?.web_url || "",
  };

  await client.upsertEntity(entity, "Merge");
  return entity;
}

/**
 * Busca mapping pelo IID do GitLab
 * @param {string|number} gitlabIid
 * @returns {Promise<object|null>}
 */
async function getMapping(gitlabIid) {
  const client = getTableClient();

  try {
    const entity = await client.getEntity(PARTITION_KEY, String(gitlabIid));
    return entity;
  } catch (err) {
    if (err.statusCode === 404) {
      return null;
    }
    throw err;
  }
}

/**
 * Remove um mapping (quando issue é fechada/deletada)
 * @param {string|number} gitlabIid
 */
async function deleteMapping(gitlabIid) {
  const client = getTableClient();
  await client.deleteEntity(PARTITION_KEY, String(gitlabIid));
}

/**
 * Lista todos os mappings
 * @returns {Promise<Array>}
 */
async function listMappings() {
  const client = getTableClient();
  const entities = [];

  for await (const entity of client.listEntities()) {
    entities.push(entity);
  }

  return entities;
}

/**
 * Lista mappings que ainda existem no Planner
 * Útil para identificar tarefas que foram deletadas no Planner mas ainda tem mapping
 * @returns {Promise<Array>}
 */
async function listMappingsWithPlannerIds() {
  const mappings = await listMappings();
  return mappings.filter(m => m.plannerTaskId);
}

// ─── Cache de Buckets ─────────────────────────────────────────────────────────

/**
 * Obtém buckets do plano (com cache em memória)
 * @param {string} planId - ID do plano Planner
 * @param {Function} fetchFn - Função para buscar buckets se não estiver em cache
 * @returns {Promise<Array>}
 */
async function getCachedBuckets(planId, fetchFn) {
  const now = Date.now();

  if (_bucketsCache && _bucketsCache.planId === planId && (now - _bucketsCacheTime) < BUCKETS_CACHE_TTL_MS) {
    return _bucketsCache.buckets;
  }

  const buckets = await fetchFn(planId);

  _bucketsCache = { planId, buckets };
  _bucketsCacheTime = now;

  return buckets;
}

/**
 * Limpa cache de buckets (para forçar re-busca)
 */
function clearBucketsCache() {
  _bucketsCache = null;
  _bucketsCacheTime = 0;
}

/**
 * Obtém ou cria bucket pelo nome
 * @param {string} planId
 * @param {string} bucketName
 * @param {Function} createBucketFn - Função para criar bucket (recebe planId e nome)
 * @returns {Promise<object>} - Bucket com { id, name }
 */
async function getOrCreateBucket(planId, bucketName, createBucketFn) {
  const buckets = await getCachedBuckets(planId, async () => {
    // Esta função será sobrescrita pelo chamador
    return [];
  });

  // Procura bucket existente (case-insensitive)
  const existing = buckets.find(
    b => b.name && b.name.toLowerCase() === bucketName.toLowerCase()
  );

  if (existing) {
    return existing;
  }

  // Bucket não existe, cria
  const newBucket = await createBucketFn(planId, bucketName);

  // Atualiza cache
  if (_bucketsCache && _bucketsCache.planId === planId) {
    _bucketsCache.buckets.push(newBucket);
  }

  return newBucket;
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  saveMapping,
  getMapping,
  deleteMapping,
  listMappings,
  listMappingsWithPlannerIds,
  getCachedBuckets,
  clearBucketsCache,
  getOrCreateBucket,
  TABLE_NAME,
  PARTITION_KEY,
};
