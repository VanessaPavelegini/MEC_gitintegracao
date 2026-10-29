"use strict";
// Smoke corrigido: espera a task MATERIALIZAR antes de descartar o operation set.
// O script original esperava no máximo 7,5 s e descartava o set no `finally`
// — e descartar o set com criação pendente CANCELA a criação (comentário em
// premiumDataverse.js). Isso produz um falso negativo.
const fs = require("fs");
const path = require("path");
const settings = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "local.settings.json"), "utf8"));
for (const [k, v] of Object.entries(settings.Values || {})) {
  if (v && process.env[k] === undefined) process.env[k] = v;
}
const { getDataverseDelegatedToken } = require("../src/shared/dataverseServiceAccountAuth");
const premium = require("../src/functions/gitlab-planner-sync/premiumDataverse");

const ORG_URL = process.env.DATAVERSE_URL_PREMIUM || "https://orgcf194dda.crm.dynamics.com";
const PLAN_ID = process.env.PREMIUM_HOMOLOGACAO_PLAN_ID || "c385351a-e450-4d54-87ed-d54c57794f7b";
const BUCKET_ID = process.env.PREMIUM_HOMOLOGACAO_BUCKET_ID || "f704c207-84be-f111-a04d-7c1e520d9f67";
const WAIT_MS = Number(process.env.SMOKE_WAIT_MS || 150000);

async function main() {
  const token = await getDataverseDelegatedToken({ orgUrl: ORG_URL });
  const upn = (() => { try { return JSON.parse(Buffer.from(token.split(".")[1], "base64").toString("utf8")).upn; } catch { return "?"; } })();
  console.log(`Identidade: ${upn}\nPlano: ${PLAN_ID}`);

  const subject = `SMOKE-homologacao-${Date.now()}`;
  const setId = await premium.createOperationSet({ projectId: PLAN_ID, description: `Smoke test ${subject}`, token, baseUrl: ORG_URL });
  console.log(`OperationSet criado: ${setId}`);

  let taskId = null;
  try {
    await premium.queueCreateTasks({
      operationSetId: setId,
      entities: [{
        "@odata.type": premium.ENTITY_TYPE,
        msdyn_subject: subject,
        msdyn_description: "Task de smoke test — criada e removida automaticamente.",
        msdyn_start: "2026-10-26",
        msdyn_finish: "2026-11-02",
        msdyn_progress: 0,
        "msdyn_project@odata.bind": `/msdyn_projects(${PLAN_ID})`,
        "msdyn_projectbucket@odata.bind": `/msdyn_projectbuckets(${BUCKET_ID})`,
      }],
      token, baseUrl: ORG_URL,
    });
    await premium.executeOperationSet({ operationId: setId, operationSetId: setId, token, baseUrl: ORG_URL });
    console.log("Set executado. Aguardando materialização...");

    const t0 = Date.now();
    let found = {};
    while (Date.now() - t0 < WAIT_MS) {
      found = await premium.findTaskIdsBySubjects({ projectId: PLAN_ID, subjects: [subject], token, baseUrl: ORG_URL });
      if (found && found[subject]) break;
      await new Promise((r) => setTimeout(r, 3000));
    }
    taskId = found[subject] || null;
    console.log(taskId ? `✅ Task materializou em ${((Date.now()-t0)/1000).toFixed(1)}s: ${taskId}` : `❌ Task NÃO materializou em ${((Date.now()-t0)/1000).toFixed(1)}s`);
  } finally {
    // só descarta DEPOIS de materializar (ou de expirar a espera)
    try { await premium.discardOperationSet({ operationSetId: setId, token, baseUrl: ORG_URL }); console.log("OperationSet descartado."); }
    catch (e) { console.log(`Falha ao descartar: ${e.message}`); }
  }

  if (taskId) {
    try {
      const delSetId = await premium.createOperationSet({ projectId: PLAN_ID, description: `Remove task ${subject}`, token, baseUrl: ORG_URL });
      try {
        await premium.queueDeleteTasks({ operationSetId: delSetId, entities: [{ "@odata.type": premium.ENTITY_TYPE, msdyn_projecttaskid: taskId }], token, baseUrl: ORG_URL });
        await premium.executeOperationSet({ operationSetId: delSetId, token, baseUrl: ORG_URL });
        console.log(`Task de teste apagada (${taskId}).`);
      } finally {
        try { await premium.discardOperationSet({ operationSetId: delSetId, token, baseUrl: ORG_URL }); } catch {}
      }
    } catch (e) { console.log(`NÃO consegui apagar: ${e.message}`); process.exitCode = 1; }
  } else { process.exitCode = 1; }
}
main().catch((e) => { console.error("Smoke falhou:", e.message || e); process.exit(1); });
