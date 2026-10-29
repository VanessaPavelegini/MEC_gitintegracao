"use strict";

// Detector de mudanças do GitLab para o sync do Planner Premium.
//
// A varredura COMPLETA (811 issues, 9 páginas) é cara e desnecessária para
// a pergunta que importa: "o que o usuário mudou no GitLab desde a última
// vez?". O GitLab tem filtro para isso (updated_after) — em 24h ele devolve
// 18 issues contra 811 do total.
//
// A janela (updated_after) é o filtro do lado do GitLab; o diff por issue é o
// filtro do lado do Planner. Os dois são necessários:
//
//   - A janela reduz o tráfego, mas é uma janela: uma issue alterada ANTES
//     dela nunca aparece, mesmo que o sync não tenha rodado.
//   - O diff (issue.updated_at contra o pmo_gitlab_updatedat gravado no
//     mapping) é o que garante a correção: só entra na fila o que de fato
//     mudou, e o que já estava sincronizado não é reescrito.
//
// Por isso o detector não confia na janela sozinha: a issue volta como
// "unchanged" se o mapping já registra o mesmo updated_at.

const DEFAULT_LOOKBACK_MINUTES = 24 * 60;

// A regra "isto mudou?" já existe e está testada em premiumSync.decideAction.
// Reusá-la aqui evita duas versões da mesma comparação divergindo — foi
// exatamente o que causou o descasamento de precisão de segundo.
const { decideAction } = require("./premiumSync");

/**
 * Lê a janela pedida. Valores inválidos caem no padrão — uma janela mal
 * formada não pode fazer o sync varrer o projeto inteiro sem querer.
 *
 * @param {object} params
 * @returns {{lookbackMinutes: number, since: Date}}
 */
function parseWindow(params = {}) {
  const raw = Number(params.lookbackMinutes);
  const lookbackMinutes =
    Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_LOOKBACK_MINUTES;
  return {
    lookbackMinutes,
    since: new Date(Date.now() - lookbackMinutes * 60 * 1000),
  };
}

/**
 * Junta duas janelas: a varredura seguinte tem de começar onde a anterior
 * parou (e um pouco antes, para cobrir o que aconteceu durante a execução).
 *
 * @returns {{since: Date, lookbackMinutes: number}}
 */
function mergeWindows(a, b) {
  const since = new Date(Math.min(a?.since?.getTime?.() ?? Infinity, b?.since?.getTime?.() ?? Infinity));
  const lookbackMinutes = Math.max(a?.lookbackMinutes ?? 0, b?.lookbackMinutes ?? 0);
  return { since, lookbackMinutes };
}

/**
 * Compara a issue com o mapping gravado e separa as que mudaram.
 *
 * @param {object}   args
 * @param {Array}    args.issues     issues do GitLab (já filtradas pela janela)
 * @param {Array}    args.mappings   mappings do plano (pmo_gitlab_iid, pmo_gitlab_updatedat)
 * @param {string}   args.planId     plano a que o diff se refere
 * @returns {{changed: Array, unchanged: Array}}
 */
function diffIssues({ issues = [], mappings = [], planId } = {}) {
  const byIid = new Map();
  for (const m of mappings || []) {
    // Mapping de outro plano não vale: o mesmo iid pode existir em outro
    // plano Premium com timestamps diferentes.
    if (planId && m.pmo_plannerplanid && m.pmo_plannerplanid !== planId) continue;
    byIid.set(Number(m.pmo_gitlab_iid), m);
  }

  const changed = [];
  const unchanged = [];

  for (const issue of issues || []) {
    const mapping = byIid.get(Number(issue.iid));
    // decideAction: "create" (sem task), "update" (mudou) ou "unchanged".
    const action = decideAction(issue, mapping);
    if (action === "unchanged") unchanged.push(issue);
    else changed.push(issue);
  }

  return { changed, unchanged };
}

module.exports = {
  DEFAULT_LOOKBACK_MINUTES,
  parseWindow,
  mergeWindows,
  diffIssues,
};
