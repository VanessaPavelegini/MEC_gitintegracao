"use strict";

// Testes do detector de mudanças (premiumChangeDetector.js) — decide o que
// precisa ser sincronizado a partir do que mudou no GitLab.

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const {
  diffIssues,
  parseWindow,
  mergeWindows,
} = require(path.join(__dirname, "..", "src", "functions", "gitlab-planner-sync", "premiumChangeDetector"));

const PLAN_ID = "c0ecce95-1107-4343-8c05-bcf7c9a291f8";

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

test("parseWindow lê a janela do payload da Function", () => {
  const w = parseWindow({ lookbackMinutes: "90" });
  assert.equal(w.lookbackMinutes, 90);
  assert.ok(w.since instanceof Date);
  assert.ok(w.since.getTime() <= Date.now());
});

test("parseWindow usa a janela padrão quando nada é informado", () => {
  const w = parseWindow({});
  assert.equal(w.lookbackMinutes, 24 * 60);
});

test("parseWindow ignora valor inválido e usa o padrão", () => {
  assert.equal(parseWindow({ lookbackMinutes: "abc" }).lookbackMinutes, 24 * 60);
  assert.equal(parseWindow({ lookbackMinutes: -5 }).lookbackMinutes, 24 * 60);
});

test("mergeWindows junta duas janelas e devolve a mais antiga", () => {
  const older = new Date("2026-10-01T00:00:00.000Z");
  const newer = new Date("2026-10-02T00:00:00.000Z");
  const merged = mergeWindows({ since: newer }, { since: older });
  assert.equal(merged.since.getTime(), older.getTime());
});

test("diffIssues marca como alterada a issue whose updated_at é mais novo que o mapping", () => {
  const changed = diffIssues({
    issues: [issue(1, { updated_at: "2026-10-20T10:00:00.000Z" })],
    mappings: [{ pmo_gitlab_iid: 1, pmo_plannertaskid: "task-1", pmo_gitlab_updatedat: "2026-10-10T00:00:00.000Z" }],
    planId: PLAN_ID,
  });

  assert.equal(changed.changed.length, 1);
  assert.equal(changed.changed[0].iid, 1);
  assert.equal(changed.unchanged.length, 0);
});

test("diffIssues não marca issue que não mudou", () => {
  const result = diffIssues({
    issues: [issue(1, { updated_at: "2026-10-20T10:00:00.000Z" })],
    mappings: [{ pmo_gitlab_iid: 1, pmo_plannertaskid: "task-1", pmo_gitlab_updatedat: "2026-10-25T00:00:00.000Z" }],
    planId: PLAN_ID,
  });

  assert.equal(result.changed.length, 0);
  assert.equal(result.unchanged.length, 1);
});

test("diffIssues compara em segundos (o Dataverse grava com precisão de segundo)", () => {
  // 250 ms de diferença não é mudança: o Dataverse trunca para o segundo.
  const result = diffIssues({
    issues: [issue(1, { updated_at: "2026-10-20T10:00:00.250Z" })],
    mappings: [{ pmo_gitlab_iid: 1, pmo_plannertaskid: "task-1", pmo_gitlab_updatedat: "2026-10-20T10:00:00.000Z" }],
    planId: PLAN_ID,
  });

  assert.equal(result.changed.length, 0, "diferença de sub-segundo não é mudança");
});

test("diffIssues considera issue sem mapping como alterada (vai ser criada)", () => {
  const result = diffIssues({
    issues: [issue(1)],
    mappings: [],
    planId: PLAN_ID,
  });

  assert.equal(result.changed.length, 1);
  assert.equal(result.changed[0].iid, 1);
});

test("diffIssues trata mapping sem task como alterada (a task precisa ser criada)", () => {
  const result = diffIssues({
    issues: [issue(1)],
    mappings: [{ pmo_gitlab_iid: 1, pmo_gitlab_updatedat: "2026-10-25T00:00:00.000Z" }],
    planId: PLAN_ID,
  });

  assert.equal(result.changed.length, 1);
});

test("diffIssues só considera mappings do plano pedido", () => {
  const result = diffIssues({
    issues: [issue(1, { updated_at: "2026-10-20T10:00:00.000Z" })],
    mappings: [
      {
        pmo_gitlab_iid: 1,
        pmo_plannertaskid: "task-1",
        pmo_gitlab_updatedat: "2026-10-25T00:00:00.000Z",
        pmo_plannerplanid: "outro-plano",
      },
    ],
    planId: PLAN_ID,
  });

  assert.equal(result.changed.length, 1, "mapping de outro plano não vale para este plano");
});

test("diffIssues separa issues fechadas das abertas", () => {
  const result = diffIssues({
    issues: [
      issue(1, { state: "opened", updated_at: "2026-10-20T10:00:00.000Z" }),
      issue(2, { state: "closed", updated_at: "2026-10-21T10:00:00.000Z" }),
    ],
    mappings: [],
    planId: PLAN_ID,
  });

  assert.equal(result.changed.length, 2);
  assert.deepEqual(result.changed.map((i) => i.iid).sort(), [1, 2]);
});
