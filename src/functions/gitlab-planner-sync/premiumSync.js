"use strict";

// Orquestração do sync GitLab → Planner Premium (plano "Homologação _NOVO
// SISTEC 2 - Cópia" na org Default).
//
// Este módulo tem duas camadas:
//   1. funções puras (decideAction, isSkippedByLabels, toDateOnly,
//      computeFinishDate) — testáveis sem rede;
//   2. o fluxo do sync (syncPage), que recebe as dependências por injeção
//      (fetcher do GitLab, cliente Premium, tableStorage) para poder ser
//      testado sem ambiente.
//
// O writing no Planner Premium acontece em operation sets (ver
// premiumDataverse.js); o mapping issue→task vive na tabela
// pmo_mapeamentoplanner do Aplicativos PRD.

const { normalizeLabel } = require("./gitlabService");

// ─── Labels que não geram task ────────────────────────────────────────────────
//
// Runding: o conjunto abaixo inclui "canceladas" (plural). No projeto GitLab
// 510 as labels de cancelamento são CANCELADAS (134 issues) e HU cancelada
// (32) — o SKIP_LABELS do handler antigo (syncGitLabPlannerPremium.js) só
// tinha a forma singular, então não pulava nada.

const DEFAULT_SKIP_LABELS = [
  "hu cancelada",
  "hu canceladas",
  "cancelada",
  "canceladas",
  "cancelado",
  "cancelados",
];

// ─── Helpers puros ────────────────────────────────────────────────────────────

/**
 * Extrai o texto de uma label, aceitando string ou objeto
 * ({ title } — formato do webhook do GitLab).
 */
function labelToString(label) {
  if (typeof label === "string") return label;
  if (label && typeof label === "object") return label.title || label.name || "";
  return "";
}

/**
 * True quando a issue tem alguma label de cancelamento.
 */
function isSkippedByLabels(labels, skipLabels = DEFAULT_SKIP_LABELS) {
  if (!Array.isArray(labels) || labels.length === 0) return false;
  const skipSet = new Set((skipLabels || []).map(normalizeLabel));
  return labels.some((label) => skipSet.has(normalizeLabel(labelToString(label))));
}

/**
 * "2026-10-08T17:30:55.485Z" → "2026-10-08" (campos DateOnly do Planner Premium).
 */
function toDateOnly(value) {
  if (!value) return null;
  const str = String(value);
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(str);
  if (match) return match[1];
  const parsed = new Date(str);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

/**
 * Data de fim: due_date do GitLab ou start + 7 dias.
 */
function computeFinishDate(startDate, dueDate) {
  const due = toDateOnly(dueDate);
  if (due) return due;
  const start = startDate || toDateOnly(new Date().toISOString());
  const base = new Date(`${start}T00:00:00Z`);
  base.setUTCDate(base.getUTCDate() + 7);
  return base.toISOString().slice(0, 10);
}

/**
 * Decide o que fazer com a issue frente ao mapping existente.
 *
 *   sem mapping (ou mapping sem task id) → create
 *   mapping sem pmo_gitlab_updatedat     → update (idempotente)
 *   issue.updated_at > último sync       → update
 *   caso contrário                        → unchanged
 */
function decideAction(issue, mapping) {
  if (!mapping || !mapping.pmo_plannertaskid) return "create";

  const lastSync = mapping.pmo_gitlab_updatedat;
  if (!lastSync) return "update";

  const issueUpdated = new Date(issue?.updated_at || 0).getTime();
  const lastSynced = new Date(lastSync).getTime();
  if (Number.isNaN(issueUpdated) || Number.isNaN(lastSynced)) return "update";

  return issueUpdated > lastSynced ? "update" : "unchanged";
}

module.exports = {
  DEFAULT_SKIP_LABELS,
  labelToString,
  isSkippedByLabels,
  toDateOnly,
  computeFinishDate,
  decideAction,
};
