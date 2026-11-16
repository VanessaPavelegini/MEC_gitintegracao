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

// ─── Rótulos ──────────────────────────────────────────────────────────────────
//
// A interface do Planner só mostra a associação que o Project gravou (campo
// _msdyn_pfwcreatedby_value preenchido). Só o operation set grava assim.

// Fetch falso que responde por rota (a ordem das chamadas de rótulo varia).
function routedFetch({ planLabels, rows, setStatus = 192350003 }) {
  const calls = [];
  const impl = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : undefined;
    calls.push({ url, method: options.method, body });
    const reply = (status, b) => ({ status, text: async () => JSON.stringify(b) });
    if (url.includes("/msdyn_projectlabels?")) return reply(200, { value: planLabels });
    if (url.includes("/msdyn_projecttasktolabels?")) return reply(200, { value: rows });
    if (url.endsWith("/msdyn_CreateOperationSetV1")) return reply(200, { OperationSetId: "set-l" });
    if (url.endsWith("/msdyn_PssCreateV2") || url.endsWith("/msdyn_PssDeleteV2")) return reply(200, {});
    if (url.endsWith("/msdyn_ExecuteOperationSetV1")) return reply(200, {});
    if (url.includes("/msdyn_operationsets(set-l)") && options.method === "GET") return reply(200, { msdyn_status: setStatus });
    if (url.includes("/msdyn_operationsets(set-l)") && options.method === "DELETE") return reply(204, null);
    if (url.endsWith("/msdyn_AbandonOperationSetV1")) return reply(200, {});
    throw new Error(`rota inesperada: ${options.method} ${url}`);
  };
  impl.calls = calls;
  return impl;
}

const LABELS = [
  { msdyn_projectlabelid: "l1", msdyn_projectlabeltext: "SPRINT 1" },
  { msdyn_projectlabelid: "l2", msdyn_projectlabeltext: "SPRINT 2" },
  { msdyn_projectlabelid: "l3", msdyn_projectlabeltext: "SPRINT 3" },
];
const visible = (id, label) => ({ msdyn_projecttasktolabelid: id, _msdyn_projectlabelid_value: label, _msdyn_projecttaskid_value: "t1", _msdyn_pfwcreatedby_value: "u1" });
const invisible = (id, label) => ({ ...visible(id, label), _msdyn_pfwcreatedby_value: null });
const sync = (fetchImpl, labels) => premium.synchronizeTaskLabels({
  taskId: "t1", projectId: PROJECT_ID, labels, token: "tok", baseUrl: BASE_URL, fetchImpl, pollDelayMs: 0,
});

test("synchronizeTaskLabels grava o rótulo pelo operation set, um por chamada e sem id", async () => {
  const fetchImpl = routedFetch({ planLabels: LABELS, rows: [] });
  const result = await sync(fetchImpl, ["SPRINT 1", "SPRINT 2", "Apontamentos"]);

  assert.deepEqual(result.applied, ["SPRINT 1", "SPRINT 2"]);
  assert.deepEqual(result.missing, ["Apontamentos"]);
  const creates = fetchImpl.calls.filter((c) => c.url.endsWith("/msdyn_PssCreateV2"));
  assert.equal(creates.length, 2, "um rótulo por chamada: dois sem id na mesma chamada são recusados");
  for (const c of creates) {
    assert.equal(c.body.OperationSetId, "set-l");
    assert.equal(c.body.EntityCollection.length, 1);
    const ent = c.body.EntityCollection[0];
    assert.equal(ent["@odata.type"], "Microsoft.Dynamics.CRM.msdyn_projecttasktolabel");
    assert.equal(ent.msdyn_projecttasktolabelid, undefined, "com id o set fica Pendente para sempre");
    assert.equal(ent["msdyn_ProjectTaskId@odata.bind"], "/msdyn_projecttasks(t1)");
  }
  assert.deepEqual(creates.map((c) => c.body.EntityCollection[0].msdyn_name), ["SPRINT 1", "SPRINT 2"]);
  assert.equal(creates[0].body.EntityCollection[0]["msdyn_ProjectLabelId@odata.bind"], "/msdyn_projectlabels(l1)");
  assert.ok(fetchImpl.calls.some((c) => c.url.endsWith("/msdyn_ExecuteOperationSetV1")));
  // O registro do set só é apagado depois de concluído (apagar antes cancela).
  const del = fetchImpl.calls.findIndex((c) => c.url.includes("/msdyn_operationsets(set-l)") && c.method === "DELETE");
  const poll = fetchImpl.calls.findIndex((c) => c.url.includes("/msdyn_operationsets(set-l)") && c.method === "GET");
  assert.ok(poll >= 0 && del > poll);
});

test("synchronizeTaskLabels não abre set quando a task já está igual ao GitLab", async () => {
  const fetchImpl = routedFetch({ planLabels: LABELS, rows: [visible("a1", "l1")] });
  const result = await sync(fetchImpl, ["SPRINT 1"]);
  assert.deepEqual(result.applied, ["SPRINT 1"]);
  assert.equal(fetchImpl.calls.filter((c) => c.method !== "GET").length, 0);
});

test("synchronizeTaskLabels remove o rótulo visível que não existe no GitLab", async () => {
  const fetchImpl = routedFetch({ planLabels: LABELS, rows: [visible("a1", "l1"), visible("a2", "l2")] });
  const result = await sync(fetchImpl, ["SPRINT 1"]);
  assert.deepEqual(result.removed, ["SPRINT 2"]);
  const deletes = fetchImpl.calls.filter((c) => c.url.endsWith("/msdyn_PssDeleteV2"));
  assert.equal(deletes.length, 1);
  assert.deepEqual(deletes[0].body.EntityCollection, [
    { "@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttasktolabel", msdyn_projecttasktolabelid: "a2" },
  ]);
});

test("synchronizeTaskLabels não toca no registro invisível: ele bloqueia o mesmo par", async () => {
  // Registro gravado pela via antiga: a UI não mostra, nenhuma API apaga e o
  // índice único (task, rótulo) impede gravar de novo o mesmo par.
  const fetchImpl = routedFetch({ planLabels: LABELS, rows: [invisible("x1", "l1"), invisible("x3", "l3")] });
  const result = await sync(fetchImpl, ["SPRINT 1"]);
  assert.deepEqual(result.blocked, ["SPRINT 1"]);
  assert.deepEqual(result.stale, ["SPRINT 3"]);
  assert.deepEqual(result.applied, []);
  assert.equal(fetchImpl.calls.filter((c) => c.method !== "GET").length, 0);
});

test("synchronizeTaskLabels propaga a falha do set", async () => {
  const fetchImpl = routedFetch({ planLabels: LABELS, rows: [], setStatus: 192350004 });
  await assert.rejects(() => sync(fetchImpl, ["SPRINT 1"]), /falhou/);
});

test("listTaskLabelAssociationsForTasks conta só os rótulos visíveis", async () => {
  const fetchImpl = routedFetch({ planLabels: LABELS, rows: [
    visible("a1", "l1"),
    { ...invisible("x2", "l2"), _msdyn_projecttaskid_value: "t2" },
    { ...visible("a3", "l3"), _msdyn_projecttaskid_value: "t2" },
  ] });
  const byTask = await premium.listTaskLabelAssociationsForTasks({ taskIds: ["t1", "t2"], token: "tok", baseUrl: BASE_URL, fetchImpl });
  assert.deepEqual([...byTask.get("t1")], ["l1"]);
  assert.deepEqual([...byTask.get("t2")], ["l3"]);
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
