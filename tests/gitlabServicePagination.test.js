"use strict";

// Testes de listIssuesPage (paginação com nextPage) — gitlabService.js

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const gitlabService = require(path.join(__dirname, "..", "src", "functions", "gitlab-planner-sync", "gitlabService"));

test("listIssuesPage devolve items e a próxima página vindos dos headers do GitLab", async () => {
  const calls = [];
  const fakeClient = {
    get: async (url, config) => {
      calls.push({ url, config });
      return {
        data: [{ iid: 1 }, { iid: 2 }],
        headers: { "x-next-page": "3", "x-total-pages": "145", "x-total": "722" },
      };
    },
  };

  const result = await gitlabService.listIssuesPage(
    { state: "opened", per_page: 100, page: 1, order_by: "created_at", sort: "asc", projectId: 510 },
    fakeClient
  );

  assert.equal(result.items.length, 2);
  assert.equal(result.nextPage, 3);
  assert.equal(result.totalPages, 145);
  assert.equal(result.total, 722);
  assert.deepEqual(calls[0].config.params, {
    state: "opened",
    per_page: 100,
    page: 1,
    order_by: "created_at",
    sort: "asc",
  });
});

test("listIssuesPage devolve nextPage null quando o GitLab não indica próxima página", async () => {
  const fakeClient = {
    get: async () => ({ data: [{ iid: 1 }], headers: { "x-next-page": "" } }),
  };

  const result = await gitlabService.listIssuesPage({ page: 145 }, fakeClient);

  assert.equal(result.nextPage, null);
});

test("listIssuesPage repassa updated_after e updated_before ao GitLab", async () => {
  const calls = [];
  const fakeClient = {
    get: async (url, config) => {
      calls.push(config);
      return { data: [], headers: { "x-next-page": "" } };
    },
  };

  await gitlabService.listIssuesPage(
    {
      state: "all",
      per_page: 100,
      updatedAfter: "2026-10-28T10:00:00.000Z",
      updatedBefore: "2026-10-28T12:00:00.000Z",
      projectId: 510,
    },
    fakeClient
  );

  assert.equal(calls[0].params.updated_after, "2026-10-28T10:00:00.000Z");
  assert.equal(calls[0].params.updated_before, "2026-10-28T12:00:00.000Z");
  assert.equal(calls[0].params.state, "all");
});

test("listIssuesPage não manda updated_after quando não foi informado", async () => {
  const calls = [];
  const fakeClient = {
    get: async (url, config) => {
      calls.push(config);
      return { data: [], headers: {} };
    },
  };

  await gitlabService.listIssuesPage({ state: "opened", per_page: 100, projectId: 510 }, fakeClient);

  assert.equal("updated_after" in calls[0].params, false);
  assert.equal("updated_before" in calls[0].params, false);
});

test("listIssuesPage repassa o filtro por iids ao GitLab", async () => {
  const calls = [];
  const fakeClient = {
    get: async (url, config) => {
      calls.push(config);
      return { data: [], headers: {} };
    },
  };

  await gitlabService.listIssuesPage({ iids: [781, 802], projectId: 510 }, fakeClient);

  assert.equal(calls[0].params.iids, "781,802");
});
