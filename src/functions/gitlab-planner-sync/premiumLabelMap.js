"use strict";

// De-para dos rótulos do GitLab para as 25 vagas de rótulo do plano Premium.
//
// O plano Premium tem 25 vagas fixas de rótulo (limite do produto) e o GitLab
// usa ~150 rótulos. Aqui eles são unificados nas etapas tradicionais da sprint,
// nos módulos, nos times e em alguns marcadores. O que não tem destino
// (SPRINT nn, pacotes PP - nn / P-nn) aparece só na lista completa das Notas
// da task (buildDescription).
//
// CANCELADAS / HU cancelada não têm vaga: essas issues não geram task.

const PLANNER_LABELS = [
  // Fluxo da sprint
  "Backlog",
  "HU em elaboração",
  "HU homologada",
  "Em desenvolvimento",
  "Desenvolvida",
  "Concluída",
  "Em teste",
  "Aprovada no teste",
  "Com defeito",
  "Em homologação",
  "Homologada",
  "Impedimento",
  // Módulos
  "Instituição",
  "Cursos",
  "Matrícula",
  "Oferta",
  "CNCT",
  // Times
  "CEFET",
  "Time CHILLI",
  "Time PEPPER",
  // Outros
  "Apontamentos",
  "Revisão SETEC",
  "Mantis",
  "Release 1",
  "Em produção",
];

/** minúsculas, sem acento, espaços colapsados */
function normalize(name) {
  return String(name || "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/\s+/g, " ").trim();
}

const RULES = new Map(Object.entries({
  "backlog do produto": "Backlog",
  "hu em elaboracao": "HU em elaboração",
  "hu elaborada": "HU em elaboração",
  "analise realizada": "HU em elaboração",
  "hu homologada": "HU homologada",
  "em desenvolvimento": "Em desenvolvimento",
  "desenvolvimento": "Em desenvolvimento",
  "desenvolvida": "Desenvolvida",
  "feito": "Concluída",
  "em teste": "Em teste",
  "testes": "Em teste",
  "aprovada no teste": "Aprovada no teste",
  "com defeito": "Com defeito",
  "em homologacao": "Em homologação",
  "em homologogacao": "Em homologação",
  "entrega em homologacao": "Em homologação",
  "entrega homologada": "Homologada",
  "impedimento": "Impedimento",
  "dependecia de hu": "Impedimento",
  "dependencia de hu": "Impedimento",
  "instituicao": "Instituição",
  "cursos": "Cursos",
  "matricula": "Matrícula",
  "oferta": "Oferta",
  "cnct": "CNCT",
  "time chilli": "Time CHILLI",
  "time pepper": "Time PEPPER",
  "apontamentos": "Apontamentos",
  "revisao setec": "Revisão SETEC",
  "adequacao - mantis": "Mantis",
  "release1": "Release 1",
  "release 1": "Release 1",
  "em producao": "Em produção",
  "producao": "Em produção",
}));

const CEFET_SUFFIX = /\s*-\s*cefet$/;

/**
 * Converte os rótulos de uma issue do GitLab nos rótulos do plano (sem
 * repetição, na ordem em que aparecem). Aceita string ou { title } / { name }.
 */
function mapGitlabLabels(labels) {
  const out = [];
  const add = (name) => { if (name && !out.includes(name)) out.push(name); };
  for (const label of labels || []) {
    const raw = typeof label === "string" ? label : label?.title || label?.name || "";
    let key = normalize(raw);
    if (!key) continue;
    const isCefet = CEFET_SUFFIX.test(key);
    if (isCefet) key = key.replace(CEFET_SUFFIX, "");
    add(RULES.get(key));
    if (isCefet) add("CEFET");
  }
  return out;
}

// Buckets (colunas do quadro) por etapa da sprint. A issue vai para a etapa
// mais avançada que os rótulos indicam; sem etapa, Backlog.
const BUCKETS = ["Backlog", "Em desenvolvimento", "Em teste", "Em homologação", "Concluído", "Em produção", "Impedimento"];

const BUCKET_RULES = [
  ["Em produção", ["Em produção"]],
  ["Concluído", ["Concluída", "Homologada"]],
  ["Impedimento", ["Impedimento"]],
  ["Em homologação", ["Em homologação", "Aprovada no teste"]],
  ["Em teste", ["Em teste", "Com defeito", "Desenvolvida"]],
  ["Em desenvolvimento", ["Em desenvolvimento"]],
];

function bucketForLabels(labels) {
  const mapped = new Set(mapGitlabLabels(labels));
  for (const [bucket, names] of BUCKET_RULES) {
    if (names.some((name) => mapped.has(name))) return bucket;
  }
  return "Backlog";
}

module.exports = { PLANNER_LABELS, BUCKETS, mapGitlabLabels, bucketForLabels, normalize };
