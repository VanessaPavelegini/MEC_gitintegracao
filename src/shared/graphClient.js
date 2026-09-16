"use strict";

const axios = require("axios");
const qs = require("querystring");

let _cachedToken = null;
let _tokenExpiresAt = 0;

/**
 * Obtém token do Azure AD via OAuth2 client_credentials
 * Cache em memória até 5 minutos antes do expiry
 */
async function getAccessToken() {
  const now = Date.now();

  // Cache válido por 55 min (token expira em 60 min)
  if (_cachedToken && now < _tokenExpiresAt - 5 * 60 * 1000) {
    return _cachedToken;
  }

  const tenantId     = process.env.AZURE_TENANT_ID;
  const clientId     = process.env.AZURE_CLIENT_ID;
  const clientSecret = process.env.AZURE_CLIENT_SECRET;

  if (!tenantId || !clientId || !clientSecret) {
    throw new Error("Credenciais Azure AD não configuradas (AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET).");
  }

  const url = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
  const body = qs.stringify({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
    scope: "https://graph.microsoft.com/.default",
  });

  const resp = await axios.post(url, body, {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    timeout: 30000,
  });

  _cachedToken = resp.data.access_token;
  _tokenExpiresAt = now + (resp.data.expires_in * 1000);

  return _cachedToken;
}

/**
 * Cria um objeto "chainable" compatível com a interface antiga do SDK Graph
 * mas implementado via HTTP direto (axios).
 *
 * Suporta:
 *   client.api("/path").get()
 *   client.api("/path").post(body)
 *   client.api("/path").patch(body)
 *   client.api("/path").header("If-Match", "*").get()
 *   client.api("/path").header("If-Match", "*").patch(body)
 *
 * Retorna o body JSON parseado.
 */
function getGraphClient() {
  function makeChain(path, method, body, headers) {
    const chain = {
      _path: path,
      _method: method,
      _body: body,
      _headers: headers || {},
      _resultIsResponse: false,

      header(name, value) {
        return makeChain(this._path, this._method, this._body, {
          ...this._headers,
          [name]: value,
        });
      },

      async get() {
        return _execGraph("GET", this._path, undefined, this._headers);
      },

      async post(payload) {
        return _execGraph("POST", this._path, payload || this._body, this._headers);
      },

      async patch(payload) {
        return _execGraph("PATCH", this._path, payload || this._body, this._headers);
      },

      async delete() {
        return _execGraph("DELETE", this._path, undefined, this._headers);
      },

      async put(payload) {
        return _execGraph("PUT", this._path, payload || this._body, this._headers);
      },
    };
    return chain;
  }

  return {
    api(path) {
      return makeChain(path, null, null, {});
    },
  };
}

async function _execGraph(method, path, body, extraHeaders) {
  const token = await getAccessToken();

  const url = path.startsWith("http")
    ? path
    : `https://graph.microsoft.com/v1.0${path}`;

  const config = {
    method,
    url,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...extraHeaders,
    },
    timeout: 30000,
    validateStatus: () => true, // Não lançar erro — deixa o caller tratar
  };

  if (body !== undefined && body !== null) {
    config.data = body;
  }

  const resp = await axios(config);

  if (resp.status >= 400) {
    const err = new Error(`Graph API error ${resp.status}: ${JSON.stringify(resp.data)}`);
    err.statusCode = resp.status;
    err.code = resp.data && resp.data.error && resp.data.error.code;
    err.body = resp.data;
    throw err;
  }

  // Para DELETE (204 No Content) retornar null
  if (resp.status === 204) return null;

  return resp.data;
}

/**
 * Invalida cache de token (útil após rotacionar secrets)
 */
function clearTokenCache() {
  _cachedToken = null;
  _tokenExpiresAt = 0;
}

module.exports = {
  getGraphClient,
  getAccessToken,
  clearTokenCache,
};
