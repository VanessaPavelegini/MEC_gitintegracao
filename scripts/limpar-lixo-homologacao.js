#!/usr/bin/env node
/**
 * Limpeza da rodada de homologação (Planner Premium + PRD).
 *
 * 1) Apaga do plano as tasks de teste/probe (prefixos OSD-, OSI-, OSS-, CMP-,
 *    PRG-, PRG2-, PRG3-, FIM-, DT-, D2-, LIM-, CAPT-) — a remoção também vai
 *    por operation set (msdyn_PssDeleteV2) e é ASSÍNCRONA: o registro do set
 *    só pode ser apagado depois que a task sumiu.
 *
 * 2) Apaga do PRD os mappings cuja pmo_plannertaskid não existe mais no
 *    plano (mappings órfãos deixados pela rodada em que o set foi apagado
 *    antes das tasks materializarem).
 *
 * Uso: node scripts/limpar-lixo-homologacao.js [--dry-run]
 */

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");

// Carrega o local.settings.json no process.env (sem sobrescrever o que já existe).
const settingsPath = path.join(ROOT, "local.settings.json");
if (fs.existsSync(settingsPath)) {
  const values = JSON.parse(fs.readFileSync(settingsPath, "utf8")).Values || {};
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== null && value !== "") process.env[key] = String(value);
  }
}

const premium = require(path.join(ROOT, "src/functions/gitlab-planner-sync/premiumDataverse"));
const tableStorage = require(path.join(ROOT, "src/functions/gitlab-planner-sync/tableStorage"));

const PLAN_ID = process.env.PREMIUM_HOMOLOGACAO_PLAN_ID || "c385351a-e450-4d54-87ed-d54c57794f7b";
const ORG_URL = process.env.DATAVERSE_URL_PREMIUM || "https://orgcf194dda.crm.dynamics.com";
const PRD_URL = process.env.DATAVERSE_URL || "https://org41ecace2.crm2.dynamics.com";

const PREFIXOS_TESTE = ["OSD-", "OSI-", "OSS-", "CMP-", "PRG-", "PRG2-", "PRG3-", "FIM-", "DT-", "D2-", "LIM-", "CAPT-", "MATRIZ-"];
const DRY_RUN = process.argv.includes("--dry-run");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function listarTasks(token) {
  const todas = [];
  let url = `${ORG_URL}/api/data/v9.2/msdyn_projecttasks?$select=msdyn_projecttaskid,msdyn_subject&$filter=_msdyn_project_value eq '${PLAN_ID}'&$top=5000`;
  while (url) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
    const json = await res.json();
    if (json.error) throw new Error(`listar tasks: ${json.error.message}`);
    for (const t of json.value || []) {
      if (!todas.some((x) => x.msdyn_projecttaskid === t.msdyn_projecttaskid)) todas.push(t);
    }
    url = json["@odata.nextLink"] || null;
  }
  return todas;
}

