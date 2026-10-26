"use strict";

// Testes do cliente Premium (operation sets) — premiumDataverse.js
//
// O fetch HTTP é injetado (limite de rede é a única fronteira inegociável),
// e o resto do módulo roda de verdade.

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const premium = require(path.join(__dirname, "..", "src", "functions", "gitlab-planner-sync", "premiumDataverse"));

const BASE_URL = "https://orgcf194dda.crm.dynamics.com";
const PROJECT_ID = "c385351a-e450-4d54-87ed-d54c57794f7b";

// Fetch falso: registra as chamadas e devolve respostas enfileiradas.
function fakeFetch(responses) {
  const calls = [];
  const queue = [...responses];
  const impl = async (url, options = {}) => {
    calls.push({ url, options, body: options.body ? JSON.parse(options.body) : undefined });
    const next = queue.length > 1 ? queue.shift() : queue[0];
    return {
      status: next.status,
      text: async () => JSON.stringify(next.body),
    };
  };
  impl.calls = calls;
  return impl;
}

test("createOperationSet cria o set e devolve o OperationSetId", async () => {
  const fetchImpl = fakeFetch([{ status: 200, body: { OperationSetId: "set-123" } }]);

  const setId = await premium.createOperationSet({
    projectId: PROJECT_ID,
    description: "sync lote 1",
    token: "tok",
    baseUrl: BASE_URL,
    fetchImpl,
  });

  assert.equal(setId, "set-123");
  const call = fetchImpl.calls[0];
  assert.equal(call.url, `${BASE_URL}/api/data/v9.2/msdyn_CreateOperationSetV1`);
  assert.equal(call.options.method, "POST");
  assert.equal(call.options.headers.Authorization, "Bearer tok");
  assert.deepEqual(call.body, { ProjectId: PROJECT_ID, Description: "sync lote 1" });
});

test("createOperationSet propaga a mensagem de erro do Dataverse", async () => {
  const fetchImpl = fakeFetch([{ status: 400, body: { error: { message: "Project not found" } } }]);

  await assert.rejects(
    () => premium.createOperationSet({ projectId: PROJECT_ID, description: "x", token: "t", baseUrl: BASE_URL, fetchImpl }),
    /Project not found/
  );
});

test("queueCreateTasks enfileira o lote em msdyn_PssCreateV2", async () => {
  const fetchImpl = fakeFetch([{ status: 200, body: { OperationSetResponse: "{}" } }]);
  const entities = [{ msdyn_subject: "[#1] A" }, { msdyn_subject: "[#2] B" }];

  await premium.queueCreateTasks({ operationSetId: "set-1", entities, token: "tok", baseUrl: BASE_URL, fetchImpl });

  const call = fetchImpl.calls[0];
  assert.equal(call.url, `${BASE_URL}/api/data/v9.2/msdyn_PssCreateV2`);
  assert.deepEqual(call.body, { OperationSetId: "set-1", EntityCollection: entities });
});

test("queueUpdateTasks enfileira o lote em msdyn_PssUpdateV2", async () => {
  const fetchImpl = fakeFetch([{ status: 200, body: { OperationSetResponse: "{}" } }]);

  await premium.queueUpdateTasks({
    operationSetId: "set-2",
    entities: [{ msdyn_projecttaskid: "t1", msdyn_subject: "[#1] A" }],
    token: "tok",
    baseUrl: BASE_URL,
    fetchImpl,
  });

  assert.equal(fetchImpl.calls[0].url, `${BASE_URL}/api/data/v9.2/msdyn_PssUpdateV2`);
  assert.equal(fetchImpl.calls[0].body.OperationSetId, "set-2");
});

test("executeOperationSet executa o set", async () => {
  const fetchImpl = fakeFetch([{ status: 200, body: { OperationSetResponse: '{"ok":true}' } }]);

  const result = await premium.executeOperationSet({ operationSetId: "set-3", token: "tok", baseUrl: BASE_URL, fetchImpl });

  assert.equal(fetchImpl.calls[0].url, `${BASE_URL}/api/data/v9.2/msdyn_ExecuteOperationSetV1`);
  assert.deepEqual(fetchImpl.calls[0].body, { OperationSetId: "set-3" });
  assert.equal(result.OperationSetResponse, '{"ok":true}');
});

test("discardOperationSet abandona o set e apaga o registro msdyn_operationsets", async () => {
  const fetchImpl = fakeFetch([
    { status: 200, body: { OperationSetResponse: "{}" } },
    { status: 204, body: {} },
  ]);

  await premium.discardOperationSet({ operationSetId: "set-4", token: "tok", baseUrl: BASE_URL, fetchImpl });

  assert.equal(fetchImpl.calls[0].url, `${BASE_URL}/api/data/v9.2/msdyn_AbandonOperationSetV1`);
  assert.deepEqual(fetchImpl.calls[0].body, { OperationSetId: "set-4" });
  assert.equal(fetchImpl.calls[1].options.method, "DELETE");
  assert.match(fetchImpl.calls[1].url, /msdyn_operationsets\(/);
});

test("discardOperationSet não falha quando o registro do set já não existe", async () => {
  const fetchImpl = fakeFetch([
    { status: 200, body: { OperationSetResponse: "{}" } },
    { status: 404, body: { error: { message: "Not Found" } } },
  ]);

  await premium.discardOperationSet({ operationSetId: "set-5", token: "tok", baseUrl: BASE_URL, fetchImpl });
});

test("listProjectBuckets devolve os buckets do plano", async () => {
  const fetchImpl = fakeFetch([
    {
      status: 200,
      body: {
        value: [
          { msdyn_projectbucketid: "b1", msdyn_name: "Bucket 1" },
          { msdyn_projectbucketid: "b2", msdyn_name: "Bucket 2" },
        ],
      },
    },
  ]);

  const buckets = await premium.listProjectBuckets({
    projectId: PROJECT_ID,
    token: "tok",
    baseUrl: BASE_URL,
    fetchImpl,
  });

  assert.equal(buckets.length, 2);
  assert.equal(buckets[0].id, "b1");
  assert.equal(buckets[0].name, "Bucket 1");
  assert.match(decodeURIComponent(fetchImpl.calls[0].url), new RegExp(PROJECT_ID));
});

test("findTaskIdsBySubjects devolve o mapa assunto → id da task", async () => {
  const fetchImpl = fakeFetch([
    {
      status: 200,
      body: {
        value: [
          { msdyn_subject: "[#811] A", msdyn_projecttaskid: "id-811" },
          { msdyn_subject: "[#812] B", msdyn_projecttaskid: "id-812" },
        ],
      },
    },
  ]);

  const map = await premium.findTaskIdsBySubjects({
    projectId: PROJECT_ID,
    subjects: ["[#811] A"],
    token: "tok",
    baseUrl: BASE_URL,
    fetchImpl,
  });

  assert.equal(map["[#811] A"], "id-811");
  assert.equal(map["[#812] B"], "id-812");
  const url = decodeURIComponent(fetchImpl.calls[0].url);
  assert.match(url, /msdyn_projecttasks/);
  assert.match(url, new RegExp(PROJECT_ID));
});
