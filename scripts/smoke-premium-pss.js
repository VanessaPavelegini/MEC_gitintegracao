"use strict";
// Smoke test do Premium (Dataverse Project) — fluxo correto de 3 chamadas.
//
// Assinaturas reais (extraídas do $metadata):
//   msdyn_CreateOperationSetV1  (ProjectId: string, Description: string)
//   msdyn_PssCreateV1           (Entity: crmbaseentity, OperationSetId: string)
//   msdyn_ExecuteOperationSetV1 (OperationSetId: string)
//
// POST direto em /msdyn_projecttasks NÃO funciona: o Dataverse recusa com
// "Não é possível executar diretamente a operação Create para msdyn_projecttask".
// Por isso existe o Operation Set.
//
// IMPORTANTE: o cliente axios de tableStorage.js embrulha o body em {data:...},
// fazendo o Dataverse responder "Invalid property 'data'" e esconder o erro real.
// Este script usa fetch puro de propósito.
//
// Uso: node scripts/smoke-premium-pss.js [--keep]

const fs = require("fs");
const path = require("path");
const axios = require("axios");

const settings = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "local.settings.json"), "utf8")
);
for (const [k, v] of Object.entries(settings.Values || {})) {
  if (v && process.env[k] === undefined) process.env[k] = v;
}

const BASE = `${process.env.DATAVERSE_URL}/api/data/v9.2`;
const PROJ = "8ebc738c-bcb3-f111-aaab-00224836dcc6";
const KEEP = process.argv.includes("--keep");

async function token() {
  const p = new URLSearchParams();
  p.append("grant_type", "client_credentials");
  p.append("client_id", process.env.AZURE_CLIENT_ID);
  p.append("client_secret", process.env.AZURE_CLIENT_SECRET);
  p.append("scope", `${process.env.DATAVERSE_URL}/.default`);
  const r = await axios.post(
    `https://login.microsoftonline.com/${process.env.AZURE_TENANT_ID}/oauth2/v2.0/token`,
    p,
    { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
  );
  return r.data.access_token;
}

async function call(tok, method, route, body) {
  const r = await fetch(`${BASE}${route}`, {
    method,
    headers: {
      Authorization: `Bearer ${tok}`,
      "Content-Type": "application/json",
      "OData-MaxVersion": "4.0",
      "OData-Version": "4.0",
      Accept: "application/json",
      Prefer: "return=representation",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const txt = await r.text();
  let parsed;
  try { parsed = JSON.parse(txt); } catch { parsed = txt; }
  return { status: r.status, body: parsed };
}

const msg = (r) => r?.body?.error?.message || JSON.stringify(r?.body);
const log = (n, r) => console.log(`\n[${n}] status=${r.status}\n${msg(r).slice(0, 700)}`);

(async () => {
  const tok = await token();
  const subject = `SMOKE-pss-${Date.now()}`;

  const b = await call(tok, "GET", "/msdyn_projectbuckets?$select=msdyn_projectbucketid,msdyn_name,msdyn_project&$top=50");
  if (b.status !== 200) return console.log("buckets falhou:", b.status, msg(b));
  const bucket = b.body.value.find((x) => x.msdyn_project === PROJ) || b.body.value[0];
  console.log(`bucket: ${bucket.msdyn_name} (${bucket.msdyn_projectbucketid})`);

  // 1) Cria o Operation Set
  const c1 = await call(tok, "POST", "/msdyn_CreateOperationSetV1", {
    ProjectId: PROJ,
    Description: `Smoke test ${subject}`,
  });
  log("1 CreateOperationSetV1", c1);
  if (c1.status !== 200) return;

  const setId = c1.body?.OperationSetId || c1.body?.msdyn_OperationSetId;
  console.log(`OperationSetId = ${setId}`);
  if (!setId) return console.log("sem OperationSetId no retorno — não dá pra seguir");

  // 2) Enfileira a criação da task dentro do set
  const c2 = await call(tok, "POST", "/msdyn_PssCreateV1", {
    OperationSetId: setId,
    Entity: {
      "@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttask",
      "msdyn_project@odata.bind": `/msdyn_projects(${PROJ})`,
      "msdyn_projectbucket@odata.bind": `/msdyn_projectbuckets(${bucket.msdyn_projectbucketid})`,
      msdyn_subject: subject,
    },
  });
  log("2 PssCreateV1", c2);
  if (c2.status !== 200) return;

  // 3) Executa o set
  const c3 = await call(tok, "POST", "/msdyn_ExecuteOperationSetV1", { OperationSetId: setId });
  log("3 ExecuteOperationSetV1", c3);

  // Confere se a task apareceu
  const q = await call(
    tok, "GET",
    `/msdyn_projecttasks?$select=msdyn_projecttaskid,msdyn_subject&$filter=msdyn_subject eq '${encodeURIComponent(subject)}'`
  );
  const found = q.body?.value?.[0];
  console.log(`\n==> task: ${found ? `CRIADA ${found.msdyn_projecttaskid}` : "não encontrada"}`);

  if (found && !KEEP) {
    const d = await call(tok, "DELETE", `/msdyn_projecttasks(${found.msdyn_projecttaskid})`);
    console.log(`cleanup DELETE status=${d.status}`);
  } else if (found) {
    console.log(`mantida para inspeção: ${found.msdyn_projecttaskid}`);
  }
})();
