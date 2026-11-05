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

test("synchronizeTaskLabels aplica o que o plano tem e reporta o que falta", async () => {
  const fetchImpl = fakeFetch([
    { status: 200, body: { value: [{ msdyn_projectlabelid: "l1", msdyn_projectlabeltext: "Known" }] } },
  ]);
  const result = await premium.synchronizeTaskLabels({
    taskId: "t1", projectId: PROJECT_ID, labels: ["Known", "Unknown"], token: "tok", baseUrl: BASE_URL, fetchImpl,
    currentLabelIds: new Set(),
  });
  assert.deepEqual(result.missing, ["Unknown"]);
  assert.deepEqual(result.applied, ["Known"]);
  // O rótulo que o plano tem foi associado; o que falta fica no relatório.
  const escrita = fetchImpl.calls.filter((c) => c.options.method !== "GET");
  assert.equal(escrita.length, 1);
  assert.equal(escrita[0].options.method, "POST");
  assert.match(escrita[0].url, /msdyn_projecttasks\(t1\)\/msdyn_projecttask_projecttasktolabel$/);
  assert.equal(escrita[0].body.msdyn_name, "Known");
  assert.equal(escrita[0].body["msdyn_ProjectLabelId@odata.bind"], `${BASE_URL}/api/data/v9.2/msdyn_projectlabels(l1)`);
});

test("synchronizeTaskLabels reporta o rótulo que só existe no Planner (a remoção é bloqueada)", async () => {
  const fetchImpl = fakeFetch([
    { status: 200, body: { value: [
      { msdyn_projectlabelid: "l1", msdyn_projectlabeltext: "GitLab" },
      { msdyn_projectlabelid: "l2", msdyn_projectlabeltext: "Só no Planner" },
    ] } },
  ]);
  const result = await premium.synchronizeTaskLabels({
    taskId: "t1", projectId: PROJECT_ID, labels: ["GitLab"], token: "tok", baseUrl: BASE_URL, fetchImpl,
    currentLabelIds: new Set(["l2"]),
  });
  assert.deepEqual(result.stale, ["Só no Planner"]);
  // Nada é removido: o Delete de msdyn_projecttasktolabel é bloqueado pela API.
  assert.equal(fetchImpl.calls.filter((c) => c.options.method === "DELETE").length, 0);
});

test("synchronizeTaskLabels associa o rótulo que falta na task", async () => {
  const fetchImpl = fakeFetch([
    { status: 200, body: { value: [
      { msdyn_projectlabelid: "l1", msdyn_projectlabeltext: "Keep" },
      { msdyn_projectlabelid: "l2", msdyn_projectlabeltext: "Add" },
    ] } },
    { status: 204, body: {} },
  ]);
  const result = await premium.synchronizeTaskLabels({
    taskId: "t1", projectId: PROJECT_ID, labels: ["Keep", "Add"], token: "tok", baseUrl: BASE_URL, fetchImpl,
    currentLabelIds: new Set(["l1"]),
  });
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.applied, ["Keep", "Add"]);
  assert.equal(fetchImpl.calls.length, 2);
  assert.equal(fetchImpl.calls[1].options.method, "POST");
  assert.match(fetchImpl.calls[1].url, /msdyn_projecttasks\(t1\)\/msdyn_projecttask_projecttasktolabel$/);
  assert.equal(fetchImpl.calls[1].body.msdyn_name, "Add");
});

test("synchronizeTaskLabels considera aplicado quando o Project grava mas falha na resposta", async () => {
  // O Project cria o registro e devolve 500 ao montar a resposta
  // ("Unable to cast object of type EntityMetadata..."). O vínculo existe.
  const fetchImpl = fakeFetch([
    { status: 200, body: { value: [{ msdyn_projectlabelid: "l1", msdyn_projectlabeltext: "SPRINT 22" }] } },
    { status: 500, body: { error: { message: "Unable to cast object of type EntityMetadata" } } },
    { status: 200, body: { value: [{ _msdyn_projectlabelid_value: "l1" }] } },
  ]);
  const result = await premium.synchronizeTaskLabels({
    taskId: "t1", projectId: PROJECT_ID, labels: ["SPRINT 22"], token: "tok", baseUrl: BASE_URL, fetchImpl,
    currentLabelIds: new Set(),
  });
  assert.deepEqual(result.applied, ["SPRINT 22"]);
  assert.deepEqual(result.missing, []);
});

test("synchronizeTaskLabels propaga o erro quando o vínculo não foi criado", async () => {
  const fetchImpl = fakeFetch([
    { status: 200, body: { value: [{ msdyn_projectlabelid: "l1", msdyn_projectlabeltext: "SPRINT 22" }] } },
    { status: 500, body: { error: { message: "Unable to cast object of type EntityMetadata" } } },
    { status: 200, body: { value: [] } },
  ]);
  await assert.rejects(() => premium.synchronizeTaskLabels({
    taskId: "t1", projectId: PROJECT_ID, labels: ["SPRINT 22"], token: "tok", baseUrl: BASE_URL, fetchImpl,
    currentLabelIds: new Set(),
  }), /Unable to cast/);
});

test("listTaskLabelAssociationsForTasks agrupa as associações por task", async () => {
  const fetchImpl = fakeFetch([
    { status: 200, body: { value: [
      { _msdyn_projectlabelid_value: "l1", _msdyn_projecttaskid_value: "t1" },
      { _msdyn_projectlabelid_value: "l2", _msdyn_projecttaskid_value: "t2" },
    ] } },
  ]);
  const byTask = await premium.listTaskLabelAssociationsForTasks({
    taskIds: ["t1", "t2"], token: "tok", baseUrl: BASE_URL, fetchImpl,
  });
  assert.deepEqual([...byTask.get("t1")], ["l1"]);
  assert.deepEqual([...byTask.get("t2")], ["l2"]);
});

test("synchronizeTaskLabels não remove vínculo quando o GitLab não tem labels", async () => {
  const fetchImpl = fakeFetch([
    { status: 200, body: { value: [{ msdyn_projectlabelid: "l1", msdyn_projectlabeltext: "Extra" }] } },
  ]);
  const result = await premium.synchronizeTaskLabels({
    taskId: "t1", projectId: PROJECT_ID, labels: [], token: "tok", baseUrl: BASE_URL, fetchImpl,
    currentLabelIds: new Set(["l1"]),
  });
  assert.deepEqual(result.stale, ["Extra"]);
  assert.equal(fetchImpl.calls.filter((c) => c.options.method === "DELETE").length, 0);
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
