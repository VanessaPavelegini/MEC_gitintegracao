"use strict";

// De-para dos rótulos do GitLab para as 25 vagas de rótulo do plano Premium.

const test = require("node:test");
const assert = require("node:assert/strict");

const { PLANNER_LABELS, mapGitlabLabels } = require("../src/functions/gitlab-planner-sync/premiumLabelMap");

test("o plano tem exatamente 25 rótulos, sem repetição", () => {
  assert.equal(PLANNER_LABELS.length, 25);
  assert.equal(new Set(PLANNER_LABELS).size, 25);
});

test("todo rótulo de destino do de-para é uma das 25 vagas", () => {
  const all = mapGitlabLabels([
    "BACKLOG DO PRODUTO", "HU em elaboração", "HU homologada", "Em desenvolvimento", "Desenvolvida",
    "FEITO", "TESTES", "Aprovada no teste", "Com Defeito", "EM HOMOLOGAÇÃO", "Entrega homologada",
    "Impedimento", "Instituição", "Cursos", "Matricula", "Oferta", "CNCT", "Time CHILLI", "Time PEPPER",
    "Apontamentos", "Revisão SETEC", "ADEQUAÇÃO - Mantis", "Release1", "Em Produção", "DESENVOLVIMENTO - CEFET",
  ]);
  for (const name of all) assert.ok(PLANNER_LABELS.includes(name), name);
  assert.equal(all.length, 25);
});

test("unifica as variações de homologação em 'Em homologação'", () => {
  assert.deepEqual(mapGitlabLabels(["EM HOMOLOGAÇÃO", "Entrega em homologação"]), ["Em homologação"]);
});

test("rótulo do CEFET vira o status e também o rótulo CEFET", () => {
  assert.deepEqual(mapGitlabLabels(["EM HOMOLOGOGAÇÃO - CEFET"]), ["Em homologação", "CEFET"]);
  assert.deepEqual(mapGitlabLabels(["BACKLOG DO PRODUTO - CEFET"]), ["Backlog", "CEFET"]);
});

test("ignora caixa, acento e espaços extras", () => {
  assert.deepEqual(mapGitlabLabels(["  matrícula ", "instituicao", "com defeito"]), ["Matrícula", "Instituição", "Com defeito"]);
});

test("SPRINT nn e pacotes PP - nn não viram rótulo colorido", () => {
  assert.deepEqual(mapGitlabLabels(["SPRINT 66", "Sprint5", "PP - 08", "P-01"]), []);
});

test("aceita o formato de objeto do webhook ({ title })", () => {
  assert.deepEqual(mapGitlabLabels([{ title: "FEITO" }, { name: "Cursos" }]), ["Concluída", "Cursos"]);
});

test("sem rótulos devolve lista vazia", () => {
  assert.deepEqual(mapGitlabLabels(undefined), []);
  assert.deepEqual(mapGitlabLabels([]), []);
});

const { BUCKETS, bucketForLabels } = require("../src/functions/gitlab-planner-sync/premiumLabelMap");

test("bucket pela etapa mais avançada da issue", () => {
  assert.deepEqual(BUCKETS, ["Backlog", "Em desenvolvimento", "Em teste", "Em homologação", "Concluído", "Em produção", "Impedimento"]);
  assert.equal(bucketForLabels(["Em Produção", "FEITO"]), "Em produção");
  assert.equal(bucketForLabels(["HU homologada", "Entrega homologada", "EM HOMOLOGAÇÃO"]), "Concluído");
  assert.equal(bucketForLabels(["FEITO"]), "Concluído");
  assert.equal(bucketForLabels(["Impedimento", "Em teste"]), "Impedimento");
  assert.equal(bucketForLabels(["Aprovada no teste", "TESTES"]), "Em homologação");
  assert.equal(bucketForLabels(["Com Defeito"]), "Em teste");
  assert.equal(bucketForLabels(["Em desenvolvimento"]), "Em desenvolvimento");
  assert.equal(bucketForLabels(["HU homologada", "SPRINT 66"]), "Backlog");
  assert.equal(bucketForLabels([]), "Backlog");
});
