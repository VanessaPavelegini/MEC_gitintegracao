"use strict";

// Identidade da conta de serviço (portaldedemandas@mec.gov.br) para escrita
// no Planner Premium da org Default.
//
// Por que não client credentials: o app user `app-pnld` tem islicensed=false
// e o Dataverse responde UserNotLicensed em qualquer escrita Premium
// (msdyn_projecttask / operation sets). Só uma identidade de USUÁRIO com
// licença ModernProject consegue escrever — aqui, a conta de serviço
// portaldedemandas@mec.gov.br (islicensed=true, accessmode=0).
//
// Como essa conta é usada: device code flow (script de uso único
// scripts/autorizarContaServicoPremium.js) gera um refresh token guardado no
// Blob Storage; em runtime, esse refresh token é trocado por um access token
// DELEGADO da org desejada. O refresh token é rotacionado a cada troca —
// por isso guardamos sempre o mais recente.
//
// Sem client_secret: o refresh token veio de um cliente público (device code
// flow) e o AAD rejeita segredo na troca (AADSTS700025).

const DEFAULT_ORG_URL = process.env.DATAVERSE_URL_PREMIUM || "https://orgcf194dda.crm.dynamics.com";
const BLOB_CONTAINER = process.env.PREMIUM_SYNC_BLOB_CONTAINER || "service-tokens";
const BLOB_NAME = process.env.PREMIUM_SYNC_BLOB_NAME || "premium-dataverse-refresh-token.json";
const AUTHORIZATION_HINT = "rode scripts/autorizarContaServicoPremium.js (device code flow) para reautorizar a conta portaldedemandas@mec.gov.br";

// ─── Refresh token no Blob Storage ────────────────────────────────────────────

/**
 * Token store padrão: Blob Storage (mesma Storage Account do projeto irmão).
 */
function blobTokenStore() {
  // Requerido sob demanda: o SDK depende de globalThis.crypto (Node >= 19).
  if (!globalThis.crypto) globalThis.crypto = require("node:crypto").webcrypto;
  const { BlobServiceClient } = require("@azure/storage-blob");

  const connStr = process.env.AZURE_STORAGE_CONNECTION_STRING || process.env.AzureWebJobsStorage;
  if (!connStr) {
    throw new Error(`AZURE_STORAGE_CONNECTION_STRING não configurada — não dá para ler o refresh token (${AUTHORIZATION_HINT})`);
  }

  const getBlobClient = () =>
    BlobServiceClient.fromConnectionString(connStr)
      .getContainerClient(BLOB_CONTAINER)
      .getBlockBlobClient(BLOB_NAME);

  return {
    async read() {
      const blobClient = getBlobClient();
      const exists = await blobClient.exists();
      if (!exists) return null;
      const buffer = await blobClient.downloadToBuffer();
      const data = JSON.parse(buffer.toString("utf8"));
      return data.refresh_token || null;
    },
    async save(refreshToken) {
      const blobClient = getBlobClient();
      const body = JSON.stringify({ refresh_token: refreshToken, updated_at: new Date().toISOString() });
      await blobClient.upload(body, Buffer.byteLength(body), { overwrite: true });
    },
  };
}

// ─── Token delegado ───────────────────────────────────────────────────────────

/**
 * Access token DELEGADO de portaldedemandas@mec.gov.br para a org informada.
 *
 * @param {object}   args
 * @param {string}   args.orgUrl    URL da org (ex.: https://orgcf194dda.crm.dynamics.com)
 * @param {function} args.fetchImpl  fetch injetável (testes)
 * @param {object}   args.tokenStore { read, save } — injetável (testes)
 * @returns {Promise<string>} access token
 */
async function getDataverseDelegatedToken({ orgUrl = DEFAULT_ORG_URL, fetchImpl, tokenStore, context } = {}) {
  const doFetch = fetchImpl || globalThis.fetch;
  const store = tokenStore || blobTokenStore();

  const refreshToken = await store.read();
  if (!refreshToken) {
    throw new Error(`Refresh token da conta de serviço não encontrado (Blob ${BLOB_CONTAINER}/${BLOB_NAME}) — ${AUTHORIZATION_HINT}`);
  }

  const tenantId = process.env.AZURE_TENANT_ID;
  const clientId = process.env.AZURE_CLIENT_ID;
  if (!tenantId || !clientId) {
    throw new Error("AZURE_TENANT_ID / AZURE_CLIENT_ID não configurados");
  }

  const params = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: clientId,
    refresh_token: refreshToken,
    scope: `${orgUrl}/user_impersonation offline_access`,
  });

  const response = await doFetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = {};
  }

  if (!response.status || response.status >= 400) {
    const message = data.error_description || data.error || text || `HTTP ${response.status}`;
    throw new Error(`Falha ao renovar o token delegado da conta de serviço — ${AUTHORIZATION_HINT}. AAD respondeu ${response.status}: ${String(message).substring(0, 300)}`);
  }

  if (!data.access_token) {
    throw new Error(`Troca do refresh token não devolveu access_token — ${AUTHORIZATION_HINT}`);
  }

  if (data.refresh_token) {
    await store.save(data.refresh_token);
  } else if (context) {
    context.log("[dataverseServiceAccountAuth] AAD não devolveu refresh_token novo — mantendo o anterior.");
  }

  return data.access_token;
}

module.exports = {
  DEFAULT_ORG_URL,
  BLOB_CONTAINER,
  BLOB_NAME,
  blobTokenStore,
  getDataverseDelegatedToken,
};
