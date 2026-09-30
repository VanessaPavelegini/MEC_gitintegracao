"use strict";
// One-shot: pra cada issue do GitLab (aberta ou fechada), garante uma task
// correspondente no Planner e um registro de mapping em pmo_mapeamentoplanner.
//
// Fluxo por issue:
//   1. GET no Planner lista todas as tasks do plano. Se já existe task com
//      título "[#iid] ..." → usa essa (atualiza se necessário).
//   2. Senão → POST /planner/tasks cria a task nova.
//   3. saveMapping() grava/atualiza o mapping no Dataverse.
//
// Uso: node scripts/sync-gitlab-to-planner.js [--dry-run] [--state=opened|closed|all]
//   --dry-run: só loga, não cria/atualiza nada.
//   --state:   default = all (abertas + fechadas).
//
// Idempotente — pode rodar várias vezes.

const fs = require("fs");
const path = require("path");

const settingsPath = path.join(__dirname, "..", "local.settings.json");
const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
for (const [k, v] of Object.entries(settings.Values || {})) {
  // Não sobrescreve se já vier do ambiente (ex: PLANNER_PLAN_ID inline apontando pro Premium).
  if (v && process.env[k] === undefined) process.env[k] = v;
}

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes("--dry-run");
const stateArg = argv.find(a => a.startsWith("--state="));
const STATE = stateArg ? stateArg.split("=")[1] : "all";
const onlyArg = argv.find(a => a.startsWith("--only="));
const ONLY_IID = onlyArg ? parseInt(onlyArg.split("=")[1], 10) : null;

const { listIssues } = require("../src/functions/gitlab-planner-sync/gitlabService");
const { mapLabelToBucket } = require("../src/functions/gitlab-planner-sync/gitlabService");
const { getGraphClient } = require("../src/shared/graphClient");
const { saveMapping, listMappings, getCachedBuckets, clearBucketsCache, getOrCreateBucket } = require("../src/functions/gitlab-planner-sync/tableStorage");

const PLAN_ID = process.env.PLANNER_PLAN_ID;
if (!PLAN_ID) {
  console.error("ERRO: PLANNER_PLAN_ID não configurado em local.settings.json");
  process.exit(2);
}

const PER_PAGE = 100;
const MAX_PAGES = 20; // 20 × 100 = 2000 issues — folga pra projeto grande
const THROTTLE_MS = 300;

// ─── Planner helpers ──────────────────────────────────────────────────────────

async function listAllPlannerTasks(client, planId) {
  const tasks = [];
  let url = `/planner/plans/${planId}/tasks?$top=100`;
  while (url) {
    const resp = await client.api(url).get();
    tasks.push(...(resp.value || []));
    const next = resp["@odata.nextLink"];
    url = next ? next.replace(client.apiConfig && client.apiConfig.baseUrl ? client.apiConfig.baseUrl : "", "").replace(/^https?:\/\/[^/]+/, "") : null;
    if (url && !url.startsWith("/")) url = `/${url}`;
    await new Promise(r => setTimeout(r, THROTTLE_MS));
  }
  return tasks;
}

async function listAllBuckets(client, planId) {
  const resp = await client.api(`/planner/plans/${planId}/buckets?$top=100`).get();
  return resp.value || [];
}

async function getBucketByName(client, planId, name) {
  const buckets = await getCachedBuckets(planId, () => listAllBuckets(client, planId));
  return buckets.find(b => b.name && b.name.toLowerCase() === name.toLowerCase()) || null;
}

async function createBucket(client, planId, name) {
  console.log(`  [planner] criando bucket "${name}" no plano ${planId}...`);
  const resp = await client.api("/planner/buckets").post({
    planId,
    name,
    orderHint: "a",
  });
  return resp;
}

