"use strict";

// Testes do handler do sync Premium (homologação) — premiumHandler.js
//
// O handler recebe as dependências por injeção, então roda sem GitLab,
// sem Dataverse e sem Azure.

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const { runPremiumSync } = require(path.join(__dirname, "..", "src", "functions", "gitlab-planner-sync", "premiumHandler"));

const PLAN_ID = "c385351a-e450-4d54-87ed-d54c57794f7b";
const BUCKET_ID = "f704c207-84be-f111-a04d-7c1e520d9f67";

function makeDeps(over = {}) {
  const calls = { syncPage: [], tokens: 0, buckets: [] };
  const deps = {
    calls,
    planId: PLAN_ID,
    bucketName: "Bucket 1",
    syncPage: async (args) => {
      calls.syncPage.push(args);
      return { ok: true, processed: 2, created: 2, updated: 0, unchanged: 0, skipped: 0, errors: [], nextCursor: null };
    },
    getDelegatedToken: async () => {
      calls.tokens += 1;
      return "delegado";
    },
    getPrdToken: async () => "prd",
    listProjectBuckets: async ({ projectId }) => {
      calls.buckets.push(projectId);
      return [{ id: BUCKET_ID, name: "Bucket 1" }];
    },
    ...over,
  };
  return deps;
}

test("runPremiumSync recusa request sem planId", async () => {
  const deps = makeDeps({ planId: undefined });
  const res = await runPremiumSync({ request: { body: {}, query: {} }, deps });

  assert.equal(res.status, 400);
  assert.equal(res.body.ok, false);
  assert.match(res.body.error, /planId/i);
  assert.equal(deps.calls.syncPage.length, 0);
});

test("runPremiumSync recusa cursor inválido", async () => {
  const deps = makeDeps();
  const res = await runPremiumSync({ request: { body: { planId: PLAN_ID, cursor: "xxx!!" }, query: {} }, deps });

  assert.equal(res.status, 400);
  assert.match(res.body.error, /cursor/i);
});

test("runPremiumSync roda a página e devolve o resumo", async () => {
  const deps = makeDeps();
  const res = await runPremiumSync({ request: { body: { planId: PLAN_ID }, query: {} }, deps });

  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.created, 2);
  assert.equal(deps.calls.syncPage.length, 1);
  assert.equal(deps.calls.syncPage[0].planId, PLAN_ID);
});

test("runPremiumSync não busca token delegado em dry run", async () => {
  const deps = makeDeps();
  const res = await runPremiumSync({ request: { body: { planId: PLAN_ID, dryRun: true }, query: {} }, deps });

  assert.equal(res.status, 200);
  assert.equal(deps.calls.tokens, 0);
});

test("runPremiumSync resolve o bucket pelo nome quando o request não traz bucketId", async () => {
  const deps = makeDeps();
  const res = await runPremiumSync({ request: { body: { planId: PLAN_ID }, query: {} }, deps });

  assert.equal(res.status, 200);
  assert.deepEqual(deps.calls.buckets, [PLAN_ID]);
  assert.equal(deps.calls.syncPage[0].bucketId, BUCKET_ID);
});

test("runPremiumSync usa o bucketId do request quando informado", async () => {
  const deps = makeDeps();
  const res = await runPremiumSync({
    request: { body: { planId: PLAN_ID, bucketId: "outro-bucket" }, query: {} },
    deps,
  });

  assert.equal(res.status, 200);
  assert.equal(deps.calls.syncPage[0].bucketId, "outro-bucket");
  assert.equal(deps.calls.buckets.length, 0);
});

test("runPremiumSync aceita parâmetros via query string", async () => {
  const deps = makeDeps();
  const res = await runPremiumSync({
    request: { body: {}, query: { planId: PLAN_ID, pageSize: "50", state: "closed" } },
    deps,
  });

  assert.equal(res.status, 200);
  assert.equal(deps.calls.syncPage[0].pageSize, 50);
  assert.equal(deps.calls.syncPage[0].state, "closed");
});

test("runPremiumSync devolve 500 com a mensagem quando o sync falha", async () => {
  const deps = makeDeps({
    syncPage: async () => {
      throw new Error("Dataverse fora do ar");
    },
  });

  const res = await runPremiumSync({ request: { body: { planId: PLAN_ID }, query: {} }, deps });

  assert.equal(res.status, 500);
  assert.equal(res.body.ok, false);
  assert.match(res.body.error, /Dataverse fora do ar/);
});
