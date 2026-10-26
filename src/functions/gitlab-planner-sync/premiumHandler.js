"use strict";

// Handler (lógica) do sync GitLab → Planner Premium (plano de homologação).
//
// Fica separado do arquivo da Azure Function de propósito: aqui a lógica é
// pura e testável (as dependências externas chegam por injeção); o arquivo
// syncGitLabPlannerPremiumHomologacao.js faz só a amarração com o runtime
// do Azure Functions.
//
// Contrato (POST/GET /api/gitlab-planner-premium-homologacao):
//   body/query: { planId, bucketId?, bucketName?, cursor?, pageSize?, state?, labels?, dryRun? }
//   resposta 200: { ok, planId, page, processed, created, updated, unchanged,
//                   skipped, errors[], nextCursor, durationMs }
//   resposta 400: { ok: false, error }
//   resposta 500: { ok: false, error }

const { decodeCursor } = require("./premiumSync");

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
 * @param {object} args.request  { body, query }
 * @param {object} args.deps     { syncPage, getDelegatedToken, getPrdToken, listProjectBuckets, planId, bucketName }
 * @returns {Promise<{status: number, body: object}>}
 */
async function runPremiumSync({ request, deps }) {
  const body = request?.body || {};
  const query = request?.query || {};
  const params = { ...query, ...body };

  const planId = params.planId || deps.planId;
  if (!planId) {
    return {
      status: 400,
      body: { ok: false, error: "Informe o planId (GUID do msdyn_project do plano Premium) — query string ou body." },
    };
  }

  let cursorPage = 1;
  if (params.cursor) {
    try {
      cursorPage = decodeCursor(params.cursor).page;
    } catch (e) {
      return { status: 400, body: { ok: false, error: e.message } };
    }
  }

  const dryRun = toBool(params.dryRun);
  const pageSize = Math.min(Math.max(toNumber(params.pageSize, 100), 1), 100);
  const state = params.state || "opened";
  const labels = params.labels
    ? (Array.isArray(params.labels) ? params.labels : String(params.labels).split(",").map((s) => s.trim()).filter(Boolean))
    : undefined;

  try {
    // O bucket pode vir pronto no request; senão é resolvido pelo nome.
    let bucketId = params.bucketId;
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

    // Em dry run não há escrita: o token delegado (conta de serviço) não é
    //-needed. O token do PRD é necessário nos dois casos (leitura do mapping).
    const prdToken = await deps.getPrdToken();
    const token = dryRun ? null : await deps.getDelegatedToken();

    const result = await deps.syncPage({
      planId,
      bucketId,
      page: cursorPage,
      pageSize,
      state,
      labels,
      dryRun,
      token,
      prdToken,
    });

    return { status: 200, body: { ...result, ok: true, planId, bucketId } };
  } catch (e) {
    return { status: 500, body: { ok: false, error: e?.message || String(e) } };
  }
}

module.exports = { runPremiumSync, toBool, toNumber };
