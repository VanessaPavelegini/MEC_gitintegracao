"use strict";
// Schema da tabela de mapeamento (Aplicativos PRD) + distribuição de buckets no plano alvo.
const fs = require("fs");
const path = require("path");
const axios = require("axios");

const ROOT = path.join(__dirname, "..");
const settings = JSON.parse(fs.readFileSync(path.join(ROOT, "local.settings.json"), "utf8"));
Object.entries(settings.Values).forEach(([k, v]) => {
  if (v !== undefined && v !== null) process.env[k] = String(v);
});

const PRD = "https://org41ecace2.crm2.dynamics.com";
const DEF = "https://orgcf194dda.crm.dynamics.com";
const TARGET = "c385351a-e450-4d54-87ed-d54c57794f7b";

async function token(base) {
  const p = new URLSearchParams();
  p.append("grant_type", "client_credentials");
  p.append("client_id", process.env.AZURE_CLIENT_ID);
  p.append("client_secret", process.env.AZURE_CLIENT_SECRET);
  p.append("scope", `${base}/.default`);
  const r = await axios.post(
    `https://login.microsoftonline.com/${process.env.AZURE_TENANT_ID}/oauth2/v2.0/token`,
    p, { headers: { "Content-Type": "application/x-www-form-urlencoded" } });
  return r.data.access_token;
}
async function api(t, base, path_, params) {
  const r = await axios.get(`${base}/api/data/v9.2${path_}`, {
    params, headers: { Authorization: `Bearer ${t}`, "OData-Version": "4.0", "OData-MaxVersion": "4.0", Accept: "application/json" } });
  return r.data;
}

(async () => {
  // 1. schema pmo_mapeamentoplanner
  const tp = await token(PRD);
  const meta = await api(tp, PRD, "/EntityDefinitions(LogicalName='pmo_mapeamentoplanner')/Attributes");
  console.log("== colunas pmo_mapeamentoplanner ==");
  for (const a of meta.value || []) {
    const type = a.AttributeType === "Lookup"
      ? `Lookup -> ${(a.MetadataName || "").match(/pmo_(planner|tarefa|projeto)/i) ? "" : ""}${a.LogicalName}`
      : a.AttributeType;
    console.log(`- ${a.LogicalName} (${a.SchemaName}) ${a.AttributeType}${a.MaxLength ? " maxlen=" + a.MaxLength : ""}${a.IsValidForUpdate === false ? " (readonly)" : ""}`);
  }

  // 2. amostra de mappings do plano classico
  const m = await api(tp, PRD, "/pmo_mapeamentoplanners", { $top: 3 });
  console.log("\n== amostra mappings ==");
  for (const r of m.value || []) {
    console.log(JSON.stringify({
      id: r.pmo_mapeamentoplannerid, iid: r.pmo_gitlab_iid, plan: r.pmo_plannerplanid,
      task: r.pmo_plannertaskid, bucket: r.pmo_plannerbucketid, pwaTaskUid: r.pmo_pwataskuid,
      pwaProu: r.pmo_pwaprouid, lastSync: r.pmo_dataultimasincronizacao, status: r.pmo_statussincronizacao,
      projeto: r._pmo_projeto_id_value,
    }));
  }

  // 3. distribuição de buckets no plano alvo (Default)
  const td = await token(DEF);
  const tasks = await api(td, DEF, "/msdyn_projecttasks", { $filter: `_msdyn_project_value eq ${TARGET}`, $top: 5000 });
  const dist = {};
  let comBucket = 0;
  for (const x of tasks.value || []) {
    const b = x._msdyn_projectbucket_value || "(null)";
    dist[b] = (dist[b] || 0) + 1;
    if (x._msdyn_projectbucket_value) comBucket++;
  }
  console.log(`\n== buckets usados nas tasks do plano alvo (total ${(tasks.value || []).length}) ==`);
  console.log(dist, "| com bucket:", comBucket);

  const buckets = await api(td, DEF, "/msdyn_projectbuckets", { $filter: `_msdyn_project_value eq ${TARGET}`, $top: 50 });
  console.log("\n== buckets do plano alvo ==");
  for (const b of buckets.value || []) console.log(`- ${b.msdyn_name} | ${b.msdyn_projectbucketid} | order=${b.msdyn_orderindex} | isdefault=${b.msdyn_isdefault}`);

  // 4. sample de tasks novas do GitLab x titulos existentes: existe task com prefixo [#iid]?
  const titulos = (tasks.value || []).map(x => x.msdyn_subject || "");
  const comPrefixo = titulos.filter(t => /^\[#\d+\]/.test(t));
  console.log(`\ntasks com prefixo "[#iid]": ${comPrefixo.length} (ex: ${comPrefixo.slice(0, 5).join(" | ")})`);
  console.log("exemplos sem prefixo:", titulos.slice(0, 5).join(" | "));
})().catch(e => console.error("ERRO:", e.message, e.response?.status, JSON.stringify(e.response?.data || "").slice(0, 400)));
