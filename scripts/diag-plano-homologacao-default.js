"use strict";
// Detalhes: campos da task, tabelas pmo_*, usuários, e teste de escrita (licença).
const fs = require("fs");
const path = require("path");
const axios = require("axios");

const ROOT = path.join(__dirname, "..");
const settings = JSON.parse(fs.readFileSync(path.join(ROOT, "local.settings.json"), "utf8"));
Object.entries(settings.Values).forEach(([k, v]) => {
  if (v !== undefined && v !== null) process.env[k] = String(v);
});

const BASE = "https://orgcf194dda.crm.dynamics.com";
const TARGET = "c385351a-e450-4d54-87ed-d54c57794f7b";

async function token() {
  const p = new URLSearchParams();
  p.append("grant_type", "client_credentials");
  p.append("client_id", process.env.AZURE_CLIENT_ID);
  p.append("client_secret", process.env.AZURE_CLIENT_SECRET);
  p.append("scope", `${BASE}/.default`);
  const r = await axios.post(
    `https://login.microsoftonline.com/${process.env.AZURE_TENANT_ID}/oauth2/v2.0/token`,
    p, { headers: { "Content-Type": "application/x-www-form-urlencoded" } });
  return r.data.access_token;
}
async function api(t, path_, params) {
  const r = await axios.get(`${BASE}/api/data/v9.2${path_}`, {
    params, headers: { Authorization: `Bearer ${t}`, "OData-Version": "4.0", "OData-MaxVersion": "4.0", Accept: "application/json" } });
  return r.data;
}
const guid = v => (v || "").toString().replace(/.*\((.*)\)/, "$1");

(async () => {
  const t = await token();

  // 1. amostra de task completa (campos)
  const tk = await api(t, "/msdyn_projecttasks", { $filter: `_msdyn_project_value eq ${TARGET}`, $top: 1 });
  const one = (tk.value || [])[0] || {};
  console.log("== campos msdyn_projecttask (Default) ==");
  console.log(Object.keys(one).filter(k => k.startsWith("msdyn_") || k.startsWith("_msdyn")).join("\n"));
  console.log("\namostra:", JSON.stringify({
    subject: one.msdyn_subject, bucketid: one.msdyn_bucketid, bucket_bind: one["msdyn_bucket@odata.bind"],
    project: one["msdyn_project@odata.bind"], id: one.msdyn_projecttaskid,
    pct: one.msdyn_percentcomplete, start: one.msdyn_start, finish: one.msdyn_finish,
  }, null, 2));

  // 2. contagem de tasks e buckets distintos
  const tk2 = await api(t, "/msdyn_projecttasks", { $filter: `_msdyn_project_value eq ${TARGET}`, $top: 5000, $count: true });
  console.log(`\ntotal tasks no alvo: ${tk2["@odata.count"] ?? (tk2.value || []).length}`);

  // 3. tabelas pmo_* na org Default
  for (const set of ["pmo_mapeamentoplanners", "pmo_tarefas"]) {
    try {
      const m = await api(t, `/${set}`, { $top: 1 });
      console.log(`\n${set}: existe, ${(m.value || []).length} registro(s) (top1)`);
      if ((m.value || []).length) console.log(JSON.stringify(m.value[0]).slice(0, 700));
    } catch (e) {
      console.log(`\n${set}: ERRO ${e.response?.status} ${JSON.stringify(e.response?.data).slice(0, 150)}`);
    }
  }

  // 4. systemusers por email
  for (const mail of ["portaldedemandas@mec.gov.br", "app-pnld", "antoniojunior@mec.gov.br"]) {
    try {
      const u = await api(t, "/systemusers", { $filter: `internalemailaddress eq '${mail}'`, $top: 5 });
      console.log(`\nuser ${mail}: ${(u.value || []).length}`);
      for (const x of u.value || []) {
        console.log(`  - ${x.fullname} | islicensed=${x.islicensed} | accessmode=${x.accessmode} | appid=${x.applicationid} | id=${x.systemuserid} | businessunit=${guid(x._owningbusinessunit_value)}`);
      }
    } catch (e) {
      console.log(`\nuser ${mail}: ERRO ${e.response?.status}`);
    }
  }
})().catch(e => console.error("ERRO:", e.message, e.response?.status, JSON.stringify(e.response?.data || "").slice(0, 400)));
