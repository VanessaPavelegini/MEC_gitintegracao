"use strict";
// One-shot: deleta mappings órfãos cujo pmo_plannerplanid == <planId>.
// Destrutivo! Rode primeiro scripts/count-orphan-mappings.js pra conferir.

const fs = require("fs");
const path = require("path");

const settingsPath = path.join(__dirname, "..", "local.settings.json");
const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
for (const [k, v] of Object.entries(settings.Values || {})) {
  if (v) process.env[k] = v;
}

const { deleteMappingsByPlanId } = require("../src/functions/gitlab-planner-sync/tableStorage");

const PLAN_ID = process.argv[2];
if (!PLAN_ID) {
  console.error("Uso: node scripts/delete-orphan-mappings.js <planId>");
  process.exit(2);
}

(async () => {
  try {
    const result = await deleteMappingsByPlanId(PLAN_ID);
    console.log(JSON.stringify(result, null, 2));
  } catch (e) {
    console.error("ERRO:", e.message);
    process.exit(1);
  }
})();
