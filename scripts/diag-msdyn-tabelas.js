"use strict";
// As tabelas msdyn_* do Project (Project Service Core) ainda existem no
// Aplicativos PRD? Compara o conjunto exposto no $metadata com o esperado.
//
// Uso: node scripts/diag-msdyn-tabelas.js

const fs = require("fs");
const path = require("path");

const settings = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "local.settings.json"), "utf8")
);
for (const [k, v] of Object.entries(settings.Values || {})) {
  if (v && process.env[k] === undefined) process.env[k] = v;
}

const { getDataverseClient } = require("../src/functions/gitlab-planner-sync/tableStorage");

(async () => {
  const client = await getDataverseClient();
  const base = client.defaults.baseURL;

  // 1. Conjunto de EntitySets msdyn_* exposto na API
  const meta = await client.get("/$metadata", {
    headers: { Accept: "application/xml", "OData-MaxVersion": "4.0", "OData-Version": "4.0" },
  });
  const xml = typeof meta.data === "string" ? meta.data : JSON.stringify(meta.data);
  const sets = [...xml.matchAll(/EntitySet Name="(msdyn_[A-Za-z0-9_]+)"/g)].map((m) => m[1]);
  const uniq = [...new Set(sets)].sort();
  console.log(`\nEntitySets msdyn_* expostos: ${uniq.length}`);
  console.log(uniq.join("\n"));

  // 2. As entidades-chave do Project existem?
  console.log("\n== presença das entidades do Project ==");
  for (const e of [
    "msdyn_project",
    "msdyn_projecttask",
    "msdyn_projectbucket",
    "msdyn_projectteam",
    "msdyn_operationalizedresources",
  ]) {
    console.log(`  ${e}: ${uniq.includes(e) ? "EXPOSTA" : "*** AUSENTE ***"}`);
  }

  // 3. Operation Sets do Project ainda existem?
  console.log("\n== msdyn_ExecuteOperationSetV1 ==");
  try {
    const r = await client.post("/msdyn_ExecuteOperationSetV1", {
      data: {
        OperationSet: {
          Request: [{ OperationId: "Sample", OperationInput: { Parameters: [] } }],
        },
      },
    });
    console.log(`  status=${r.status}`);
  } catch (e) {
    const m = e.response?.data?.error?.message || e.message;
    console.log(`  status=${e.response?.status} -> ${m}`);
  }

  console.log(`\nbase=${base}`);
})();
