"use strict";

const axios = require("axios");

// ─── Configurações ─────────────────────────────────────────────────────────────

const DATAVERSE_URL = process.env.DATAVERSE_URL;
const PLANNER_PLAN_ID = process.env.PLANNER_PLAN_ID || "";
const TABLE_NAME = "pmo_mapeamentoplanner";
const ENTITY_SET = "pmo_mapeamentoplanners"; // Plural name para a API Dataverse

// Cache em memória dos buckets do plano
let _bucketsCache = null;
let _bucketsCacheTime = 0;
const BUCKETS_CACHE_TTL_MS = 5 * 60 * 1000;

// ─── Cliente Dataverse ─────────────────────────────────────────────────────────

let _dataverseClient = null;
let _accessToken = null;
let _tokenExpiresAt = 0;

async function getAccessToken() {
  console.log(`[tableStorage] getAccessToken: iniciando...`);
  // Reutiliza token se ainda válido (com margem de 5 min)
  if (_accessToken && Date.now() < _tokenExpiresAt - 300000) {
    console.log(`[tableStorage] getAccessToken: cache hit`);
    return _accessToken;
  }

  const tenantId = process.env.AZURE_TENANT_ID;
  const clientId = process.env.AZURE_CLIENT_ID;
  const clientSecret = process.env.AZURE_CLIENT_SECRET;

  if (!tenantId || !clientId || !clientSecret) {
    throw new Error("Credenciais Azure AD não configuradas (AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET)");
  }

  // Para Dataverse, scope é diferente
  const scope = `${DATAVERSE_URL}/.default`;

  const tokenUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;

  const params = new URLSearchParams();
  params.append("grant_type", "client_credentials");
  params.append("client_id", clientId);
  params.append("client_secret", clientSecret);
  params.append("scope", scope);

  console.log(`[tableStorage] getAccessToken: POST ${tokenUrl} scope=${scope}`);
  const response = await axios.post(tokenUrl, params, {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
  console.log(`[tableStorage] getAccessToken: response status=${response.status} tem_token=${!!response.data.access_token}`);

  _accessToken = response.data.access_token;
  _tokenExpiresAt = Date.now() + (response.data.expires_in * 1000);

  return _accessToken;
}

async function getDataverseClient() {
  if (_dataverseClient) {
    console.log(`[tableStorage] getDataverseClient: cache hit`);
    return _dataverseClient;
  }

  console.log(`[tableStorage] getDataverseClient: criando client...`);
  if (!DATAVERSE_URL) {
    throw new Error("DATAVERSE_URL não configurado nas settings da Function App");
  }

  console.log(`[tableStorage] getDataverseClient: obtendo token Azure AD...`);
  const token = await getAccessToken();
  console.log(`[tableStorage] getDataverseClient: token obtido (length=${token ? token.length : 0})`);

  _dataverseClient = axios.create({
    baseURL: `${DATAVERSE_URL}/api/data/v9.2`,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "OData-MaxVersion": "4.0",
      "OData-Version": "4.0",
      Accept: "application/json",
      "Prefer": 'odata.include-annotations="*"',
    },
  });

  return _dataverseClient;
}

// ─── Operações CRUD ───────────────────────────────────────────────────────────

/**
 * Salva ou atualiza um mapping de Issue GitLab -> Task Planner
 * Se existir registro com mesmo pmo_gitlab_iid, atualiza. Senão, cria.
 */
async function saveMapping({ gitlabIid, plannerTaskId, plannerBucketId, issueData }) {
  const client = await getDataverseClient();

  const data = {
    pmo_plannerplanid: PLANNER_PLAN_ID,
    pmo_plannertaskid: plannerTaskId || null,
    pmo_plannerbucketid: plannerBucketId || null,
    pmo_dataultimasincronizacao: new Date().toISOString(),
    pmo_statussincronizacao: "Sincronizado",
    // Campos customizados (precisam existir na tabela):
    pmo_gitlab_iid: Number(gitlabIid),
    pmo_gitlab_url: issueData?.webUrl || issueData?.web_url || "",
    // Título com prefixo [#iid] igual ao que vai pro Planner (criação/update).
    // Se o caller já passou o prefixo (caso da importação XLSX), não duplica.
    pmo_title: (() => {
      const t = (issueData?.title || "").trim();
      const prefix = `[#${gitlabIid}]`;
      return (t.startsWith(prefix) ? t : `${prefix} ${t}`).substring(0, 500);
    })(),
    // pmo_description no Dataverse é limitado a 2000 chars (validation 0x80044331).
    // A description completa do GitLab vai pra Planner task description sem limite.
    pmo_description: (issueData?.description || "").substring(0, 2000),
    pmo_issue_labels: Array.isArray(issueData?.labels) ? issueData.labels.join(",") : (issueData?.labels || ""),
  };

  // Verifica se já existe registro para este IID
  const existing = await getMapping(gitlabIid);

  if (existing) {
    // Atualiza (PATCH)
    await client.patch(`/${ENTITY_SET}(${existing.pmo_mapeamentoplannerid})`, data);
    return { ...existing, ...data };
  } else {
    // Cria (POST)
    const response = await client.post(`/${ENTITY_SET}`, data);
    return {
      ...data,
      pmo_mapeamentoplannerid: response.data.pmo_mapeamentoplannerid,
    };
  }
}

/**
 * Busca mapping pelo IID do GitLab
 */
async function getMapping(gitlabIid) {
  console.log(`[tableStorage] getMapping: buscando iid=${gitlabIid}`);
  const client = await getDataverseClient();
  console.log(`[tableStorage] getMapping: client pronto, fazendo GET...`);

  try {
    const filter = `pmo_gitlab_iid eq ${Number(gitlabIid)}`;
    const response = await client.get(`/${ENTITY_SET}`, {
      params: {
        $filter: filter,
        $top: 1,
      },
    });
    console.log(`[tableStorage] getMapping: retorno type=${typeof response} status=${response.status}`);

    const records = response.data.value;
    return records.length > 0 ? records[0] : null;
  } catch (err) {
    if (err.response?.status === 404) return null;
    throw err;
  }
}

/**
 * Remove um mapping (quando issue é fechada/deletada)
 */
async function deleteMapping(gitlabIid) {
  const client = await getDataverseClient();

  const existing = await getMapping(gitlabIid);
  if (existing && existing.pmo_mapeamentoplannerid) {
    await client.delete(`/${ENTITY_SET}(${existing.pmo_mapeamentoplannerid})`);
  }
}

/**
 * Lista todos os mappings
 */
async function listMappings() {
  const client = await getDataverseClient();

  const allRecords = [];
  let nextLink = null;
  let url = `/${ENTITY_SET}?$top=5000`;

  while (url) {
    const response = await client.get(url);
    allRecords.push(...response.data.value);
    nextLink = response.data["@odata.nextLink"];
    url = nextLink ? nextLink.replace(client.defaults.baseURL, "") : null;
  }

  return allRecords;
}

/**
 * Lista mappings que têm Planner Task ID
 */
async function listMappingsWithPlannerIds() {
  const mappings = await listMappings();
  return mappings.filter(m => m.pmo_plannertaskid);
}

/**
 * Deleta todos os mappings cujo pmo_plannerplanid == planId.
 * Usado para limpar registros órfãos após migração de plano.
 * Retorna { total, deleted, ids, errors }.
 */
async function deleteMappingsByPlanId(planId) {
  if (!planId) throw new Error("planId é obrigatório");

  const client = await getDataverseClient();
  const escaped = String(planId).replace(/'/g, "''");
  const filter = `pmo_plannerplanid eq '${escaped}'`;

  let total = 0;
  let nextUrl = `/${ENTITY_SET}?$filter=${encodeURIComponent(filter)}&$top=5000&$count=true`;
  const records = [];

  // Paginação
  while (nextUrl) {
    const resp = await client.get(nextUrl);
    if (Array.isArray(resp.data.value)) records.push(...resp.data.value);
    nextUrl = resp.data["@odata.nextLink"]
      ? resp.data["@odata.nextLink"].replace(client.defaults.baseURL, "")
      : null;
  }
  total = records.length;

  let deleted = 0;
  const ids = [];
  const errors = [];

  for (const r of records) {
    const id = r.pmo_mapeamentoplannerid;
    try {
      await client.delete(`/${ENTITY_SET}(${id})`);
      ids.push(id);
      deleted++;
      if (deleted % 10 === 0 || deleted === total) {
        console.log(`[tableStorage] deleteMappingsByPlanId: ${deleted}/${total}`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push({ id, message: msg });
      console.error(`[tableStorage] deleteMappingsByPlanId: erro ao deletar ${id}: ${msg}`);
    }
  }

  return { total, deleted, ids, errors };
}

// ─── Cache de Buckets ─────────────────────────────────────────────────────────

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

function clearBucketsCache() {
  _bucketsCache = null;
  _bucketsCacheTime = 0;
}

async function getOrCreateBucket(planId, bucketName, createBucketFn) {
  const buckets = await getCachedBuckets(planId, async () => []);

  const existing = buckets.find(
    b => b.name && b.name.toLowerCase() === bucketName.toLowerCase()
  );

  if (existing) {
    return existing;
  }

  const newBucket = await createBucketFn(planId, bucketName);

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
  deleteMappingsByPlanId,
  getCachedBuckets,
  clearBucketsCache,
  getOrCreateBucket,
  getAccessToken,
  getDataverseClient,
  TABLE_NAME,
  ENTITY_SET,
};
