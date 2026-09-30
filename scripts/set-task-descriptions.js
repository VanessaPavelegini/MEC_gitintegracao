"use strict";
// Seta/atualiza a descrição (markdown) em tasks do Planner.
// Pega o etag da task (do /tasks) e usa pra PATCH em /details.
// Uso: node scripts/set-task-descriptions.js [--only=<iid>]

const fs = require("fs");
const path = require("path");

const settingsPath = path.join(__dirname, "..", "local.settings.json");
const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
for (const [k, v] of Object.entries(settings.Values || {})) {
  if (v) process.env[k] = v;
}

const { getGraphClient } = require("../src/shared/graphClient");

const ARGV = process.argv.slice(2);
const ONLY_IID = (() => {
  const arg = ARGV.find((a) => a.startsWith("--only="));
  return arg ? parseInt(arg.split("=")[1], 10) : null;
})();

const PLAN_ID = process.env.PLANNER_PLAN_ID;
if (!PLAN_ID) {
  console.error("ERRO: PLANNER_PLAN_ID não configurado");
  process.exit(2);
}

const INPUT_PATH = path.join(__dirname, "..", "docs", "18.09.26", "planner_tasks.json");

function buildDescription(row) {
  const lines = [
    `**GitLab iid:** ${row.iid}`,
    `**Estado:** 🔄 Aberta`,
    `**Labels:** Nenhuma`,
    ``,
    `---`,
    ``,
    `**WBS:** ${row.hierarquia || "(sem hierarquia)"}`,
    `**Início:** ${row.inicio || "?"}`,
    `**Concluir:** ${row.fim || "?"}`,
    `**Duração:** ${row.duracao || "?"}`,
    `**% Concluída:** ${row.pct || "0%"}`,
    ``,
    `---`,
    `## Origem`,
    `Importado de \`AutomaçãoTestes.xlsx\` (Planner Premium) em ${new Date().toISOString()}.`,
    `*Campos custom (TIME, Estágio HU, KANBAN, Sprint, Goal, TESTE BI) estavam vazios nas 35 tasks de origem — não foram migrados.*`,
  ];
  return lines.join("\n");
}

(async () => {
  const rows = JSON.parse(fs.readFileSync(INPUT_PATH, "utf8"));
  const client = getGraphClient();
  console.log(`[descriptions] Buscando tasks no plano ${PLAN_ID}...`);
  const allTasks = await client.api(`/planner/plans/${PLAN_ID}/tasks?$top=100`).get();
  const tasksList = allTasks.value || [];

  // Indexar por iid extraído do título "[#NNN] ..."
  const byIid = new Map();
  for (const t of tasksList) {
    const m = (t.title || "").match(/^\[#(\d+)\]/);
    if (m) byIid.set(parseInt(m[1], 10), t);
  }

  const filtered = ONLY_IID ? rows.filter((r) => r.iid === ONLY_IID) : rows;
  let ok = 0, fail = 0, missing = 0;

  for (const row of filtered) {
    const task = byIid.get(row.iid);
    if (!task) {
      console.error(`[descriptions] iid=${row.iid} sem task correspondente no plano`);
      missing++;
      continue;
    }
    const description = buildDescription(row);
    try {
      // O etag do /details é DIFERENTE do etag da /task — precisa pegar o do próprio /details.
      const details = await client.api(`/planner/tasks/${task.id}/details`).get();
      await client
        .api(`/planner/tasks/${task.id}/details`)
        .header("If-Match", details["@odata.etag"])
        .patch({ description });
      console.log(`[descriptions] OK iid=${row.iid} taskId=${task.id}`);
      ok++;
    } catch (e) {
      console.error(`[descriptions] FALHOU iid=${row.iid}: ${e.message}`);
      if (e.body) console.error(`          body=${JSON.stringify(e.body)}`);
      fail++;
    }
    await new Promise((res) => setTimeout(res, 200));
  }

  console.log(`[descriptions] Resultado: ${ok} OK, ${fail} falhas, ${missing} sem task (de ${filtered.length})`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => {
  console.error("ERRO fatal:", e.message);
  console.error(e.stack);
  process.exit(1);
});
