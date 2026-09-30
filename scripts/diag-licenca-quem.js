"use strict";
// Diagnóstico: qual conta do tenant tem licença Microsoft Project?
// Lista systemusers com islicensed=true na org Aplicativos PRD e detalha
// o erro 400 nas tabelas msdyn_project / msdyn_projectbucket.
//
// Uso: node scripts/diag-licenca-quem.js

const fs = require("fs");
const path = require("path");

const settings = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "local.settings.json"), "utf8")
);
for (const [k, v] of Object.entries(settings.Values || {})) {
  if (v && process.env[k] === undefined) process.env[k] = v;
}

const { getDataverseClient } = require("../src/functions/gitlab-planner-sync/tableStorage");

const APP_USER_ID = "837e9242-c502-f111-8407-00224836c197";

(async () => {
  const client = await getDataverseClient();
  console.log(`\nbaseURL=${client.defaults.baseURL}\n`);

  // 1. Quem tem licença
  console.log("== systemusers com islicensed=true ==");
  try {
    const r = await client.get("/systemusers", {
      params: {
        $select: "fullname,islicensed,isdisabled,accessmode,applicationid",
        $filter: "islicensed eq true",
        $top: 50,
      },
    });
    for (const u of r.data.value) {
      const isApp = u.systemuserid === APP_USER_ID;
      console.log(
        `  ${isApp ? ">>>" : "   "} ${u.fullname} | licensed=${u.islicensed}` +
          ` | disabled=${u.isdisabled} | accessMode=${u.accessmode}` +
          ` | appId=${u.applicationid || "-"}`
      );
    }
    console.log(`  total=${r.data.value.length}`);
  } catch (e) {
    console.log(`  ERRO: ${e.message}`);
  }

  // 2. Detalhe do 400 nas tabelas Premium
  console.log("\n== erro 400 em msdyn_project / msdyn_projectbucket ==");
  for (const tabela of ["msdyn_project", "msdyn_projectbucket"]) {
    try {
      const r = await client.get(`/${tabela}`, { params: { $top: 1 } });
      console.log(`  ${tabela}: OK status=${r.status} count=${r.data.value.length}`);
    } catch (e) {
      const body = e.response?.data?.error?.message || JSON.stringify(e.response?.data);
      console.log(`  ${tabela}: status=${e.response?.status} -> ${body}`);
    }
  }

  // 3. O App User vê a tabela? (consulta direta)
  console.log("\n== App User direto ==");
  try {
    const r = await client.get(`/systemusers(${APP_USER_ID})`, {
      params: { $select: "fullname,islicensed,isdisabled" },
    });
    console.log(`  ${JSON.stringify(r.data)}`);
  } catch (e) {
    console.log(`  ERRO: ${e.message}`);
  }
})();
