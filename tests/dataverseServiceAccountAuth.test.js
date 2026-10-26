"use strict";

// Testes do token delegado da conta de serviço (device code flow → refresh token)
// — src/shared/dataverseServiceAccountAuth.js

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const auth = require(path.join(__dirname, "..", "src", "shared", "dataverseServiceAccountAuth"));

const ORG_URL = "https://orgcf194dda.crm.dynamics.com";

// O módulo lê tenant/client do ambiente (em produção vêm do Function App).
process.env.AZURE_TENANT_ID = process.env.AZURE_TENANT_ID || "b8c25932-5e76-4b2b-9c53-d41745e9c92d";
process.env.AZURE_CLIENT_ID = process.env.AZURE_CLIENT_ID || "18fb3c07-66df-40a0-86d6-5d2d84dea60f";

function fakeFetch(responses) {
  const calls = [];
  const queue = [...responses];
  const impl = async (url, options = {}) => {
    calls.push({ url, options, body: options.body ? Object.fromEntries(new URLSearchParams(options.body)) : undefined });
    const next = queue.length > 1 ? queue.shift() : queue[0];
    return { status: next.status, text: async () => JSON.stringify(next.body) };
  };
  impl.calls = calls;
  return impl;
}

test("getDataverseDelegatedToken troca o refresh token por um access token delegado", async () => {
  const fetchImpl = fakeFetch([{ status: 200, body: { access_token: "delegado-123", expires_in: 3600 } }]);
  const store = { read: async () => "rt-antigo", save: async () => {} };

  const token = await auth.getDataverseDelegatedToken({ orgUrl: ORG_URL, fetchImpl, tokenStore: store });

  assert.equal(token, "delegado-123");
  const call = fetchImpl.calls[0];
  assert.match(call.url, /oauth2\/v2\.0\/token$/);
  assert.equal(call.body.grant_type, "refresh_token");
  assert.equal(call.body.refresh_token, "rt-antigo");
  assert.match(call.body.scope, /user_impersonation/);
  assert.match(call.body.scope, /offline_access/);
  assert.match(call.body.scope, new RegExp("orgcf194dda"));
});

test("getDataverseDelegatedToken não envia client_secret (cliente público)", async () => {
  const fetchImpl = fakeFetch([{ status: 200, body: { access_token: "t", expires_in: 3600 } }]);
  const store = { read: async () => "rt", save: async () => {} };

  await auth.getDataverseDelegatedToken({ orgUrl: ORG_URL, fetchImpl, tokenStore: store });

  assert.equal(fetchImpl.calls[0].body.client_secret, undefined);
  assert.ok(fetchImpl.calls[0].body.client_id);
});

test("getDataverseDelegatedToken guarda o refresh token rotacionado", async () => {
  const fetchImpl = fakeFetch([{ status: 200, body: { access_token: "t", expires_in: 3600, refresh_token: "rt-novo" } }]);
  const saved = [];
  const store = { read: async () => "rt-antigo", save: async (t) => saved.push(t) };

  await auth.getDataverseDelegatedToken({ orgUrl: ORG_URL, fetchImpl, tokenStore: store });

  assert.deepEqual(saved, ["rt-novo"]);
});

test("getDataverseDelegatedToken explica como reautorizar quando o refresh token expirou", async () => {
  const fetchImpl = fakeFetch([{ status: 400, body: { error: "invalid_grant", error_description: "expired" } }]);
  const store = { read: async () => "rt-antigo", save: async () => {} };

  await assert.rejects(
    () => auth.getDataverseDelegatedToken({ orgUrl: ORG_URL, fetchImpl, tokenStore: store }),
    /autorizarContaServicoPremium/
  );
});

test("getDataverseDelegatedToken falha com mensagem clara quando não há refresh token guardado", async () => {
  const fetchImpl = fakeFetch([{ status: 200, body: {} }]);
  const store = { read: async () => null, save: async () => {} };

  await assert.rejects(
    () => auth.getDataverseDelegatedToken({ orgUrl: ORG_URL, fetchImpl, tokenStore: store }),
    /autorizarContaServicoPremium/
  );
  assert.equal(fetchImpl.calls.length, 0);
});
