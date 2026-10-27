"use strict";

// Runner LOCAL do sync GitLab → Planner Premium (plano de homologação).
//
// Existe porque o deploy da Function no Azure está bloqueado por RBAC
// (Microsoft.Web/sites/* negado para a conta) — mas a lógica do sync não
// depende do Azure: roda aqui, chamando exatamente o mesmo handler
// (premiumHandler.runPremiumSync) e os mesmos módulos que a Function usa.
//
// A identidade de escrita no Planner Premium:
//   - PREMIUM_TEST_ACCESS_TOKEN  → token pronto (ex.: `az account get-access-token
//                                  --resource https://orgcf194dda.crm.dynamics.com`)
//   - senão                      → refresh token do device code flow (Blob/arquivo)
//
// O token do PRD (org Aplicativos, onde fica o mapping) sai sempre por client
// credentials (app-pnld).
//
// Uso:
//   node scripts/sync-premium-homologacao-local.js --dry-run
//   node scripts/sync-premium-homologacao-local.js
//   node scripts/sync-premium-homologacao-local.js --max-pages 2 --page-size 50
//   node scripts/sync-premium-homologacao-local.js --no-closed

const fs = require("fs");
const path = require("path");

const settings = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "local.settings.json"), "utf8")
);
for (const [k, v] of Object.entries(settings.Values || {})) {
  if (v && process.env[k] === undefined) process.env[k] = v;
}

const gitlabService = require("../src/functions/gitlab-planner-sync/gitlabService");
const premiumDataverse = require("../src/functions/gitlab-planner-sync/premiumDataverse");
const premiumMapping = require("../src/functions/gitlab-planner-sync/premiumMapping");
const premiumSync = require("../src/functions/gitlab-planner-sync/premiumSync");
const tableStorage = require("../src/functions/gitlab-planner-sync/tableStorage");
const { runPremiumSync } = require("../src/functions/gitlab-planner-sync/premiumHandler");
const { getDataverseDelegatedToken } = require("../src/shared/dataverseServiceAccountAuth");

const ORG_URL = process.env.DATAVERSE_URL_PREMIUM || "https://orgcf194dda.crm.dynamics.com";
const PRD_URL = process.env.DATAVERSE_URL;
const PLAN_ID = process.env.PREMIUM_HOMOLOGACAO_PLAN_ID || "c385351a-e450-4d54-87ed-d54c57794f7b";
const BUCKET_ID = process.env.PREMIUM_HOMOLOGACAO_BUCKET_ID || "f704c207-84be-f111-a04d-7c1e520d9f67";

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const valueOf = (flag, fallback) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const DRY_RUN = has("--dry-run");
const PAGE_SIZE = Number(valueOf("--page-size", 100));
const MAX_PAGES = Number(valueOf("--max-pages", 50));
const INCLUDE_CLOSED = !has("--no-closed");

const gitlab = { listIssuesPage: (filters) => gitlabService.listIssuesPage(filters) };

const deps = {
  planId: PLAN_ID,
  bucketId: BUCKET_ID,
  bucketName: process.env.PREMIUM_HOMOLOGACAO_BUCKET_NAME || "Bucket 1",
  syncPage: (args) =>
    premiumSync.syncPage({
      ...args,
      gitlab,
      mapping: premiumMapping,
      premium: premiumDataverse,
      orgUrl: ORG_URL,
      prdBaseUrl: PRD_URL,
    }),
  getDelegatedToken: () =>
    process.env.PREMIUM_TEST_ACCESS_TOKEN
      ? Promise.resolve(process.env.PREMIUM_TEST_ACCESS_TOKEN)
      : getDataverseDelegatedToken({ orgUrl: ORG_URL }),
  getPrdToken: () => tableStorage.getAccessToken(),
  listProjectBuckets: ({ projectId }) =>
    premiumDataverse.listProjectBuckets({
      projectId,
      token: process.env.PREMIUM_TEST_ACCESS_TOKEN || "",
      baseUrl: ORG_URL,
    }),
};

function identidadeDoToken(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64").toString("utf8"));
    return payload.upn || payload.preferred_username || payload.name || "(desconhecida)";
  } catch {
    return "(não decodificável)";
  }
}

(async () => {
  console.log(`Modo:        ${DRY_RUN ? "DRY RUN (não escreve nada)" : "EXECUÇÃO REAL (escreve no Planner Premium)"}`);
  console.log(`Org Premium: ${ORG_URL}`);
  console.log(`Org PRD:     ${PRD_URL}`);
  console.log(`Plano:       ${PLAN_ID}`);
  console.log(`Bucket:      ${BUCKET_ID}`);
  console.log(`Page size:   ${PAGE_SIZE} | includeClosed: ${INCLUDE_CLOSED}\n`);

  if (!DRY_RUN) {
    const token = await deps.getDelegatedToken();
    console.log(`Identidade de escrita: ${identidadeDoToken(token)}\n`);
  }

  const total = { processed: 0, created: 0, updated: 0, unchanged: 0, skipped: 0, errors: [] };
  let cursor = null;
  let page = 0;

  while (page < MAX_PAGES) {
    page += 1;
    const started = Date.now();
    const { status, body } = await runPremiumSync({
      request: {
        body: {
          planId: PLAN_ID,
          bucketId: BUCKET_ID,
          cursor: cursor || undefined,
          pageSize: PAGE_SIZE,
          includeClosed: INCLUDE_CLOSED,
          dryRun: DRY_RUN,
        },
      },
      deps,
    });

    if (status !== 200) {
      console.error(`\n[page ${page}] HTTP ${status}: ${body?.error}`);
      process.exitCode = 1;
      break;
    }

    total.processed += body.processed || 0;
    total.created += body.created || 0;
    total.updated += body.updated || 0;
    total.unchanged += body.unchanged || 0;
    total.skipped += body.skipped || 0;
    if (body.errors?.length) total.errors.push(...body.errors);

    console.log(
      `[page ${page}] fase=${body.phase} processed=${body.processed} created=${body.created} updated=${body.updated} ` +
        `unchanged=${body.unchanged} skipped=${body.skipped} erros=${body.errors?.length || 0} ` +
        `(${Math.round((Date.now() - started) / 1000)}s)`
    );
    for (const e of body.errors || []) console.log(`   ! iid ${e.iid}: ${e.message}`);

    cursor = body.nextCursor;
    if (!cursor) break;
  }

  console.log(`\n=== TOTAL (${page} página(s)) ===`);
  console.log(`processed=${total.processed} created=${total.created} updated=${total.updated} unchanged=${total.unchanged} skipped=${total.skipped} erros=${total.errors.length}`);
  if (total.errors.length) {
    console.log("\nErros (primeiros 20):");
    for (const e of total.errors.slice(0, 20)) console.log(`  iid ${e.iid}: ${e.message}`);
  }
})().catch((e) => {
  console.error("\nFalha no sync:", e?.message || e);
  process.exit(1);
});
