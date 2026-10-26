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
