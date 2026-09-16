"use strict";

const { getGraphClient } = require("./graphClient");

// ─── Configurações ─────────────────────────────────────────────────────────────

const DEFAULT_UPN_DOMAIN = process.env.AZURE_AD_UPN_DOMAIN || "mec.gov.br";
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hora
const REQUEST_TIMEOUT_MS = 10000;

// Cache em memória: username lowercase -> { id, userPrincipalName, displayName, cachedAt }
const _cache = new Map();

// ─── Helpers internos ─────────────────────────────────────────────────────────

function buildUpn(username) {
  if (!username) return null;
  const trimmed = String(username).trim();
  if (!trimmed) return null;
  // Se já tem @, usa como UPN
  if (trimmed.includes("@")) return trimmed.toLowerCase();
  return `${trimmed.toLowerCase()}@${DEFAULT_UPN_DOMAIN}`;
}

/**
 * Resolve usuário do Azure AD pelo username do GitLab.
 * - Cache em memória por 1h (chave = UPN lowercase)
 * - Filtra usuários desabilitados (accountEnabled eq false)
 * - Retorna null se não encontrar
 * @param {string} username - username do GitLab (ex: "joao.silva")
 * @returns {Promise<{ id: string, userPrincipalName: string, displayName: string } | null>}
 */
async function lookupUserByUsername(username) {
  if (!username) return null;

  const upn = buildUpn(username);
  if (!upn) return null;

  // Verifica cache
  const cached = _cache.get(upn);
  if (cached && (Date.now() - cached.cachedAt) < CACHE_TTL_MS) {
    return cached.data; // pode ser null (cache de "não encontrado")
  }

  try {
    const client = getGraphClient();
    const filter = encodeURIComponent(
      `userPrincipalName eq '${upn.replace(/'/g, "''")}' and accountEnabled eq true`
    );
    const response = await client
      .api(`/users?$filter=${filter}&$select=id,userPrincipalName,displayName&$top=1`)
      .timeout(REQUEST_TIMEOUT_MS)
      .get();

    const users = response.value || [];
    const data = users.length > 0
      ? {
          id: users[0].id,
          userPrincipalName: users[0].userPrincipalName,
          displayName: users[0].displayName,
        }
      : null;

    _cache.set(upn, { data, cachedAt: Date.now() });
    return data;
  } catch (err) {
    console.warn(`[azureAdUsers] Falha no lookup de '${upn}': ${err.message}`);
    // Não cacheia erro — tenta de novo no próximo lookup
    return null;
  }
}

/**
 * Resolve vários usernames de uma vez (versão sequencial com cache).
 * Não paraleliza pra evitar martelar o Graph com vários requests simultâneos.
 * @param {string[]} usernames
 * @returns {Promise<Map<string, { id: string, userPrincipalName: string, displayName: string }>>}
 *          Mapa apenas com usernames que foram encontrados
 */
async function lookupUsersByUsernames(usernames) {
  const result = new Map();
  if (!Array.isArray(usernames) || usernames.length === 0) return result;

  for (const username of usernames) {
    const user = await lookupUserByUsername(username);
    if (user) {
      result.set(username, user);
    }
  }

  return result;
}

/**
 * Limpa o cache (útil pra testes).
 */
function clearCache() {
  _cache.clear();
}

module.exports = {
  lookupUserByUsername,
  lookupUsersByUsernames,
  clearCache,
  buildUpn,
  DEFAULT_UPN_DOMAIN,
};
