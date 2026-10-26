"use strict";

// Testes da orquestração do sync (syncPage) — premiumSync.js
//
// Todas as dependências externas (GitLab, Premium, mapping) são injetadas
// como fakes; o fluxo de decisão, escrita e contadores roda de verdade.

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const premiumSync = require(path.join(__dirname, "..", "src", "functions", "gitlab-planner-sync", "premiumSync"));

const PLAN_ID = "c385351a-e450-4d54-87ed-d54c57794f7b";
const BUCKET_ID = "f704c207-84be-f111-a04d-7c1e520d9f67";

const issue = (iid, over = {}) => ({
  iid,
  title: `Issue ${iid}`,
  description: "desc",
  state: "opened",
  created_at: "2026-10-01T10:00:00.000Z",
  updated_at: "2026-10-20T10:00:00.000Z",
  due_date: null,
  labels: ["Doing"],
  web_url: `http://gitlab/${iid}`,
  ...over,
});

// Fakes -----------------------------------------------------------------------

function fakeGitLab(items, nextPage = null) {
  const calls = [];
  return {
    calls,
    listIssuesPage: async (filters) => {
      calls.push(filters);
      return { items, nextPage };
    },
  };
}

function fakeMapping(existing = []) {
  const saved = [];
  return {
    saved,
    listMappingsForIids: async ({ iids }) => existing.filter((m) => iids.includes(m.pmo_gitlab_iid)),
    saveMappingPremium: async (args) => {
      saved.push(args);
      return { pmo_mapeamentoplannerid: `m-${args.gitlabIid}` };
    },
    hasGitlabUpdatedAtColumn: async () => true,
  };
}

function fakePremium(taskIds = {}, existingSubjects = {}) {
  const calls = [];
  let setSeq = 0;
  return {
    calls,
    createOperationSet: async ({ description }) => {
      setSeq += 1;
      calls.push({ op: "createSet", description });
      return `set-${setSeq}`;
    },
    queueCreateTasks: async ({ operationSetId, entities }) => {
      calls.push({ op: "queueCreate", operationSetId, entities });
    },
    queueUpdateTasks: async ({ operationSetId, entities }) => {
      calls.push({ op: "queueUpdate", operationSetId, entities });
    },
    executeOperationSet: async ({ operationSetId }) => {
      calls.push({ op: "execute", operationSetId });
    },
    discardOperationSet: async ({ operationSetId }) => {
      calls.push({ op: "discard", operationSetId });
    },
    // onlyExisting = consulta ANTES de criar (o que já existe no plano);
    // sem o flag = lookup depois de criar (id da task recém-criada).
    findTaskIdsBySubjects: async ({ subjects, onlyExisting }) => {
      const map = {};
      if (onlyExisting) {
        for (const s of subjects) if (existingSubjects[s]) map[s] = existingSubjects[s];
        return map;
      }
      for (const s of subjects) map[s] = taskIds[s] || `task-for-${s}`;
      return map;
    },
  };
}

// ─── Cursor ───────────────────────────────────────────────────────────────────

test("encodeCursor/decodeCursor fazem round-trip", () => {
  const cursor = premiumSync.encodeCursor(3);
  assert.equal(premiumSync.decodeCursor(cursor).page, 3);
  assert.equal(premiumSync.decodeCursor(null).page, 1);
  assert.throws(() => premiumSync.decodeCursor("lixo"), /cursor/i);
});

// ─── dry run ──────────────────────────────────────────────────────────────────

test("syncPage em dry run devolve o diff sem escrever nada", async () => {
  const gitlab = fakeGitLab([issue(1), issue(2)]);
  const mapping = fakeMapping([]);
  const premium = fakePremium();

  const result = await premiumSync.syncPage({
    planId: PLAN_ID,
    bucketId: BUCKET_ID,
    page: 1,
    pageSize: 100,
    dryRun: true,
    gitlab,
    mapping,
    premium,
    token: "tok",
    prdToken: "prd-tok",
    orgUrl: "https://org.crm.dynamics.com",
    prdBaseUrl: "https://prd.crm.dynamics.com",
  });

  assert.equal(result.ok, true);
  assert.equal(result.processed, 2);
  assert.equal(result.created, 2);
  assert.equal(result.updated, 0);
  assert.equal(result.unchanged, 0);
  assert.equal(result.skipped, 0);
  assert.equal(result.nextCursor, null);
  assert.equal(premium.calls.length, 0);
  assert.equal(mapping.saved.length, 0);
});

