"use strict";

// Confere o resultado do sync GitLab → Planner Premium (homologação).
//
//   node scripts/conferir-sync-premium-homologacao.js
//
// Usa o token delegado da conta logada no Azure CLI (mesmo do runner local).

const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");

const settings = JSON.parse(fs.readFileSync(path.join(ROOT, "local.settings.json"), "utf8"));
for (const [k, v] of Object.entries(settings.Values || {})) {
  if (v && process.env[k] === undefined) process.env[k] = v;
}

const tableStorage = require(path.join(ROOT, "src/functions/gitlab-planner-sync/tableStorage"));

const ORG = process.env.DATAVERSE_URL_PREMIUM || "https://orgcf194dda.crm.dynamics.com";
const PRD = process.env.DATAVERSE_URL;
const PLAN = process.env.PREMIUM_HOMOLOGACAO_PLAN_ID || "c385351a-e450-4d54-87ed-d54c57794f7b";
const BUCKET = process.env.PREMIUM_HOMOLOGACAO_BUCKET_ID || "f704c207-84be-f111-a04d-7c1e520d9f67";

(async () => {
  const token = process.env.PREMIUM_TEST_ACCESS_TOKEN
    ? process.env.PREMIUM_TEST_ACCESS_TOKEN
    : process.argv[2];
  if (!token) {
    console.error("Informe o token: PREMIUM_TEST_ACCESS_TOKEN=... node scripts/conferir-sync-premium-homologacao.js");
    process.exit(1);
  }
  const prdToken = await tableStorage.getAccessToken();

  // 1) Tasks do plano
  const r = await fetch(
    `${ORG}/api/data/v9.2/msdyn_projecttasks?$select=msdyn_subject,msdyn_projecttaskid&$filter=_msdyn_project_value eq '${PLAN}'&$top=5000`,
    { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } }
  );
  const tasks = (await r.json()).value || [];
  const doGitlab = tasks.filter((t) => /^\[#\d+\]/.test(t.msdyn_subject || ""));
  const outros = tasks.filter((t) => !/^\[#\d+\]/.test(t.msdyn_subject || ""));
  // lixo = task que NÃO é uma task do GitLab ([#iid] ...) e tem cara de teste
  const sujos = tasks.filter(
    (t) => !/^\[#\d+\]/.test(t.msdyn_subject || "") && /CAPT-|LIM-|SMOKE|OSD-|OSI-|OSS-|CMP-|PRG|FIM-|DT-|D2-/.test(t.msdyn_subject || "")
  );
  const subjects = doGitlab.map((t) => t.msdyn_subject);
  const duplicados = subjects.filter((s, i) => subjects.indexOf(s) !== i);

  console.log(`Plano ${PLAN}`);
  console.log(`  tasks no plano:            ${tasks.length}`);
  console.log(`  tasks do GitLab ([#iid]):   ${doGitlab.length}`);
  console.log(`  tasks do cliente (originais): ${outros.length}`);
  console.log(`  possíveis duplicatas:      ${duplicados.length}`);
  console.log(`  lixo de teste:             ${sujos.length}`);

  // 2) Mappings no PRD (entity set no plural)
  const r2 = await fetch(
    `${PRD}/api/data/v9.2/pmo_mapeamentoplanners?$select=pmo_gitlab_iid,pmo_plannertaskid,pmo_plannerplanid,pmo_gitlab_updatedat&$filter=pmo_plannerplanid eq '${PLAN}'&$top=5000`,
    { headers: { Authorization: `Bearer ${prdToken}`, Accept: "application/json" } }
  );
  const j2 = await r2.json();
  if (j2.error) {
    console.log(`  mapping: erro ${JSON.stringify(j2.error).slice(0, 200)}`);
  } else {
    const maps = j2.value || [];
    const comTask = maps.filter((m) => !!m.pmo_plannertaskid);
    const comUpdatedAt = maps.filter((m) => !!m.pmo_gitlab_updatedat);
    console.log(`PRD pmo_mapeamentoplanner (plano=${PLAN}):`);
    console.log(`  linhas:                    ${maps.length}`);
    console.log(`  com pmo_plannertaskid:     ${comTask.length}`);
    console.log(`  com pmo_gitlab_updatedat:  ${comUpdatedAt.length}`);
    const ids = maps.map((m) => m.pmo_gitlab_iid).filter((v) => v != null);
    console.log(`  iids distintos:            ${new Set(ids).size}`);

    // Mapping órfão: aponta para uma task que não existe no plano.
    const idsDasTasks = new Set(tasks.map((t) => t.msdyn_projecttaskid));
    const orfaos = maps.filter((m) => m.pmo_plannertaskid && !idsDasTasks.has(m.pmo_plannertaskid));
    console.log(`  órfãos (task não existe):  ${orfaos.length}`);
    if (orfaos.length > 0) {
      console.log(`    → rode scripts/limpar-lixo-homologacao.js`);
    }
  }

  // 3) Amostra
  console.log("\nAmostra de tasks criadas:");
  for (const t of doGitlab.slice(0, 5)) console.log(`  ${t.msdyn_subject.slice(0, 70)}`);
})().catch((e) => {
  console.error("ERRO:", e.message);
  process.exit(1);
});
