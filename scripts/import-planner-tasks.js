"use strict";
// Importa tasks do JSON (gerado a partir do XLSX Premium) para o Planner clássico.
//
// Uso:
//   node scripts/import-planner-tasks.js --dry-run             # só loga o que faria
//   node scripts/import-planner-tasks.js --only=424            # importa 1 task (smoke)
//   node scripts/import-planner-tasks.js                       # importa todas as 35

const fs = require("fs");
const path = require("path");

// Carrega env vars de local.settings.json (formato Azure Functions)
const settingsPath = path.join(__dirname, "..", "local.settings.json");
const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
for (const [k, v] of Object.entries(settings.Values || {})) {
  if (v) process.env[k] = v;
}

const { getGraphClient } = require("../src/shared/graphClient");

const ARGV = process.argv.slice(2);
const DRY_RUN = ARGV.includes("--dry-run");
const ONLY_IID = (() => {
  const arg = ARGV.find((a) => a.startsWith("--only="));
  return arg ? parseInt(arg.split("=")[1], 10) : null;
})();

const PLAN_ID = process.env.PLANNER_PLAN_ID;
if (!PLAN_ID) {
  console.error("ERRO: PLANNER_PLAN_ID não configurado em local.settings.json");
  process.exit(2);
}

const INPUT_PATH = path.join(__dirname, "..", "docs", "18.09.26", "planner_tasks.json");
const DEFAULT_BUCKET = "Backlog";
const TITLE_MAX = 255; // Limite real do Planner clássico para title
const THROTTLE_MS = 400;

// "2/1/2023" (d/m/Y) → Date em UTC midnight. Retorna null se vazio/inválido.
function parseBrDate(s) {
  if (!s || typeof s !== "string") return null;
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const d = Number(m[1]);
  const mo = Number(m[2]);
  const y = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return new Date(Date.UTC(y, mo - 1, d));
}

function buildTitle(row) {
  const base = `[#${row.iid}] ${row.nome || ""}`.trim();
  return base.substring(0, TITLE_MAX);
}

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
    `*Campos custom (TIME, Estágio HU, KANBAN, Sprint, Goal, TESTE BI) foram descartados — estavam vazios nas 35 tasks de origem.*`,
  ];
  return lines.join("\n");
}

async function ensureBucket(client, planId, bucketName) {
  if (DRY_RUN) {
    return { id: "<DRY-RUN-BUCKET>", name: bucketName };
  }
  const buckets = await client.api(`/planner/plans/${planId}/buckets`).get();
  const existing = (buckets.value || []).find(
    (b) => b.name && b.name.toLowerCase() === bucketName.toLowerCase()
  );
  if (existing) return existing;

  const created = await client.api("/planner/buckets").post({
    planId,
    name: bucketName,
    orderHint: " !",
  });
  console.log(`[import] Bucket criado: ${created.name} (${created.id})`);
  return created;
}

async function importOne(client, planId, bucket, row) {
  const title = buildTitle(row);
  const description = buildDescription(row);
  const startDate = parseBrDate(row.inicio);
  const dueDate = parseBrDate(row.fim);
  const percentComplete = row.pct === "100%" ? 100 : 0;

  if (DRY_RUN) {
    console.log(
      `[dry-run] iid=${row.iid} bucket=${bucket.name} start=${startDate ? startDate.toISOString() : "?"} due=${dueDate ? dueDate.toISOString() : "?"} pct=${percentComplete}`
    );
    console.log(`          title=${title}`);
    return { ok: true, dryRun: true };
  }

  const created = await client.api("/planner/tasks").post({
    planId,
    bucketId: bucket.id,
    title,
  });

  const patchBody = {};
  if (startDate) patchBody.startDateTime = startDate.toISOString();
  if (dueDate) patchBody.dueDateTime = dueDate.toISOString();
  patchBody.percentComplete = percentComplete;

  if (Object.keys(patchBody).length > 0) {
    await client
      .api(`/planner/tasks/${created.id}`)
      .header("If-Match", created["@odata.etag"])
      .patch(patchBody);
  }

  // Descrição vai via /details (etag separada)
  if (created["@odata.etag"]) {
    try {
      await client
        .api(`/planner/tasks/${created.id}/details`)
        .header("If-Match", created["@odata.etag"])
        .patch({ description });
    } catch (e) {
      console.warn(`[import] iid=${row.iid} aviso: não pôde setar descrição (${e.message})`);
    }
  }

  return { ok: true, taskId: created.id };
}

(async () => {
  const rows = JSON.parse(fs.readFileSync(INPUT_PATH, "utf8"));
  console.log(`[import] Lidas ${rows.length} tasks de ${INPUT_PATH}`);
  console.log(`[import] planId=${PLAN_ID} dryRun=${DRY_RUN} only=${ONLY_IID || "(todas)"}`);

  const client = getGraphClient();
  const bucket = await ensureBucket(client, PLAN_ID, DEFAULT_BUCKET);
  console.log(`[import] Bucket destino: ${bucket.name} (${bucket.id})`);

  const filtered = ONLY_IID ? rows.filter((r) => r.iid === ONLY_IID) : rows;
  if (ONLY_IID && filtered.length === 0) {
    console.error(`ERRO: iid=${ONLY_IID} não encontrado no JSON`);
    process.exit(2);
  }

  let ok = 0;
  let fail = 0;
  for (const row of filtered) {
    try {
      const r = await importOne(client, PLAN_ID, bucket, row);
      if (r.ok && !DRY_RUN) {
        console.log(`[import] OK iid=${row.iid} taskId=${r.taskId}`);
      }
      ok++;
    } catch (e) {
      fail++;
      console.error(`[import] FALHOU iid=${row.iid}: ${e.message}`);
      if (e.body) console.error(`          body=${JSON.stringify(e.body)}`);
    }
    if (!DRY_RUN && !ONLY_IID) {
      await new Promise((res) => setTimeout(res, THROTTLE_MS));
    }
  }

  console.log(`[import] Resultado: ${ok} OK, ${fail} falhas (de ${filtered.length})`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => {
  console.error("ERRO fatal:", e.message);
  console.error(e.stack);
  process.exit(1);
});
