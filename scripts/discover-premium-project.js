"use strict";
// One-shot: descobre o msdyn_projectid do projeto Premium no Dataverse
// e lista as 35 tasks existentes pra confirmar o schema.
//
// Uso: node scripts/discover-premium-project.js

const fs = require("fs");
const path = require("path");

const settingsPath = path.join(__dirname, "..", "local.settings.json");
const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
for (const [k, v] of Object.entries(settings.Values || {})) {
  if (v && process.env[k] === undefined) process.env[k] = v;
}

const { getDataverseClient } = require("../src/functions/gitlab-planner-sync/tableStorage");

(async () => {
  try {
    const client = await getDataverseClient();
    const base = client.defaults.baseURL;

    // 1. Listar todos os projetos msdyn_project — filtrar pelos nomes prováveis
    console.log(`[discover] baseURL=${base}`);
    console.log(`[discover] listando msdyn_projects (filtrando por nomes Premium/Automação)...`);

    const projectResp = await client.get("/msdyn_projects", {
      params: {
        $filter: "contains(msdyn_subject,'utoma') or contains(msdyn_subject,'remium') or contains(msdyn_subject,'Projeto')",
        $top: 50,
        $select: "msdyn_projectid,msdyn_subject,msdyn_projectmode,createdon,modifiedon",
      },
    });
    const projects = projectResp.data.value || [];
    console.log(`[discover] msdyn_projects encontrados: ${projects.length}`);
    for (const p of projects) {
      console.log(`  - ${p.msdyn_projectid} | ${p.msdyn_subject} | mode=${p.msdyn_projectmode} | created=${p.createdon}`);
    }

    // 2. Pra cada projeto candidato, contar tasks e mostrar 2 samples
    for (const p of projects) {
      console.log(`\n[discover] tasks do projeto "${p.msdyn_subject}" (${p.msdyn_projectid})...`);
      try {
        const tasksResp = await client.get("/msdyn_projecttasks", {
          params: {
            $filter: `_msdyn_project_value eq ${p.msdyn_projectid}`,
            $top: 5,
            $select: "msdyn_projecttaskid,msdyn_subject,msdyn_projectbucketid,createdon",
          },
        });
        const tasks = tasksResp.data.value || [];
        console.log(`  count (amostra até 5): ${tasks.length}`);
        for (const t of tasks) {
          console.log(`    - ${t.msdyn_projecttaskid} | ${t.msdyn_subject}`);
        }

        // Contar total via $count
        const countResp = await client.get("/msdyn_projecttasks", {
          params: {
            $filter: `_msdyn_project_value eq ${p.msdyn_projectid}`,
            $top: 5000,
            $count: true,
            $select: "msdyn_projecttaskid",
          },
        });
        console.log(`  TOTAL tasks: ${countResp.data["@odata.count"] ?? countResp.data.value.length}`);
      } catch (e) {
        console.log(`  ERRO ao listar tasks: ${e.message}`);
        if (e.response?.data) console.log(`  body=${JSON.stringify(e.response?.data)}`);
      }
    }

    // 3. Listar buckets do primeiro candidato (se houver)
    if (projects.length > 0) {
      const p = projects[0];
      console.log(`\n[discover] buckets do projeto "${p.msdyn_subject}"...`);
      try {
        const bucketsResp = await client.get("/msdyn_projectbuckets", {
          params: {
            $filter: `_msdyn_project_value eq ${p.msdyn_projectid}`,
            $top: 50,
            $select: "msdyn_projectbucketid,msdyn_name",
          },
        });
        const buckets = bucketsResp.data.value || [];
        console.log(`  buckets: ${buckets.length}`);
        for (const b of buckets) {
          console.log(`    - ${b.msdyn_projectbucketid} | ${b.msdyn_name}`);
        }
      } catch (e) {
        console.log(`  ERRO ao listar buckets: ${e.message}`);
      }
    }
  } catch (e) {
    console.error("ERRO fatal:", e.message);
    console.error(e.stack);
    process.exit(1);
  }
})();
