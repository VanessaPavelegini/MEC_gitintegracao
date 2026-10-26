"use strict";

// Testes do mapping plan-scoped (Premium) — premiumMapping.js
//
// O fetch HTTP é injetado; o resto roda de verdade.

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const mapping = require(path.join(__dirname, "..", "src", "functions", "gitlab-planner-sync", "premiumMapping"));

const PRD_URL = "https://org41ecace2.crm2.dynamics.com";
const PLAN_ID = "c385351a-e450-4d54-87ed-d54c57794f7b";
const CLASSIC_PLAN_ID = "hIjg2ZZaY0mWB5gpuJFMZmUABFNv";

function fakeFetch(responses) {
  const calls = [];
  const queue = [...responses];
  const impl = async (url, options = {}) => {
    calls.push({ url, options, body: options.body ? JSON.parse(options.body) : undefined });
    const next = queue.length > 1 ? queue.shift() : queue[0];
    return { status: next.status, text: async () => JSON.stringify(next.body) };
  };
  impl.calls = calls;
  return impl;
}

test("getMappingByPlan filtra por plano E iid (não colide com o plano clássico)", async () => {
  const fetchImpl = fakeFetch([{ status: 200, body: { value: [] } }]);

  await mapping.getMappingByPlan({ baseUrl: PRD_URL, token: "tok", fetchImpl, planId: PLAN_ID, iid: 811 });

  const url = decodeURIComponent(fetchImpl.calls[0].url);
  assert.match(url, /pmo_mapeamentoplanners/);
  assert.match(url, new RegExp(PLAN_ID));
  assert.match(url, /pmo_gitlab_iid eq 811/);
  assert.ok(!url.includes(CLASSIC_PLAN_ID));
});

test("getMappingByPlan devolve o registro quando existe", async () => {
  const fetchImpl = fakeFetch([
    { status: 200, body: { value: [{ pmo_mapeamentoplannerid: "m-1", pmo_gitlab_iid: 811 }] } },
  ]);

  const result = await mapping.getMappingByPlan({ baseUrl: PRD_URL, token: "tok", fetchImpl, planId: PLAN_ID, iid: 811 });

  assert.equal(result.pmo_mapeamentoplannerid, "m-1");
});

test("listMappingsForIids divide a busca em lotes de 50 iids", async () => {
  const fetchImpl = fakeFetch([{ status: 200, body: { value: [] } }]);
  const iids = Array.from({ length: 120 }, (_, i) => i + 1);

  await mapping.listMappingsForIids({ baseUrl: PRD_URL, token: "tok", fetchImpl, planId: PLAN_ID, iids });

  assert.equal(fetchImpl.calls.length, 3); // 50 + 50 + 20
  const urls = fetchImpl.calls.map((c) => decodeURIComponent(c.url));
  assert.match(urls[0], /pmo_gitlab_iid eq 1/);
  assert.match(urls[0], /pmo_gitlab_iid eq 50/);
  assert.ok(!urls[0].includes("eq 51"));
  assert.match(urls[2], /pmo_gitlab_iid eq 120/);
});

test("listMappingsForIids não chama a API quando não há iids", async () => {
  const fetchImpl = fakeFetch([{ status: 200, body: { value: [] } }]);

  const result = await mapping.listMappingsForIids({ baseUrl: PRD_URL, token: "tok", fetchImpl, planId: PLAN_ID, iids: [] });

  assert.deepEqual(result, []);
  assert.equal(fetchImpl.calls.length, 0);
});

test("saveMappingPremium cria o registro quando ainda não existe", async () => {
  const fetchImpl = fakeFetch([
    { status: 200, body: { value: [] } },
    { status: 204, body: { pmo_mapeamentoplannerid: "m-novo" } },
  ]);

  const result = await mapping.saveMappingPremium({
    baseUrl: PRD_URL,
    token: "tok",
    fetchImpl,
    planId: PLAN_ID,
    gitlabIid: 811,
    plannerTaskId: "task-1",
    plannerBucketId: "bucket-1",
    gitlabUpdatedAt: "2026-10-26T20:15:08.369Z",
    hasUpdatedAtColumn: true,
    issueData: { title: "HU0564", description: "desc", labels: ["A"], web_url: "http://x" },
  });

  assert.equal(result.pmo_plannertaskid, "task-1");
  const post = fetchImpl.calls[1];
  assert.equal(post.options.method, "POST");
  assert.equal(post.body.pmo_plannerplanid, PLAN_ID);
  assert.equal(post.body.pmo_gitlab_iid, 811);
  assert.equal(post.body.pmo_gitlab_updatedat, "2026-10-26T20:15:08.369Z");
  assert.equal(post.body.pmo_title, "[#811] HU0564");
});

test("saveMappingPremium atualiza o registro existente via PATCH", async () => {
  const fetchImpl = fakeFetch([
    { status: 200, body: { value: [{ pmo_mapeamentoplannerid: "m-1" }] } },
    { status: 204, body: {} },
  ]);

  await mapping.saveMappingPremium({
    baseUrl: PRD_URL,
    token: "tok",
    fetchImpl,
    planId: PLAN_ID,
    gitlabIid: 811,
    plannerTaskId: "task-1",
    plannerBucketId: "bucket-1",
    gitlabUpdatedAt: "2026-10-26T20:15:08.369Z",
    hasUpdatedAtColumn: true,
    issueData: { title: "HU0564", description: "desc", labels: ["A"], web_url: "http://x" },
  });

  const patch = fetchImpl.calls[1];
  assert.equal(patch.options.method, "PATCH");
  assert.match(patch.url, /pmo_mapeamentoplanners\(m-1\)/);
});

test("saveMappingPremium usa pmo_dataultimasincronizacao quando a coluna updated_at não existe", async () => {
  const fetchImpl = fakeFetch([
    { status: 200, body: { value: [] } },
    { status: 204, body: {} },
  ]);

  await mapping.saveMappingPremium({
    baseUrl: PRD_URL,
    token: "tok",
    fetchImpl,
    planId: PLAN_ID,
    gitlabIid: 811,
    plannerTaskId: "task-1",
    plannerBucketId: "bucket-1",
    gitlabUpdatedAt: "2026-10-26T20:15:08.369Z",
    hasUpdatedAtColumn: false,
    issueData: { title: "HU0564", description: "desc", labels: ["A"], web_url: "http://x" },
  });

  const post = fetchImpl.calls[1];
  assert.equal(post.body.pmo_gitlab_updatedat, undefined);
  assert.ok(post.body.pmo_dataultimasincronizacao);
});

test("hasGitlabUpdatedAtColumn detecta a coluna no schema", async () => {
  const fetchImpl = fakeFetch([
    { status: 200, body: { value: [{ LogicalName: "pmo_gitlab_iid" }, { LogicalName: "pmo_gitlab_updatedat" }] } },
  ]);

  const has = await mapping.hasGitlabUpdatedAtColumn({ baseUrl: PRD_URL, token: "tok", fetchImpl });

  assert.equal(has, true);
  assert.match(decodeURIComponent(fetchImpl.calls[0].url), /pmo_mapeamentoplanner'\)\/Attributes/);
});
