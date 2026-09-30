"use strict";
// Para cada task criada na Fase 6 (com iid mapeável via título "[#N] ..."),
// cria/atualiza um registro em pmo_mapeamentoplanner com pmo_plannertaskid e pmo_plannerbucketid.
// Sem isso, o webhook GitLab vai tentar criar duplicatas em vez de atualizar.
//
// Uso: node scripts/seed-mappings.js [--dry-run]

const fs = require("fs");
const path = require("path");

const settingsPath = path.join(__dirname, "..", "local.settings.json");
const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
for (const [k, v] of Object.entries(settings.Values || {})) {
  if (v) process.env[k] = v;
}

const DRY_RUN = process.argv.includes("--dry-run");

const { getGraphClient } = require("../src/shared/graphClient");
const { saveMapping } = require("../src/functions/gitlab-planner-sync/tableStorage");

const PLAN_ID = process.env.PLANNER_PLAN_ID;
if (!PLAN_ID) {
  console.error("ERRO: PLANNER_PLAN_ID não configurado");
  process.exit(2);
}

const INPUT_PATH = path.join(__dirname, "..", "docs", "18.09.26", "planner_tasks.json");
const THROTTLE_MS = 300;

(async () => {
  const rows = JSON.parse(fs.readFileSync(INPUT_PATH, "utf8"));
  const client = getGraphClient();

  console.log(`[seed-mappings] Buscando tasks no plano ${PLAN_ID}...`);
  const allTasks = await client.api(`/planner/plans/${PLAN_ID}/tasks?$top=100`).get();
  const tasksList = allTasks.value || [];

  // Indexar por iid
  const byIid = new Map();
  for (const t of tasksList) {
    const m = (t.title || "").match(/^\[#(\d+)\]/);
    if (m) byIid.set(parseInt(m[1], 10), { id: t.id, bucketId: t.bucketId, title: t.title });
  }

  console.log(`[seed-mappings] Encontradas ${tasksList.length} tasks. Cruzando com ${rows.length} rows do JSON...`);

  const matched = [];
  const missing = [];
  for (const r of rows) {
    const t = byIid.get(r.iid);
    if (t) matched.push({ row: r, task: t });
    else missing.push(r.iid);
  }

  console.log(`[seed-mappings] Match: ${matched.length}, Missing: ${missing.length}`);
  if (missing.length > 0) {
    console.error(`[seed-mappings] ERRO: ${missing.length} iids sem task: ${missing.join(", ")}`);
    console.error(`[seed-mappings] Volte pra Fase 6 (import-planner-tasks) e reimporte esses iids.`);
    process.exit(2);
  }

  if (DRY_RUN) {
    console.log(`[seed-mappings] DRY RUN — salvaria ${matched.length} mappings em pmo_mapeamentoplanner`);
    for (const { row, task } of matched.slice(0, 5)) {
      console.log(`  iid=${row.iid} plannerTaskId=${task.id} bucketId=${task.bucketId}`);
    }
    if (matched.length > 5) console.log(`  ... e mais ${matched.length - 5}`);
    return;
  }

  let ok = 0, fail = 0;
  for (const { row, task } of matched) {
    try {
      await saveMapping({
        gitlabIid: row.iid,
        plannerTaskId: task.id,
        plannerBucketId: task.bucketId,
        issueData: {
          iid: row.iid,
          title: `[#${row.iid}] ${row.nome}`,
          web_url: "",
          description: `Importado de XLSX — WBS ${row.hierarquia}`,
          labels: [],
        },
      });
      ok++;
      if (ok % 10 === 0 || ok === matched.length) {
        console.log(`[seed-mappings] ${ok}/${matched.length}`);
      }
    } catch (e) {
      fail++;
      console.error(`[seed-mappings] FALHOU iid=${row.iid}: ${e.message}`);
      if (e.response?.data) console.error(`          body=${JSON.stringify(e.response.data)}`);
    }
    await new Promise((res) => setTimeout(res, THROTTLE_MS));
  }

  console.log(`[seed-mappings] Resultado: ${ok} OK, ${fail} falhas (de ${matched.length})`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => {
  console.error("ERRO fatal:", e.message);
  console.error(e.stack);
  process.exit(1);
});
