"use strict";

// Testes unitários da lógica pura do sync Premium (homologação):
//   - buildTaskEntity / buildUpdateEntity (shape da task Premium)
//   - decideAction (create / update / unchanged)
//   - isSkippedByLabels (labels de cancelamento)
//   - toDateOnly / computeFinishDate
//
// Framework: node:test (built-in)

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const premiumDataverse = require(path.join(__dirname, "..", "src", "functions", "gitlab-planner-sync", "premiumDataverse"));
const premiumSync = require(path.join(__dirname, "..", "src", "functions", "gitlab-planner-sync", "premiumSync"));

const PROJECT_ID = "c385351a-e450-4d54-87ed-d54c57794f7b";
const BUCKET_ID = "f704c207-84be-f111-a04d-7c1e520d9f67";

const issue = (over = {}) => ({
  iid: 811,
  title: "HU0564 [Matrícula] - Baixar Matrícula",
  description: "texto da issue",
  state: "opened",
  created_at: "2026-10-08T17:30:55.485Z",
  updated_at: "2026-10-26T20:15:08.369Z",
  due_date: null,
  labels: ["Revisão SETEC"],
  web_url: "https://gitlabbuilder.mec.gov.br/doc-sis/documentacao-novosistec2/-/issues/811",
  ...over,
});

// ─── buildTaskEntity ──────────────────────────────────────────────────────────

test("buildTaskEntity monta o payload da task Premium", () => {
  const entity = premiumDataverse.buildTaskEntity({
    issue: issue(),
    projectId: PROJECT_ID,
    bucketId: BUCKET_ID,
  });

  assert.equal(entity["@odata.type"], "Microsoft.Dynamics.CRM.msdyn_projecttask");
  assert.equal(entity.msdyn_subject, "[#811] HU0564 [Matrícula] - Baixar Matrícula");
  assert.equal(entity.msdyn_description, "texto da issue");
  assert.equal(entity.msdyn_start, "2026-10-08");
  assert.equal(entity.msdyn_finish, "2026-10-15");
  assert.equal(entity.msdyn_progress, 0);
  assert.equal(entity["msdyn_project@odata.bind"], `/msdyn_projects(${PROJECT_ID})`);
  assert.equal(entity["msdyn_projectbucket@odata.bind"], `/msdyn_projectbuckets(${BUCKET_ID})`);
});

test("buildTaskEntity respeita limite de 450 caracteres do assunto (msdyn_subject)", () => {
  const entity = premiumDataverse.buildTaskEntity({
    issue: issue({ title: "x".repeat(900) }),
    projectId: PROJECT_ID,
    bucketId: BUCKET_ID,
  });

  assert.ok(entity.msdyn_subject.length <= 450, `subject tem ${entity.msdyn_subject.length} chars`);
  assert.ok(entity.msdyn_subject.startsWith("[#811] "));
});

test("buildTaskEntity usa due_date quando existe", () => {
  const entity = premiumDataverse.buildTaskEntity({
    issue: issue({ due_date: "2026-11-30" }),
    projectId: PROJECT_ID,
    bucketId: BUCKET_ID,
  });

  assert.equal(entity.msdyn_finish, "2026-11-30");
});

test("buildTaskEntity marca issue fechada com 100% de progresso (razão 1)", () => {
  const entity = premiumDataverse.buildTaskEntity({
    issue: issue({ state: "closed" }),
    projectId: PROJECT_ID,
    bucketId: BUCKET_ID,
  });

  // msdyn_progress é razão 0..1 nesta API: o Dataverse recusa 50 ou 100
  // com "percent outside of bounds on element: ... field: percentComplete".
  assert.equal(entity.msdyn_progress, 1);
});

test("buildTaskEntity não duplica o prefixo [#iid] quando o título já vem prefixado", () => {
  const entity = premiumDataverse.buildTaskEntity({
    issue: issue({ title: "[#811] título já prefixado" }),
    projectId: PROJECT_ID,
    bucketId: BUCKET_ID,
  });

  assert.equal(entity.msdyn_subject, "[#811] título já prefixado");
});