// ─── criação ─────────────────────────────────────────────────────────────────

test("syncPage cria tasks para issues sem mapping e grava o mapping com o id da task", async () => {
  const gitlab = fakeGitLab([issue(1), issue(2)]);
  const mapping = fakeMapping([]);
  const premium = fakePremium({ "[#1] Issue 1": "task-1", "[#2] Issue 2": "task-2" });

  const result = await premiumSync.syncPage({
    planId: PLAN_ID,
    bucketId: BUCKET_ID,
    page: 1,
    pageSize: 100,
    gitlab,
    mapping,
    premium,
    token: "tok",
    prdToken: "prd-tok",
    orgUrl: "https://org.crm.dynamics.com",
    prdBaseUrl: "https://prd.crm.dynamics.com",
  });

  assert.equal(result.created, 2);
  assert.equal(result.updated, 0);

  const sets = premium.calls.filter((c) => c.op === "createSet");
  assert.equal(sets.length, 1);
  const queued = premium.calls.find((c) => c.op === "queueCreate");
  assert.equal(queued.entities.length, 2);
  assert.equal(queued.entities[0].msdyn_subject, "[#1] Issue 1");
  assert.ok(premium.calls.some((c) => c.op === "execute"));
  assert.ok(premium.calls.some((c) => c.op === "discard"));

  assert.equal(mapping.saved.length, 2);
  assert.equal(mapping.saved[0].gitlabIid, 1);
  assert.equal(mapping.saved[0].plannerTaskId, "task-1");
  assert.equal(mapping.saved[0].gitlabUpdatedAt, "2026-10-20T10:00:00.000Z");
  assert.equal(mapping.saved[0].planId, PLAN_ID);
});

test("syncPage atualiza task existente quando a issue mudou", async () => {
  const gitlab = fakeGitLab([issue(1)]);
  const mapping = fakeMapping([
    { pmo_gitlab_iid: 1, pmo_plannertaskid: "task-1", pmo_gitlab_updatedat: "2026-10-10T00:00:00.000Z" },
  ]);
  const premium = fakePremium();

  const result = await premiumSync.syncPage({
    planId: PLAN_ID, bucketId: BUCKET_ID, page: 1, pageSize: 100,
    gitlab, mapping, premium, token: "tok", prdToken: "prd-tok",
    orgUrl: "https://org.crm.dynamics.com", prdBaseUrl: "https://prd.crm.dynamics.com",
  });

  assert.equal(result.updated, 1);
  assert.equal(result.created, 0);
  const queued = premium.calls.find((c) => c.op === "queueUpdate");
  assert.equal(queued.entities[0].msdyn_projecttaskid, "task-1");
  assert.equal(mapping.saved[0].plannerTaskId, "task-1");
});

test("syncPage não toca em task cuja issue não mudou", async () => {
  const gitlab = fakeGitLab([issue(1)]);
  const mapping = fakeMapping([
    { pmo_gitlab_iid: 1, pmo_plannertaskid: "task-1", pmo_gitlab_updatedat: "2026-10-25T00:00:00.000Z" },
  ]);
  const premium = fakePremium();

  const result = await premiumSync.syncPage({
    planId: PLAN_ID, bucketId: BUCKET_ID, page: 1, pageSize: 100,
    gitlab, mapping, premium, token: "tok", prdToken: "prd-tok",
    orgUrl: "https://org.crm.dynamics.com", prdBaseUrl: "https://prd.crm.dynamics.com",
  });

  assert.equal(result.unchanged, 1);
  assert.equal(premium.calls.length, 0);
  assert.equal(mapping.saved.length, 0);
});

test("syncPage pula issue com label de cancelamento", async () => {
  const gitlab = fakeGitLab([issue(1, { labels: ["CANCELADAS"] }), issue(2)]);
  const mapping = fakeMapping([]);
  const premium = fakePremium();

  const result = await premiumSync.syncPage({
    planId: PLAN_ID, bucketId: BUCKET_ID, page: 1, pageSize: 100,
    gitlab, mapping, premium, token: "tok", prdToken: "prd-tok",
    orgUrl: "https://org.crm.dynamics.com", prdBaseUrl: "https://prd.crm.dynamics.com",
  });

  assert.equal(result.skipped, 1);
  assert.equal(result.created, 1);
  assert.equal(mapping.saved.length, 1);
  assert.equal(mapping.saved[0].gitlabIid, 2);
});

