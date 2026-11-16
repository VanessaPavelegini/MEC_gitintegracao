// Sync manual GitLab → Planner Premium (plano de PREMIUM_HOMOLOGACAO_PLAN_ID do local.settings.json).
//
//   node scripts/sync-premium-manual.js                 → todas as issues abertas
//   IIDS=793 node scripts/sync-premium-manual.js        → só a #793 (ou IIDS=793,800)
//   node scripts/sync-premium-manual.js Apontamentos    → só issues com esse rótulo
//   NOLABELS=1 ...  pula os rótulos coloridos (mais rápido)
//   FORCE=1 ...     regrava mesmo sem mudança no GitLab
//
// Se der AADSTS70043: node scripts/autorizarContaServicoPremium.js
const path = require("path");
const root = "/Users/antoniojunior/Dev/projetos_spfx/MEC_gitintegracao";
const s = require(path.join(root, "local.settings.json")).Values;
for (const k in s) if (!process.env[k]) process.env[k] = s[k];
const G = (m) => require(path.join(root, "src/functions/gitlab-planner-sync", m));
const { getDataverseDelegatedToken } = require(path.join(root, "src/shared/dataverseServiceAccountAuth"));
const orgUrl = process.env.DATAVERSE_URL_PREMIUM;
(async () => {
  const token = await getDataverseDelegatedToken({ orgUrl });
  const prdToken = await G("tableStorage").getAccessToken();
  let cursor = 1, tot = { created: 0, updated: 0, errors: [], missing: new Set() };
  const label = process.argv[2] && process.argv[2] !== "-" ? process.argv[2] : undefined;
  const pd = G("premiumDataverse");
  const buckets = await pd.listProjectBuckets({ projectId: process.env.PREMIUM_HOMOLOGACAO_PLAN_ID, token, baseUrl: orgUrl });
  const bucketsByName = new Map(buckets.map(b => [b.name, b.id]));
  const premium = process.env.NOLABELS ? { ...pd, synchronizeTaskLabels: async () => ({ applied: [], missing: [], stale: [], blocked: [] }) } : pd;
  for (let page = 1; page; ) {
    const r = await G("premiumSync").syncPage({
      planId: process.env.PREMIUM_HOMOLOGACAO_PLAN_ID, bucketId: process.env.PREMIUM_HOMOLOGACAO_BUCKET_ID,
      page, pageSize: 100, labels: label, bucketsByName, forceUpdate: !!process.env.FORCE,
      gitlab: { listIssuesPage: (f) => G("gitlabService").listIssuesPage({ ...f, iids: process.env.IIDS ? process.env.IIDS.split(",").map(Number) : undefined }) },
      mapping: G("premiumMapping"), premium,
      token, prdToken, orgUrl, prdBaseUrl: process.env.DATAVERSE_URL,
    });
    tot.created += r.created; tot.updated += r.updated; tot.errors.push(...r.errors); r.missingLabels.forEach(m => tot.missing.add(m));
    console.log(`página ${page}: criadas ${r.created} atualizadas ${r.updated} erros ${r.errors.length}`);
    page = r.nextCursor ? page + 1 : null;
  }
  console.log("TOTAL", JSON.stringify({ ...tot, missing: [...tot.missing], errors: tot.errors.slice(0, 5) }));
})().catch(e => { console.error("ERRO", e.stack); process.exit(1); });