test("buildUpdateEntity inclui o id da task a atualizar", () => {
  const entity = premiumDataverse.buildUpdateEntity({
    issue: issue(),
    projectId: PROJECT_ID,
    bucketId: BUCKET_ID,
    taskId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  });

  assert.equal(entity.msdyn_projecttaskid, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
  assert.equal(entity["msdyn_project@odata.bind"], `/msdyn_projects(${PROJECT_ID})`);
});

test("buildTaskEntity trunca descrição no limite do campo Memo", () => {
  const entity = premiumDataverse.buildTaskEntity({
    issue: issue({ description: "y".repeat(200000) }),
    projectId: PROJECT_ID,
    bucketId: BUCKET_ID,
  });

  // O Dataverse Project recusa a task com o campo "notes" em 100.000
  // caracteres ou mais (limite exclusivo) — por isso 99.000.
  assert.equal(entity.msdyn_description.length, 99000);
  assert.ok(entity.msdyn_description.length < 100000);
});

// ─── decideAction ─────────────────────────────────────────────────────────────

test("decideAction: sem mapping → create", () => {
  assert.equal(premiumSync.decideAction(issue(), null), "create");
});

test("decideAction: mapping sem task id → create", () => {
  const mapping = { pmo_gitlab_iid: 811, pmo_plannertaskid: null, pmo_gitlab_updatedat: "2026-10-26T20:15:08.369Z" };
  assert.equal(premiumSync.decideAction(issue(), mapping), "create");
});

test("decideAction: mapping sem pmo_gitlab_updatedat → update", () => {
  const mapping = { pmo_gitlab_iid: 811, pmo_plannertaskid: "task-guid" };
  assert.equal(premiumSync.decideAction(issue(), mapping), "update");
});

test("decideAction: issue alterada depois do último sync → update", () => {
  const mapping = {
    pmo_gitlab_iid: 811,
    pmo_plannertaskid: "task-guid",
    pmo_gitlab_updatedat: "2026-10-20T00:00:00.000Z",
  };
  assert.equal(premiumSync.decideAction(issue(), mapping), "update");
});

test("decideAction: issue sem alteração → unchanged", () => {
  const mapping = {
    pmo_gitlab_iid: 811,
    pmo_plannertaskid: "task-guid",
    pmo_gitlab_updatedat: "2026-10-26T20:15:08.369Z",
  };
  assert.equal(premiumSync.decideAction(issue(), mapping), "unchanged");
});

test("decideAction sem a coluna pmo_gitlab_updatedat usa pmo_dataultimasincronizacao", () => {
  const mapping = {
    pmo_gitlab_iid: 811,
    pmo_plannertaskid: "task-guid",
    pmo_dataultimasincronizacao: "2026-10-10T00:00:00.000Z",
  };

  assert.equal(
    premiumSync.decideAction({ updated_at: "2026-10-20T10:00:00.000Z" }, mapping, { hasUpdatedAtColumn: false }),
    "update"
  );
  assert.equal(
    premiumSync.decideAction({ updated_at: "2026-10-05T00:00:00.000Z" }, mapping, { hasUpdatedAtColumn: false }),
    "unchanged"
  );
});

test("decideAction sem a coluna nova e sem data de sincronização → update", () => {
  const mapping = { pmo_gitlab_iid: 811, pmo_plannertaskid: "task-guid" };

  assert.equal(
    premiumSync.decideAction({ updated_at: "2026-10-20T10:00:00.000Z" }, mapping, { hasUpdatedAtColumn: false }),
    "update"
  );
});

// ─── isSkippedByLabels ────────────────────────────────────────────────────────

test("isSkippedByLabels: label CANCELADAS (plural) pula a issue", () => {
  assert.equal(premiumSync.isSkippedByLabels(["CANCELADAS"], premiumSync.DEFAULT_SKIP_LABELS), true);
});

test("isSkippedByLabels: label HU cancelada pula a issue", () => {
  assert.equal(premiumSync.isSkippedByLabels(["HU cancelada"], premiumSync.DEFAULT_SKIP_LABELS), true);
});

test("isSkippedByLabels: label de status não pula", () => {
  assert.equal(premiumSync.isSkippedByLabels(["HU homologada", "Revisão SETEC"], premiumSync.DEFAULT_SKIP_LABELS), false);
});

test("isSkippedByLabels: aceita label como objeto (formato do webhook)", () => {
  assert.equal(premiumSync.isSkippedByLabels([{ title: "CANCELADAS" }], premiumSync.DEFAULT_SKIP_LABELS), true);
});

// ─── toDateOnly / computeFinishDate ───────────────────────────────────────────

test("toDateOnly corta a data de um timestamp ISO", () => {
  assert.equal(premiumSync.toDateOnly("2026-10-08T17:30:55.485Z"), "2026-10-08");
});

test("toDateOnly devolve null para valor ausente", () => {
  assert.equal(premiumSync.toDateOnly(null), null);
  assert.equal(premiumSync.toDateOnly(undefined), null);
});

test("computeFinishDate usa due_date; senão start + 7 dias", () => {
  assert.equal(premiumSync.computeFinishDate("2026-10-08", "2026-11-30"), "2026-11-30");
  assert.equal(premiumSync.computeFinishDate("2026-10-08", null), "2026-10-15");
});

// ─── Normalização da descrição (o Planner Premium reescreve o HTML) ────────────

test("descriptionFingerprint ignora o comentário HTML inicial que o Planner descarta", () => {
  const enviado = "<!-- HU0019 - [Instituição] Cadastrar Dependência -->\n\n## História\n\ntexto";
  const gravado = "\n\n## História\n\ntexto";
  assert.equal(premiumSync.descriptionFingerprint(enviado), premiumSync.descriptionFingerprint(gravado));
});

test("descriptionFingerprint ignora a reescrita de entidades", () => {
  const enviado = 'Menu lateral > Administração > Botão "Editar"';
  const gravado = "Menu lateral &gt; Administração &gt; Botão &quot;Editar&quot;";
  assert.equal(premiumSync.descriptionFingerprint(enviado), premiumSync.descriptionFingerprint(gravado));
});

test("decideAction compara o updated_at com precisão de segundo (o Dataverse trunca)", () => {
  const issue = { updated_at: "2026-10-19T18:08:47.258Z" };
  const mapping = { pmo_plannertaskid: "task-1", pmo_gitlab_updatedat: "2026-10-19T18:08:47Z" };
  assert.equal(premiumSync.decideAction(issue, mapping), "unchanged");
});

test("decideAction ainda detecta issue alterada depois do último sync", () => {
  const issue = { updated_at: "2026-10-19T18:08:48.258Z" };
  const mapping = { pmo_plannertaskid: "task-1", pmo_gitlab_updatedat: "2026-10-19T18:08:47Z" };
  assert.equal(premiumSync.decideAction(issue, mapping), "update");
});

test("descriptionFingerprint normaliza os espaços que o Planner vira &nbsp;", () => {
  const enviado = "| 1.0 | 16/07/2024 | Criação do Documento | 1.1 | 27/01/2026 |";
  const gravado = "| 1.0 | 16/07/2024 | Criação do Documento | 1.1&#160;&#160; | 27/01/2026 |";
  assert.equal(premiumSync.descriptionFingerprint(enviado), premiumSync.descriptionFingerprint(gravado));
});

test("descriptionFingerprint distingue conteúdos diferentes", () => {
  assert.notEqual(premiumSync.descriptionFingerprint("história A"), premiumSync.descriptionFingerprint("história B"));
});

test("descriptionFingerprint trata descrição vazia", () => {
  assert.equal(premiumSync.descriptionFingerprint(""), "");
  assert.equal(premiumSync.descriptionFingerprint(undefined), "");
});