function extractIid(title) {
  const m = (title || "").match(/^\[#(\d+)\]/);
  return m ? parseInt(m[1], 10) : null;
}

function buildPlannerTitle(iid, issueTitle) {
  return `[#${iid}] ${issueTitle || ""}`.substring(0, 500);
}

function buildPlannerDescription(issue) {
  return (issue.description || "").substring(0, 10000);
}

// ─── Operações Planner ────────────────────────────────────────────────────────

async function createPlannerTask(client, planId, bucketId, issue) {
  const title = buildPlannerTitle(issue.iid, issue.title);
  const description = buildPlannerDescription(issue);
  const percentComplete = issue.state === "closed" ? 100 : 0;

  console.log(`  [planner] POST task iid=${issue.iid} bucket=${bucketId} pct=${percentComplete}`);
  const resp = await client.api("/planner/tasks").post({
    planId,
    bucketId,
    title,
    descriptions: { description },
    percentComplete,
  });
  return resp; // { id, ... }
}

async function updatePlannerTask(client, taskId, etag, issue, currentTask) {
  const title = buildPlannerTitle(issue.iid, issue.title);
  const description = buildPlannerDescription(issue);
  const percentComplete = issue.state === "closed" ? 100 : 0;

  // Só atualiza se algo mudou — evita writes desnecessários e conflitos de etag
  const needsUpdate =
    currentTask.title !== title ||
    (currentTask.description || "") !== description ||
    (currentTask.percentComplete || 0) !== percentComplete;

  if (!needsUpdate) return { updated: false, task: currentTask };

  console.log(`  [planner] PATCH task ${taskId} iid=${issue.iid} pct=${percentComplete}`);
  const resp = await client.api(`/planner/tasks/${taskId}`)
    .header("If-Match", etag)
    .patch({
      title,
      descriptions: { description },
      percentComplete,
    });
  return { updated: true, task: resp };
}

// ─── Loop principal ───────────────────────────────────────────────────────────

(async () => {
  const summary = {
    issues_total: 0,
    tasks_already_in_planner: 0,
    tasks_updated_in_planner: 0,
    tasks_created_in_planner: 0,
    mappings_created_in_dataverse: 0,
    mappings_updated_in_dataverse: 0,
    errors: 0,
  };

  try {
    console.log(`[sync-gitlab-to-planner] state=${STATE} dryRun=${DRY_RUN} planId=${PLAN_ID}`);

    // Indexar tasks já existentes no Planner por iid
    const client = getGraphClient();
    console.log(`[sync-gitlab-to-planner] listando tasks do plano...`);
    const existingTasks = await listAllPlannerTasks(client, PLAN_ID);
    const plannerByIid = new Map();
    for (const t of existingTasks) {
      const iid = extractIid(t.title);
      if (iid) plannerByIid.set(iid, t);
    }
    console.log(`[sync-gitlab-to-planner] Planner: ${existingTasks.length} tasks, ${plannerByIid.size} com iid válido`);

    // Indexar mappings já existentes no Dataverse por iid (filtrado por planId)
    console.log(`[sync-gitlab-to-planner] listando mappings do Dataverse...`);
    const allMappings = await listMappings();
    const mappingsByIid = new Map();
    for (const m of allMappings) {
      if (m.pmo_plannerplanid === PLAN_ID) {
        mappingsByIid.set(Number(m.pmo_gitlab_iid), m);
      }
    }
    console.log(`[sync-gitlab-to-planner] Dataverse: ${mappingsByIid.size} mappings para este plano`);

    // Paginar issues do GitLab
    const issues = [];
    let page = 1;
    while (page <= MAX_PAGES) {
      console.log(`[sync-gitlab-to-planner] GitLab: buscando página ${page} (state=${STATE})...`);
      const batch = await listIssues({ state: STATE, page, per_page: PER_PAGE });
      issues.push(...batch);
      if (batch.length < PER_PAGE) break;
      page++;
    }
    summary.issues_total = issues.length;
    console.log(`[sync-gitlab-to-planner] GitLab: ${issues.length} issues (state=${STATE})`);

    // Filtrar por --only=<iid> se fornecido (smoke test)
    const filteredIssues = ONLY_IID ? issues.filter(i => Number(i.iid) === ONLY_IID) : issues;
    if (ONLY_IID && filteredIssues.length === 0) {
      console.error(`ERRO: iid=${ONLY_IID} não encontrado nas ${issues.length} issues`);
      process.exit(2);
    }
    if (ONLY_IID) console.log(`[sync-gitlab-to-planner] --only=${ONLY_IID}: processando 1 issue`);

    // Backlog como bucket padrão
    let backlogBucket = await getBucketByName(client, PLAN_ID, "Backlog");
    if (!backlogBucket && !DRY_RUN) {
      backlogBucket = await createBucket(client, PLAN_ID, "Backlog");
      clearBucketsCache();
    }
    if (!backlogBucket) {
      console.error("ERRO: bucket 'Backlog' não existe e --dry-run impede criar.");
      process.exit(2);
    }

    for (const issue of filteredIssues) {
      try {
        const iid = Number(issue.iid);
        const existing = plannerByIid.get(iid);
        const mapping = mappingsByIid.get(iid);

        // Decide bucket pela label de status (se houver); senão Backlog
        const statusLabel = (issue.labels || []).find(l => /to do|to-do|a fazer|backlog|in progress|em progresso|em andamento|in review|review|done|pronto|concluido|concluida|completed|blocked|bloqueado|impedido/i.test(l));
        const bucketName = statusLabel ? mapLabelToBucket(statusLabel) : "Backlog";
        const bucket = bucketName === "Backlog"
          ? backlogBucket
          : (await getBucketByName(client, PLAN_ID, bucketName)) || backlogBucket;

        if (existing) {
          summary.tasks_already_in_planner++;
          if (!DRY_RUN) {
            const { updated, task } = await updatePlannerTask(client, existing.id, existing["@odata.etag"], issue, existing);
            if (updated) summary.tasks_updated_in_planner++;

            await saveMapping({
              gitlabIid: iid,
              plannerTaskId: task.id,
              plannerBucketId: task.bucketId || bucket.id,
              issueData: {
                title: buildPlannerTitle(iid, issue.title),
                webUrl: issue.web_url,
                description: issue.description || "",
                labels: issue.labels || [],
              },
            });
            // saveMapping não retorna qual foi (create vs update) — conta pela presença prévia
            if (mapping) summary.mappings_updated_in_dataverse++;
            else summary.mappings_created_in_dataverse++;
          }
        } else {
          if (!DRY_RUN) {
            const created = await createPlannerTask(client, PLAN_ID, bucket.id, issue);
            summary.tasks_created_in_planner++;
            await saveMapping({
              gitlabIid: iid,
              plannerTaskId: created.id,
              plannerBucketId: bucket.id,
              issueData: {
                title: buildPlannerTitle(iid, issue.title),
                webUrl: issue.web_url,
                description: issue.description || "",
                labels: issue.labels || [],
              },
            });
            summary.mappings_created_in_dataverse++;
          }
        }
      } catch (e) {
        summary.errors++;
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[sync-gitlab-to-planner] ERRO iid=${issue.iid}: ${msg}`);
        if (e.response?.data) console.error(`  body=${JSON.stringify(e.response?.data)}`);
      }
    }

    console.log("\n=== RESUMO ===");
    console.log(JSON.stringify(summary, null, 2));
    process.exit(summary.errors > 0 ? 1 : 0);
  } catch (e) {
    console.error("ERRO fatal:", e.message);
    console.error(e.stack);
    process.exit(1);
  }
})();
