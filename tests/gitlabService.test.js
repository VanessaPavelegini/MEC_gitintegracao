"use strict";

// Testes unitários das funções puras de gitlabService.js:
// normalizeLabel, extractStatusLabel, mapLabelToBucket
//
// Framework: node:test (built-in, Node 18+)

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

// Importa o módulo real (sem mockar nada)
const gitlabService = require(path.join(__dirname, "..", "src", "functions", "gitlab-planner-sync", "gitlabService"));

const { normalizeLabel, extractStatusLabel, mapLabelToBucket } = gitlabService;

// ─── normalizeLabel ───────────────────────────────────────────────────────────

test("normalizeLabel lowercases e trim", () => {
  assert.equal(normalizeLabel("  In Progress  "), "in progress");
});

test("normalizeLabel remove acentuação", () => {
  assert.equal(normalizeLabel("em análise"), "em analise");
  assert.equal(normalizeLabel("Revisão"), "revisao");
  assert.equal(normalizeLabel("Concluído"), "concluido");
  assert.equal(normalizeLabel("Bloqueado"), "bloqueado");
});

test("normalizeLabel trata null/vazio", () => {
  assert.equal(normalizeLabel(null), "");
  assert.equal(normalizeLabel(""), "");
  assert.equal(normalizeLabel(undefined), "");
});

// ─── extractStatusLabel ────────────────────────────────────────────────────────

test("extractStatusLabel retorna null quando vazio", () => {
  assert.equal(extractStatusLabel([]), null);
  assert.equal(extractStatusLabel(null), null);
  assert.equal(extractStatusLabel(undefined), null);
});

test("extractStatusLabel encontra label de status conhecida", () => {
  assert.equal(extractStatusLabel(["In Progress"]), "In Progress");
  assert.equal(extractStatusLabel(["Bug", "In Review", "frontend"]), "In Review");
  assert.equal(extractStatusLabel(["documentation", "Done"]), "Done");
});

test("extractStatusLabel normaliza para encontrar (case/acento)", () => {
  assert.equal(extractStatusLabel(["IN PROGRESS"]), "IN PROGRESS");
  assert.equal(extractStatusLabel(["em análise"]), "em análise");
  assert.equal(extractStatusLabel(["Concluído"]), "Concluído");
});

test("extractStatusLabel retorna null quando não há label de status", () => {
  assert.equal(extractStatusLabel(["Bug", "frontend", "documentation"]), null);
  assert.equal(extractStatusLabel(["random-tag"]), null);
});

// ─── mapLabelToBucket ─────────────────────────────────────────────────────────

test("mapLabelToBucket retorna Backlog como default", () => {
  assert.equal(mapLabelToBucket(null), "Backlog");
  assert.equal(mapLabelToBucket(undefined), "Backlog");
  assert.equal(mapLabelToBucket(""), "Backlog");
  assert.equal(mapLabelToBucket("label-inexistente"), "Backlog");
});

test("mapLabelToBucket agrupa variações como mesmo bucket", () => {
  // In Progress variants
  assert.equal(mapLabelToBucket("In Progress"), "Em Desenvolvimento");
  assert.equal(mapLabelToBucket("in progress"), "Em Desenvolvimento");
  assert.equal(mapLabelToBucket("Em Progresso"), "Em Desenvolvimento");
  assert.equal(mapLabelToBucket("em andamento"), "Em Desenvolvimento");
  assert.equal(mapLabelToBucket("coding"), "Em Desenvolvimento");

  // Done variants
  assert.equal(mapLabelToBucket("Done"), "Pronto");
  assert.equal(mapLabelToBucket("done"), "Pronto");
  assert.equal(mapLabelToBucket("Concluído"), "Pronto");
  assert.equal(mapLabelToBucket("completed"), "Pronto");

  // Blocked variants
  assert.equal(mapLabelToBucket("Blocked"), "Bloqueado");
  assert.equal(mapLabelToBucket("Bloqueado"), "Bloqueado");

  // Review variants
  assert.equal(mapLabelToBucket("In Review"), "Revisão");
  assert.equal(mapLabelToBucket("Review"), "Revisão");
  assert.equal(mapLabelToBucket("Em Revisão"), "Revisão");

  // To Do / Backlog variants
  assert.equal(mapLabelToBucket("To Do"), "Backlog");
  assert.equal(mapLabelToBucket("Backlog"), "Backlog");
  assert.equal(mapLabelToBucket("A Fazer"), "Backlog");

  // Análise variants
  assert.equal(mapLabelToBucket("em análise"), "Análise");
  assert.equal(mapLabelToBucket("Analise"), "Análise");
});