test("syncPage fatia a criação em lotes de 100 (operation sets)", async () => {
  const items = Array.from({ length: 150 }, (_, i) => issue(i + 1));
  const gitlab = fakeGitLab(items);
  const mapping = fakeMapping([]);
  const premium = fakePremium();

  const result = await premiumSync.syncPage({
    planId: PLAN_ID, bucketId: BUCKET_ID, page: 1, pageSize: 200,
    gitlab, mapping, premium, token: "tok", prdToken: "prd-tok",
    orgUrl: "https://org.crm.dynamics.com", prdBaseUrl: "https://prd.crm.dynamics.com",
  });

  const sets = premium.calls.filter((c) => c.op === "createSet");
  assert.equal(sets.length, 2);
  const queued = premium.calls.filter((c) => c.op === "queueCreate");
  assert.equal(queued[0].entities.length, 100);
  assert.equal(queued[1].entities.length, 50);
  assert.equal(result.created, 150);
});

test("syncPage registra erro de uma issue sem derrubar o lote", async () => {
  const gitlab = fakeGitLab([issue(1), issue(2)]);
  const mapping = fakeMapping([]);
  mapping.saveMappingPremium = async (args) => {
    if (args.gitlabIid === 1) throw new Error("Dataverse fora do ar");
    return { pmo_mapeamentoplannerid: `m-${args.gitlabIid}` };
  };
  const premium = fakePremium();

  const result = await premiumSync.syncPage({
    planId: PLAN_ID, bucketId: BUCKET_ID, page: 1, pageSize: 100,
    gitlab, mapping, premium, token: "tok", prdToken: "prd-tok",
    orgUrl: "https://org.crm.dynamics.com", prdBaseUrl: "https://prd.crm.dynamics.com",
  });

  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].iid, 1);
  assert.match(result.errors[0].message, /Dataverse fora do ar/);
  assert.equal(result.created, 2);
});

test("syncPage devolve nextCursor quando há próxima página no GitLab", async () => {
  const gitlab = fakeGitLab([issue(1)], 2);
  const mapping = fakeMapping([]);
  const premium = fakePremium();

  const result = await premiumSync.syncPage({
    planId: PLAN_ID, bucketId: BUCKET_ID, page: 1, pageSize: 100,
    gitlab, mapping, premium, token: "tok", prdToken: "prd-tok",
    orgUrl: "https://org.crm.dynamics.com", prdBaseUrl: "https://prd.crm.dynamics.com",
  });

  assert.notEqual(result.nextCursor, null);
  assert.equal(premiumSync.decodeCursor(result.nextCursor).page, 2);
});

// ─── Fase de issues fechadas (task vai a 100%) ────────────────────────────────

test("encodeCursor/decodeCursor preservam a fase", () => {
  const cursor = premiumSync.encodeCursor(2, "closed");
  const decoded = premiumSync.decodeCursor(cursor);
  assert.equal(decoded.page, 2);
  assert.equal(decoded.phase, "closed");
  assert.equal(premiumSync.decodeCursor(null).phase, "opened");
});

test("syncPage na fase fechada atualiza a task existente com 100% de progresso", async () => {
  const gitlab = fakeGitLab([issue(1, { state: "closed", updated_at: "2026-10-26T09:00:00.000Z" })]);
  const mapping = fakeMapping([
    { pmo_gitlab_iid: 1, pmo_plannertaskid: "task-1", pmo_gitlab_updatedat: "2026-10-20T00:00:00.000Z" },
  ]);
  const premium = fakePremium();

  const result = await premiumSync.syncPage({
    planId: PLAN_ID, bucketId: BUCKET_ID, page: 1, pageSize: 100, phase: "closed",
    gitlab, mapping, premium, token: "tok", prdToken: "prd-tok",
    orgUrl: "https://org.crm.dynamics.com", prdBaseUrl: "https://prd.crm.dynamics.com",
  });

  assert.equal(result.updated, 1);
  assert.equal(result.created, 0);
  assert.equal(gitlab.calls[0].state, "closed");
  const queued = premium.calls.find((c) => c.op === "queueUpdate");
  assert.equal(queued.entities[0].msdyn_progress, 100);
  assert.equal(queued.entities[0].msdyn_projecttaskid, "task-1");
});

