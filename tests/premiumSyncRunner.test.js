"use strict";

// Testes do runner de sync completo (premiumSyncRunner.js) — percorre as
// páginas do GitLab até o cursor acabar, agregando o resultado.

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const premiumSync = require(path.join(__dirname, "..", "src", "functions", "gitlab-planner-sync", "premiumSync"));
const { runFullSync } = require(path.join(__dirname, "..", "src", "functions", "gitlab-planner-sync", "premiumSyncRunner"));

const PLAN_ID = "c0ecce95-1107-4343-8c05-bcf7c9a291f8";
const BUCKET_ID = "be10a1da-0bd2-f111-84dc-7c1e520d9dbb";

// fakeSyncPage: devolve uma página por chamada, com o cursor que o teste
// quiser encadear. Cada página tem contadores próprios.
function fakeSyncPage(pages) {
  const calls = [];
  return {
    calls,
    syncPage: async (args) => {
      calls.push(args);
      const page = pages[calls.length - 1];
      if (!page) throw new Error(`syncPage chamado ${calls.length}x, mas o teste só previu ${pages.length}`);
      return { processed: 10, created: 0, updated: 0, unchanged: 0, skipped: 0, errors: [], ...page };
    },
  };
}

test("runFullSync percorre as páginas até o cursor acabar", async () => {
  const gitlab = fakeSyncPage([
    { nextCursor: premiumSync.encodeCursor(2, "opened") },
    { nextCursor: premiumSync.encodeCursor(1, "closed") },
    { nextCursor: null },
  ]);

  const result = await runFullSync({
    syncPage: gitlab.syncPage,
    planId: PLAN_ID, bucketId: BUCKET_ID, token: "tok", prdToken: "prd-tok",
  });

  assert.equal(gitlab.calls.length, 3, "as três páginas do teste precisam ser percorridas");
  assert.equal(gitlab.calls[0].page, 1);
  assert.equal(gitlab.calls[0].phase, "opened");
  assert.equal(gitlab.calls[1].page, 2);
  assert.equal(gitlab.calls[1].phase, "opened");
  assert.equal(gitlab.calls[2].page, 1);
  assert.equal(gitlab.calls[2].phase, "closed");
  assert.equal(result.nextCursor, null);
});

test("runFullSync soma os contadores de todas as páginas", async () => {
  const gitlab = fakeSyncPage([
    { processed: 10, created: 2, updated: 3, unchanged: 5, skipped: 0, nextCursor: premiumSync.encodeCursor(2, "opened") },
    { processed: 10, created: 1, updated: 4, unchanged: 4, skipped: 1, nextCursor: null },
  ]);

  const result = await runFullSync({
    syncPage: gitlab.syncPage,
    planId: PLAN_ID, bucketId: BUCKET_ID, token: "tok", prdToken: "prd-tok",
  });

  assert.equal(result.processed, 20);
  assert.equal(result.created, 3);
  assert.equal(result.updated, 7);
  assert.equal(result.unchanged, 9);
  assert.equal(result.skipped, 1);
  assert.equal(result.pages, 2);
});

test("runFullSync junta os erros de todas as páginas", async () => {
  const gitlab = fakeSyncPage([
    { errors: [{ iid: 1, message: "falhou" }], nextCursor: premiumSync.encodeCursor(2, "opened") },
    { errors: [{ iid: 2, message: "falhou também" }], nextCursor: null },
  ]);

  const result = await runFullSync({
    syncPage: gitlab.syncPage,
    planId: PLAN_ID, bucketId: BUCKET_ID, token: "tok", prdToken: "prd-tok",
  });

  assert.equal(result.errors.length, 2);
  assert.equal(result.errors[0].iid, 1);
  assert.equal(result.errors[1].iid, 2);
});

test("runFullSync devolve o cursor quando o número de páginas é estourado", async () => {
  // Cursor que nunca acaba: sem teto, o runner nunca termina.
  const endless = premiumSync.encodeCursor(2, "opened");
  const gitlab = fakeSyncPage(Array.from({ length: 10 }, () => ({ nextCursor: endless })));

  const result = await runFullSync({
    syncPage: gitlab.syncPage,
    planId: PLAN_ID, bucketId: BUCKET_ID, token: "tok", prdToken: "prd-tok",
    maxPages: 3,
  });

  assert.equal(gitlab.calls.length, 3, "o runner para no teto de páginas");
  assert.equal(result.pages, 3);
  assert.equal(result.nextCursor, endless, "o cursor pendente é devolvido para a próxima rodada");
  assert.equal(result.truncated, true);
});

test("runFullSync propaga o erro quando uma página falha", async () => {
  const gitlab = fakeSyncPage([
    { nextCursor: premiumSync.encodeCursor(2, "opened") },
    null,
  ]);
  let n = 0;
  const failing = async (args) => {
    n += 1;
    if (n === 2) throw new Error("gitlab fora do ar");
    return gitlab.syncPage(args);
  };

  await assert.rejects(
    () => runFullSync({
      syncPage: failing,
      planId: PLAN_ID, bucketId: BUCKET_ID, token: "tok", prdToken: "prd-tok",
    }),
    /gitlab fora do ar/
  );
});

test("runFullSync repassa dryRun, pageSize e token para cada página", async () => {
  const gitlab = fakeSyncPage([{ nextCursor: null }]);

  await runFullSync({
    syncPage: gitlab.syncPage,
    planId: PLAN_ID, bucketId: BUCKET_ID, token: "tok", prdToken: "prd-tok",
    dryRun: true, pageSize: 50,
  });

  assert.equal(gitlab.calls[0].dryRun, true);
  assert.equal(gitlab.calls[0].pageSize, 50);
  assert.equal(gitlab.calls[0].token, "tok");
  assert.equal(gitlab.calls[0].prdToken, "prd-tok");
  assert.equal(gitlab.calls[0].includeClosed, true);
});