async function existeTask(token, id) {
  const res = await fetch(`${ORG_URL}/api/data/v9.2/msdyn_projecttasks(${id})?$select=msdyn_projecttaskid`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  return res.status === 200;
}

async function apagarTasks(token, tasks) {
  if (tasks.length === 0) return;
  const setId = await premium.createOperationSet({
    projectId: PLAN_ID,
    description: `Limpeza de tasks de teste — ${tasks.length} task(s) — plano ${PLAN_ID}`,
    token,
    baseUrl: ORG_URL,
  });
  try {
    await premium.queueDeleteTasks({
      operationSetId: setId,
      entities: tasks.map((t) => ({
        "@odata.type": premium.ENTITY_TYPE,
        msdyn_projecttaskid: t.id,
        msdyn_subject: t.subject,
        "msdyn_project@odata.bind": `/msdyn_projects(${PLAN_ID})`,
      })),
      token,
      baseUrl: ORG_URL,
    });
    await premium.executeOperationSet({ operationSetId: setId, token, baseUrl: ORG_URL });

    // A remoção é assíncrona: espera as tasks sumirem ANTES de apagar o
    // registro do set (apagar antes cancela a remoção pendente).
    const pendentes = new Set(tasks.map((t) => t.id));
    for (let attempt = 0; attempt < 15 && pendentes.size > 0; attempt++) {
      for (const id of [...pendentes]) {
        if (!(await existeTask(token, id))) pendentes.delete(id);
      }
      if (pendentes.size > 0) await sleep(2000);
    }
    console.log(`  removidas: ${tasks.length - pendentes.size}/${tasks.length}${pendentes.size ? ` (pendentes: ${pendentes.size})` : ""}`);
  } finally {
    try {
      await premium.discardOperationSet({ operationSetId: setId, token, baseUrl: ORG_URL });
    } catch {
      /* best effort */
    }
  }
}

async function limparMappingsProbe(prdToken) {
  const res = await fetch(
    `${PRD_URL}/api/data/v9.2/pmo_mapeamentoplanners?$select=pmo_mapeamentoplannerid,pmo_plannerplanid&$filter=pmo_plannerplanid eq 'TESTE-PROBE-PLAN'&$top=5000`,
    { headers: { Authorization: `Bearer ${prdToken}`, Accept: "application/json" } }
  );
  const json = await res.json();
  const rows = json.value || [];
  if (rows.length === 0) return 0;
  if (!DRY_RUN) {
    for (const m of rows) {
      await fetch(`${PRD_URL}/api/data/v9.2/pmo_mapeamentoplanners(${m.pmo_mapeamentoplannerid})`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${prdToken}` },
      });
    }
  }
  console.log(`  mappings de probe apagados: ${rows.length}`);
  return rows.length;
}

async function limparMappingsOrfaos(prdToken, token) {
  const res = await fetch(
    `${PRD_URL}/api/data/v9.2/pmo_mapeamentoplanners?$select=pmo_mapeamentoplannerid,pmo_gitlab_iid,pmo_plannertaskid&$filter=pmo_plannerplanid eq '${PLAN_ID}'&$top=5000`,
    { headers: { Authorization: `Bearer ${prdToken}`, Accept: "application/json" } }
  );
  const json = await res.json();
  if (json.error) throw new Error(`listar mappings: ${json.error.message}`);
  const mappings = json.value || [];

  const orfaos = [];
  for (const m of mappings) {
    // Mapping sem task id é lixo no plano Premium: o sync decide por ele
    // ("a issue não mudou") e nunca criaria a task.
    if (!m.pmo_plannertaskid) {
      orfaos.push(m);
      continue;
    }
    if (!(await existeTask(token, m.pmo_plannertaskid))) {
      orfaos.push(m);
    }
  }
  console.log(`  mappings do plano: ${mappings.length} | órfãos (task não existe): ${orfaos.length}`);
  if (DRY_RUN || orfaos.length === 0) return orfaos.length;

  for (const m of orfaos) {
    const del = await fetch(`${PRD_URL}/api/data/v9.2/pmo_mapeamentoplanners(${m.pmo_mapeamentoplannerid})`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${prdToken}` },
    });
    if (!del.ok) {
      console.log(`  falha ao apagar mapping do iid ${m.pmo_gitlab_iid}: HTTP ${del.status}`);
    }
  }
  console.log(`  mappings apagados: ${orfaos.length}`);
  return orfaos.length;
}

(async () => {
  const token = process.env.PREMIUM_TEST_ACCESS_TOKEN || (await tableStorage.getAccessToken());
  const prdToken = await tableStorage.getAccessToken();

  console.log(`Plano ${PLAN_ID} | org ${ORG_URL}${DRY_RUN ? " | DRY RUN" : ""}`);

  console.log("\n1) Tasks de teste no plano");
  const tasks = await listarTasks(token);
  const deTeste = tasks
    .filter((t) => PREFIXOS_TESTE.some((p) => String(t.msdyn_subject || "").startsWith(p)))
    .map((t) => ({ id: t.msdyn_projecttaskid, subject: t.msdyn_subject }));
  console.log(`  tasks no plano: ${tasks.length} | de teste: ${deTeste.length}`);
  if (deTeste.length > 0 && !DRY_RUN) await apagarTasks(token, deTeste);

  console.log("\n2) Mappings órfãos no PRD");
  await limparMappingsProbe(prdToken);
  const qtd = await limparMappingsOrfaos(prdToken, token);

  console.log(`\nFim. mappings órfãos encontrados: ${qtd}.`);
})().catch((e) => {
  console.error("ERRO:", e.message);
  process.exitCode = 1;
});