test("syncPage na fase fechada não cria task para issue sem mapping", async () => {
  const gitlab = fakeGitLab([issue(2, { state: "closed" })]);
  const mapping = fakeMapping([]);
  const premium = fakePremium();

  const result = await premiumSync.syncPage({
    planId: PLAN_ID, bucketId: BUCKET_ID, page: 1, pageSize: 100, phase: "closed",
    gitlab, mapping, premium, token: "tok", prdToken: "prd-tok",
    orgUrl: "https://org.crm.dynamics.com", prdBaseUrl: "https://prd.crm.dynamics.com",
  });

  assert.equal(result.created, 0);
  assert.equal(result.updated, 0);
  assert.equal(result.skipped, 1);
  assert.equal(premium.calls.length, 0);
  assert.equal(mapping.saved.length, 0);
});

test("syncPage encerra a fase aberta e devolve o cursor da fase fechada", async () => {
  const gitlab = fakeGitLab([issue(1)]);
  const mapping = fakeMapping([]);
  const premium = fakePremium();

  const result = await premiumSync.syncPage({
    planId: PLAN_ID, bucketId: BUCKET_ID, page: 1, pageSize: 100, includeClosed: true,
    gitlab, mapping, premium, token: "tok", prdToken: "prd-tok",
    orgUrl: "https://org.crm.dynamics.com", prdBaseUrl: "https://prd.crm.dynamics.com",
  });

  const decoded = premiumSync.decodeCursor(result.nextCursor);
  assert.equal(decoded.page, 1);
  assert.equal(decoded.phase, "closed");
});

test("syncPage na fase fechada devolve cursor da própria fase quando há próxima página", async () => {
  const gitlab = fakeGitLab([issue(1, { state: "closed" })], 2);
  const mapping = fakeMapping([]);
  const premium = fakePremium();

  const result = await premiumSync.syncPage({
    planId: PLAN_ID, bucketId: BUCKET_ID, page: 1, pageSize: 100, phase: "closed", includeClosed: true,
    gitlab, mapping, premium, token: "tok", prdToken: "prd-tok",
    orgUrl: "https://org.crm.dynamics.com", prdBaseUrl: "https://prd.crm.dynamics.com",
  });

  const decoded = premiumSync.decodeCursor(result.nextCursor);
  assert.equal(decoded.page, 2);
  assert.equal(decoded.phase, "closed");
});

test("syncPage na fase fechada não aplica o filtro de label de cancelamento", async () => {
  const gitlab = fakeGitLab([issue(1, { state: "closed", labels: ["CANCELADAS"] })]);
  const mapping = fakeMapping([
    { pmo_gitlab_iid: 1, pmo_plannertaskid: "task-1", pmo_gitlab_updatedat: "2026-10-20T00:00:00.000Z" },
  ]);
  const premium = fakePremium();

  const result = await premiumSync.syncPage({
    planId: PLAN_ID, bucketId: BUCKET_ID, page: 1, pageSize: 100, phase: "closed",
    gitlab, mapping, premium, token: "tok", prdToken: "prd-tok",
    orgUrl: "https://org.crm.dynamics.com", prdBaseUrl: "https://prd.crm.dynamics.com",
  });

  assert.equal(result.updated, 1);
  assert.equal(result.skipped, 0);
});

test("syncPage adota task existente com o mesmo assunto em vez de criar duplicata", async () => {
  const gitlab = fakeGitLab([issue(1), issue(2)]);
  const mapping = fakeMapping([]);
  const premium = fakePremium({}, { "[#1] Issue 1": "task-orfa" });

  const result = await premiumSync.syncPage({
    planId: PLAN_ID, bucketId: BUCKET_ID, page: 1, pageSize: 100,
    gitlab, mapping, premium, token: "tok", prdToken: "prd-tok",
    orgUrl: "https://org.crm.dynamics.com", prdBaseUrl: "https://prd.crm.dynamics.com",
  });

  assert.equal(result.created, 2);

  const created = premium.calls.filter((c) => c.op === "queueCreate");
  assert.equal(created.length, 1);
  assert.equal(created[0].entities.length, 1);
  assert.equal(created[0].entities[0].msdyn_subject, "[#2] Issue 2");

  const updated = premium.calls.find((c) => c.op === "queueUpdate");
  assert.ok(updated, "a task orfa deve ser atualizada com o conteudo atual");
  assert.equal(updated.entities[0].msdyn_projecttaskid, "task-orfa");

  assert.equal(mapping.saved.length, 2);
  const orfa = mapping.saved.find((s) => s.gitlabIid === 1);
  assert.equal(orfa.plannerTaskId, "task-orfa");
});
