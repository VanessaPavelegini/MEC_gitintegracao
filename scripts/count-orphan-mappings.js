"use strict";
// One-shot: conta mappings órfãos cujo pmo_plannerplanid == <planId>.
// Não destrutivo. Use antes de scripts/delete-orphan-mappings.js.
//
// Carrega env vars de local.settings.json (formato Azure Functions: { "Values": { ... } })

const fs = require("fs");
const path = require("path");

const settingsPath = path.join(__dirname, "..", "local.settings.json");
const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
for (const [k, v] of Object.entries(settings.Values || {})) {
  if (v) process.env[k] = v;
}

const { listMappings } = require("../src/functions/gitlab-planner-sync/tableStorage");

const PLAN_ID = process.argv[2];
if (!PLAN_ID) {
  console.error("Uso: node scripts/count-orphan-mappings.js <planId>");
  process.exit(2);
}

(async () => {
  try {
    const all = await listMappings();
    const orphans = all.filter((m) => m.pmo_plannerplanid === PLAN_ID);
    const sample = orphans.slice(0, 3).map((m) => ({
      pmo_mapeamentoplannerid: m.pmo_mapeamentoplannerid,
      pmo_gitlab_iid: m.pmo_gitlab_iid,
      pmo_title: m.pmo_title,
    }));
    console.log(JSON.stringify({
      planId: PLAN_ID,
      total_mappings: all.length,
      orphans: orphans.length,
      sample,
    }, null, 2));
  } catch (e) {
    console.error("ERRO:", e.message);
    process.exit(1);
  }
})();
