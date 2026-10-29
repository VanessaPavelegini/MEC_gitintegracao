"use strict";

// Runner do sync completo (GitLab → Planner Premium).
//
// O sync de uma página (premiumSync.syncPage) é o núcleo; este módulo apenas
// o chama em sequência, repassando o cursor até o fim. Serve para os dois
// modos de disparo:
//
//   - HTTP (o flow do Power Automate): a cada chamada o flow repassa o cursor
//     e a Function devolve a próxima página. Cada chamada cabe no timeout de
//     ~230 s do plano Consumption.
//   - Timer (app.timer): uma execução consome TODAS as páginas de uma vez,
//     porque o runtime de timer não tem o timeout de resposta HTTP.
//
// Por isso o runner não fala HTTP: ele recebe a função syncPage por
// injeção e devolve o agregado. Isso mantém o módulo testável sem rede.

const { decodeCursor } = require("./premiumSync");

/**
 * @param {object}   args
 * @param {function} args.syncPage  (args) => Promise<pageResult> — a mesma
 *                                    assinatura de premiumSync.syncPage
 * @param {string}   args.planId
 * @param {string}   args.bucketId
 * @param {number}   [args.pageSize=100]
 * @param {boolean}  [args.dryRun=false]
 * @param {boolean}  [args.includeClosed=true]  incluir a fase de fechadas
 * @param {string}   [args.state="opened"]
 * @param {string}   [args.token]      token delegado (escrita no Premium)
 * @param {string}   [args.prdToken]   token do PRD (leitura do mapping)
 * @param {number}   [args.maxPages=50]  teto de páginas por execução
 * @returns {Promise<object>} agregado das páginas
 */
async function runFullSync({
  syncPage,
  planId,
  bucketId,
  pageSize = 100,
  dryRun = false,
  includeClosed = true,
  state = "opened",
  token,
  prdToken,
  maxPages = 50,
  onPage = null,
}) {
  const startedAt = Date.now();

  const total = {
    ok: true,
    planId,
    bucketId,
    pages: 0,
    processed: 0,
    created: 0,
    updated: 0,
    unchanged: 0,
    skipped: 0,
    errors: [],
    nextCursor: null,
    truncated: false,
    durationMs: 0,
  };

  let cursor = null;

  for (;;) {
    const { page, phase } = decodeCursor(cursor);
    const result = await syncPage({
      planId,
      bucketId,
      page,
      phase,
      pageSize,
      dryRun,
      includeClosed,
      state,
      token,
      prdToken,
    });

    total.pages += 1;
    total.processed += result.processed || 0;
    total.created += result.created || 0;
    total.updated += result.updated || 0;
    total.unchanged += result.unchanged || 0;
    total.skipped += result.skipped || 0;
    for (const err of result.errors || []) {
      total.errors.push(err);
    }

    if (onPage) await onPage(result, total);

    if (!result.nextCursor) {
      total.nextCursor = null;
      break;
    }

    // Teto de páginas: sem ele, um cursor que nunca acaba (GitLab devolvendo
    // sempre a mesma página) deixa a execução presa. O cursor pendente é
    // devolvido para a próxima rodada retomar de onde parou.
    if (total.pages >= maxPages) {
      total.nextCursor = result.nextCursor;
      total.truncated = true;
      break;
    }

    cursor = result.nextCursor;
  }

  total.durationMs = Date.now() - startedAt;
  return total;
}

module.exports = { runFullSync };
