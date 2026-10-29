"use strict";

// Testes do handler do sync incremental (premiumChangesHandler.js)

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const { runPremiumChanges } = require(path.join(__dirname, "..", "src", "functions", "gitlab-planner-sync", "premiumChangesHandler"));
const premiumSync = require(path.join(__dirname, "..", "src", "functions", "gitlab-planner-sync", "premiumSync"));

const PLAN_ID = "c0ecce95-1107-4343-8c05-bcf7c9a291f8";
const BUCKET_ID = "be10a1da-0bd2-f111-84dc-7c1e520d9dbb";

function makeDeps(over = {}) {
  const calls = { syncPage: [], tokens: 0, buckets: [] };
  const deps = {
    calls,
    planId: PLAN_ID,
    bucketName: "Bucket 1",
    bucketId: BUCKET_ID,
    syncPage: async (args) => {
      calls.syncPage.push(args);
      // Uma página só: a fase aberta devolve o cursor da fase fechada, e a
      // fechada devolve null — fim do sync.
      if (args.phase === "opened") {
        return {
          ok: true, processed: 3, created: 0, updated: 1, unchanged: 2, skipped: 0,
          errors: [], nextCursor: premiumSync.encodeCursor(1, "closed"),
        };
      }
      return {
        ok: true, processed: 1, created: 0, updated: 1, unchanged: 0, skipped: 0,
        errors: [], nextCursor: null,
      };
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

test("runPremiumChanges recusa request sem planId", async () => {
  const deps = makeDeps({ planId: undefined });
  const res = await runPremiumChanges({ request: { body: {}, query: {} }, deps });

  assert.equal(res.status, 400);
  assert.equal(res.body.ok, false);
  assert.match(res.body.error, /planId/i);
  assert.equal(deps.calls.syncPage.length, 0);
});

test("runPremiumChanges percorre a fase aberta e a fase fechada", async () => {
  const deps = makeDeps();
  const res = await runPremiumChanges({ request: { body: { planId: PLAN_ID }, query: {} }, deps });

  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(deps.calls.syncPage.length, 2);
  assert.equal(deps.calls.syncPage[0].phase, "opened");
  assert.equal(deps.calls.syncPage[1].phase, "closed");
});

test("runPremiumChanges manda a janela updated_after para o syncPage", async () => {
  const deps = makeDeps();
  await runPremiumChanges({ request: { body: { planId: PLAN_ID }, query: {} }, deps });

  const since = deps.calls.syncPage[0].updatedAfter;
  assert.ok(since, "a janela precisa ser repassada");
  const ageMin = (Date.now() - new Date(since).getTime()) / 60000;
  assert.ok(ageMin > 23 * 60 && ageMin < 25 * 60, `janela de 24h esperada, veio ${ageMin} min`);
});

test("runPremiumChanges respeita o lookbackMinutes pedido", async () => {
  const deps = makeDeps();
  await runPremiumChanges({ request: { body: { planId: PLAN_ID, lookbackMinutes: 60 }, query: {} }, deps });

  const since = deps.calls.syncPage[0].updatedAfter;
  const ageMin = (Date.now() - new Date(since).getTime()) / 60000;
  assert.ok(ageMin > 55 && ageMin < 65, `janela de 60 min esperada, veio ${ageMin} min`);
  assert.equal(deps.calls.syncPage[0].phase, "opened");
});

test("runPremiumChanges soma os contadores das duas fases", async () => {
  const deps = makeDeps();
  const res = await runPremiumChanges({ request: { body: { planId: PLAN_ID }, query: {} }, deps });

  assert.equal(res.body.processed, 4);
  assert.equal(res.body.updated, 2);
  assert.equal(res.body.unchanged, 2);
});

test("runPremiumChanges não busca token delegado em dry run", async () => {
  const deps = makeDeps();
  const res = await runPremiumChanges({ request: { body: { planId: PLAN_ID, dryRun: true }, query: {} }, deps });

  assert.equal(res.status, 200);
  assert.equal(deps.calls.tokens, 0);
});

test("runPremiumChanges usa o bucketId padrão sem buscar buckets", async () => {
  const deps = makeDeps();
  await runPremiumChanges({ request: { body: { planId: PLAN_ID }, query: {} }, deps });

  assert.equal(deps.calls.buckets.length, 0);
  assert.equal(deps.calls.syncPage[0].bucketId, BUCKET_ID);
});

test("runPremiumChanges resolve o bucket pelo nome quando não há bucketId", async () => {
  const deps = makeDeps({ bucketId: undefined });
  await runPremiumChanges({ request: { body: { planId: PLAN_ID }, query: {} }, deps });

  assert.deepEqual(deps.calls.buckets, [PLAN_ID]);
  assert.equal(deps.calls.syncPage[0].bucketId, BUCKET_ID);
});

test("runPremiumChanges devolve 500 com a mensagem quando o sync falha", async () => {
  const deps = makeDeps({
    syncPage: async () => {
      throw new Error("Dataverse fora do ar");
    },
  });

  const res = await runPremiumChanges({ request: { body: { planId: PLAN_ID }, query: {} }, deps });

  assert.equal(res.status, 500);
  assert.equal(res.body.ok, false);
  assert.match(res.body.error, /Dataverse fora do ar/);
});

test("runPremiumChanges devolve a janela usada na resposta", async () => {
  const deps = makeDeps();
  const res = await runPremiumChanges({ request: { body: { planId: PLAN_ID, lookbackMinutes: 120 }, query: {} }, deps });

  assert.equal(res.body.window.lookbackMinutes, 120);
  assert.ok(res.body.window.since);
});

// ─── Trava de execução ────────────────────────────────────────────────────────

test("runPremiumChanges não roda quando outro sync está em andamento", async () => {
  const deps = makeDeps({
    acquireLock: async () => ({ acquired: false, reason: "trava em uso" }),
    releaseLock: async () => true,
  });

  const res = await runPremiumChanges({ request: { body: { planId: PLAN_ID }, query: {} }, deps });

  assert.equal(res.status, 409);
  assert.equal(res.body.skipped, true);
  assert.equal(deps.calls.syncPage.length, 0, "não pode tocar no Planner com o lock ocupado");
});

test("runPremiumChanges adquire e libera a trava", async () => {
  const calls = { acquired: 0, released: 0 };
  const deps = makeDeps({
    acquireLock: async () => {
      calls.acquired += 1;
      return { acquired: true };
    },
    releaseLock: async () => {
      calls.released += 1;
      return true;
    },
  });

  const res = await runPremiumChanges({ request: { body: { planId: PLAN_ID }, query: {} }, deps });

  assert.equal(res.status, 200);
  assert.equal(calls.acquired, 1);
  assert.equal(calls.released, 1);
});

test("runPremiumChanges libera a trava mesmo quando o sync falha", async () => {
  const calls = { released: 0 };
  const deps = makeDeps({
    acquireLock: async () => ({ acquired: true }),
    releaseLock: async () => {
      calls.released += 1;
      return true;
    },
    syncPage: async () => {
      throw new Error("Dataverse fora do ar");
    },
  });

  const res = await runPremiumChanges({ request: { body: { planId: PLAN_ID }, query: {} }, deps });

  assert.equal(res.status, 500);
  assert.equal(calls.released, 1, "a trava não pode ficar órfã quando o sync falha");
});

test("runPremiumChanges não busca a trava em dry run", async () => {
  let acquired = 0;
  const deps = makeDeps({
    acquireLock: async () => {
      acquired += 1;
      return { acquired: true };
    },
  });

  await runPremiumChanges({ request: { body: { planId: PLAN_ID, dryRun: true }, query: {} }, deps });

  assert.equal(acquired, 0, "dry run não escreve nada, não precisa de trava");
});
