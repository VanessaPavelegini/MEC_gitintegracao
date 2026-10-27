"use strict";

// Identidade de USUÁRIO para escrita no Planner Premium da org Default.
//
// Por que não client credentials: o app user `app-pnld` tem islicensed=false
// e o Dataverse responde UserNotLicensed em qualquer escrita Premium
// (msdyn_projecttask / operation sets). Só uma identidade de USUÁRIO com
// licença ModernProject consegue escrever.
//
// Qual conta: hoje é `antoniojunior@mec.gov.br` — tem licença ModernProject e
// escrita no plano. A `portaldedemandas@mec.gov.br` LÊ o plano, mas o
// `msdyn_ExecuteOperationSetV1` responde "Forbidden — Permissions required:
// Write." (verificado em 26/10/2026). O refresh token guardado no Blob precisa
// ser o dessa conta: token da portaldedemandas faz a escrita falhar.
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
const AUTHORIZATION_HINT = "rode scripts/autorizarContaServicoPremium.js (device code flow) para reautorizar a conta com escrita no plano (antoniojunior@mec.gov.br)";

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

  const readEntry = async () => {
    const blobClient = getBlobClient();
    const exists = await blobClient.exists();
    if (!exists) return null;
    const buffer = await blobClient.downloadToBuffer();
    const data = JSON.parse(buffer.toString("utf8"));
    if (!data.refresh_token) return null;
    return { token: data.refresh_token, updatedAt: Date.parse(data.updated_at || "") || 0 };
  };

  return {
    async read() {
      const entry = await readEntry();
      return entry ? entry.token : null;
    },
    async readEntry() {
      return readEntry();
    },
    async save(refreshToken) {
      const blobClient = getBlobClient();
      const body = JSON.stringify({ refresh_token: refreshToken, updated_at: new Date().toISOString() });
      await blobClient.upload(body, Buffer.byteLength(body), { overwrite: true });
    },
  };
}

/**
 * Token store local (dev na máquina, sem Storage Account): lê e grava o
 * .premium-refresh-token.json que o script de autorização deixa na raiz.
 * Só é usado quando não há connection string de storage no ambiente.
 */
function localFileTokenStore() {
  const fs = require("node:fs");
  const path = require("node:path");
  const file = process.env.PREMIUM_SYNC_TOKEN_FILE || path.join(process.cwd(), ".premium-refresh-token.json");

  const readEntry = () => {
    if (!fs.existsSync(file)) return null;
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!data.refresh_token) return null;
    return { token: data.refresh_token, updatedAt: Date.parse(data.updated_at || "") || 0 };
  };

  return {
    async read() {
      const entry = readEntry();
      return entry ? entry.token : null;
    },
    async readEntry() {
      return readEntry();
    },
    async save(refreshToken) {
      fs.writeFileSync(file, JSON.stringify({ refresh_token: refreshToken, updated_at: new Date().toISOString() }, null, 2));
    },
  };
}

/**
 * Token store composto: Blob (onde a Function publicada lê) + arquivo local
 * (cópia de trabalho da máquina).
 *
 * Por que os dois: o AAD ROTACIONA o refresh token a cada troca — o token novo
 * substitui o antigo. Se um lado gravasse só num lugar, o outro ficaria com
 * um token velho (invalid_grant) na próxima execução. Gravando nos dois, os
 * dois lados enxergam o token corrente.
 *
 * Na leitura vale o token mais recente (comparado pelo updated_at gravado
 * junto do token), não o do primeiro lugar consultado.
 */
function compositeTokenStore({ blobStore, fileStore }) {
  return {
    async read() {
      const candidatos = [];
      for (const store of [blobStore, fileStore]) {
        if (!store) continue;
        try {
          const entry = store.readEntry ? await store.readEntry() : null;
          if (entry?.token) candidatos.push(entry);
        } catch {
          // Um dos lados fora do ar: segue para o outro.
        }
      }
      if (candidatos.length === 0) return null;
      candidatos.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      return candidatos[0].token;
    },
    async save(refreshToken) {
      const erros = [];
      if (fileStore) {
        try {
          await fileStore.save(refreshToken);
        } catch (e) {
          erros.push(e);
        }
      }
      if (blobStore) {
        try {
          await blobStore.save(refreshToken);
        } catch (e) {
          erros.push(e);
        }
      }
      if (erros.length > 0) {
        throw new Error(`Falha ao gravar o refresh token: ${erros.map((e) => e.message).join("; ")}`);
      }
    },
  };
}

/**
 * Storage account configurado? Se sim, grava no Blob E no arquivo local;
 * se não, só no arquivo local.
 */
function defaultTokenStore() {
  const fileStore = localFileTokenStore();
  if (process.env.AZURE_STORAGE_CONNECTION_STRING || process.env.AzureWebJobsStorage) {
    return compositeTokenStore({ blobStore: blobTokenStore(), fileStore });
  }
  return fileStore;
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
  const store = tokenStore || defaultTokenStore();

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
    try {
      await store.save(data.refresh_token);
    } catch (e) {
      // A rotação no AAD já aconteceu: o access token acima é válido, mas o
      // próximo cold start pode falhar até o token novo ser gravado.
      const msg = `[dataverseServiceAccountAuth] não consegui gravar o refresh token rotacionado: ${e.message}`;
      if (context) context.log(msg);
      else console.warn(msg);
    }
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
  localFileTokenStore,
  compositeTokenStore,
  defaultTokenStore,
  getDataverseDelegatedToken,
};
