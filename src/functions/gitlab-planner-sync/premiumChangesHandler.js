"use strict";

// Handler do sync INCREMENTAL do Planner Premium.
//
// A rota de sync completo (/api/gitlab-planner-premium-homologacao) varre as
// 811 issues do projeto em 9 páginas. Isso é o certo para uma carga inicial,
// mas é caro para a pergunta do dia a dia: "o que o usuário mudou no GitLab
// desde a última vez?".
//
// Esta rota responde a essa pergunta com uma janela (updated_after): o GitLab
// devolve só as issues tocadas na janela (18 em 24h, contra 811 no total), e
// o diff por issue (pmo_gitlab_updatedat no mapping) diz quais delas mudaram
// de verdade.
//
// Contrato (POST/GET /api/gitlab-planner-premium-changes):
//   body/query: { planId, bucketId?, lookbackMinutes?, dryRun?, maxPages? }
//   resposta 200: { ok, planId, window, fetched, changed, unchanged,
//                   created, updated, skipped, errors[], durationMs }
//
// Um detalhe importante: a fase de issues FECHADAS continua varrendo todas
// (sem janela). É ela que leva a task a 100% — e um issue fechado há três
// semanas está fora da janela de 24 h, mas a task dele ainda precisa ser
// completada.

const { parseWindow } = require("./premiumChangeDetector");
const { runFullSync } = require("./premiumSyncRunner");

function toBool(value) {
  if (typeof value === "boolean") return value;
  if (value === undefined || value === null || value === "") return false;
  const str = String(value).toLowerCase();
  return str === "true" || str === "1" || str === "yes";
}

function toNumber(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * @param {object} args
 * @param {object} args.request { body, query }
 * @param {object} args.deps    { syncPage, getDelegatedToken, getPrdToken, ... }
 * @returns {Promise<{status: number, body: object}>}
 */
async function runPremiumChanges({ request, deps }) {
  const body = request?.body || {};
  const query = request?.query || {};
  const params = { ...query, ...body };

  const planId = params.planId || deps.planId;
  if (!planId) {
    return {
      status: 400,
      body: { ok: false, error: "Informe o planId (GUID do msdyn_project do plano Premium)." },
    };
  }

  const dryRun = toBool(params.dryRun);
  const lookbackMinutes = toNumber(params.lookbackMinutes, undefined);
  const window = parseWindow({ lookbackMinutes });
  const pageSize = Math.min(Math.max(toNumber(params.pageSize, 100), 1), 100);
  const maxPages = Math.min(Math.max(toNumber(params.maxPages, 50), 1), 200);

  try {
    let bucketId = params.bucketId || deps.bucketId;
    if (!bucketId) {
      const buckets = await deps.listProjectBuckets({ projectId: planId });
      const wanted = (params.bucketName || deps.bucketName || "").toLowerCase();
      const found = (buckets || []).find((b) => (b.name || "").toLowerCase() === wanted);
      if (!found) {
        const available = (buckets || []).map((b) => b.name).join(", ");
        return {
          status: 400,
          body: {
            ok: false,
            error: `Bucket "${params.bucketName || deps.bucketName}" não encontrado no plano ${planId}. Buckets disponíveis: ${available || "(nenhum)"}`,
          },
        };
      }
      bucketId = found.id;
    }

    const prdToken = await deps.getPrdToken();
    const token = dryRun ? null : await deps.getDelegatedToken();

    // Trava de execução: duas varreduras simultâneas podem ver a mesma issue
    // sem mapping e criar DUAS tasks (o mapping só é gravado depois que a
    // task materializa). Com o timer de 30 min + execução manual, a colisão
    // deixa de ser hipotética.
    let lock = null;
    if (deps.acquireLock && !dryRun) {
      lock = await deps.acquireLock({ owner: deps.lockOwner || "sync" });
      if (!lock.acquired) {
        return {
          status: 409,
          body: { ok: false, skipped: true, reason: lock.reason || "outro sync em andamento" },
        };
      }
    }

    try {
      const result = await runFullSync({
        syncPage: (args) => deps.syncPage({ ...args, updatedAfter: window.since.toISOString() }),
        planId,
        bucketId,
        pageSize,
        dryRun,
        token,
        prdToken,
        maxPages,
      });

      return {
        status: 200,
        body: {
          ...result,
          ok: true,
          planId,
          bucketId,
          window: { lookbackMinutes: window.lookbackMinutes, since: window.since.toISOString() },
        },
      };
    } finally {
      if (lock && deps.releaseLock) {
        await deps.releaseLock();
      }
    }
  } catch (e) {
    return { status: 500, body: { ok: false, error: e?.message || String(e) } };
  }
}

module.exports = { runPremiumChanges };
