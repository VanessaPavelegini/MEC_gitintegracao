"use strict";
// Verifica se uma conta TEM DIREITO DE ESCRITA no Planner Premium.
//
// Usa o refresh token de TESTE (.premium-refresh-token.test.json) — o token de
// produção não é tocado. Para cada plano, tenta o caminho completo do sync:
//   msdyn_CreateOperationSetV1 → msdyn_PssCreateV2 → msdyn_ExecuteOperationSetV1
// O passo que falhar diz ONDE o acesso quebra (criar set / enfileirar / executar).
//
// Também faz um GET de leitura (listar buckets) para separar "não tem acesso
// nenhum" de "tem leitura mas não tem escrita".
//
// Uso:
//   node scripts/autorizar-conta-teste-premium.js   (antes, uma vez por conta)
//   node scripts/verificar-acesso-escrita-premium.js
//
// Resultado observado em 27/10/2026 com portaldedemandas@mec.gov.br:
//   LEITURA ✅  CRIAR SET ✅  ENFILEIRAR ✅  EXECUTAR ❌ "Permissions required:
//   Write." — nos dois planos (novo c0ecce95 e antigo c385351a).
//   Causa: falta o service plan DYN365_CDS_PROJECT na conta (ver o script de
//   autorização para o detalle).
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const settings = JSON.parse(fs.readFileSync(path.join(ROOT, "local.settings.json"), "utf8")).Values;
for (const [k, v] of Object.entries(settings)) if (v != null && process.env[k] === undefined) process.env[k] = String(v);

const ORG_URL = process.env.DATAVERSE_URL_PREMIUM || "https://orgcf194dda.crm.dynamics.com";
const TENANT = process.env.AZURE_TENANT_ID;
const CLIENT = process.env.AZURE_CLIENT_ID;
const TOKEN_FILE = path.join(ROOT, ".premium-refresh-token.test.json");

const PLANS = [
  { nome: "NOVO (c0ecce95)", id: "c0ecce95-1107-4343-8c05-bcf7c9a291f8", bucket: "be10a1da-0bd2-f111-84dc-7c1e520d9dbb" },
  { nome: "ANTIGO (c385351a)", id: "c385351a-e450-4d54-87ed-d54c57794f7b", bucket: "f704c207-84be-f111-a04d-7c1e520d9f67" },
];

async function accessToken() {
  const { refresh_token } = JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8"));
  const p = new URLSearchParams({
    grant_type: "refresh_token", client_id: CLIENT, refresh_token,
    scope: `${ORG_URL}/user_impersonation offline_access`,
  });
  const r = await fetch(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: p,
  });
  const j = await r.json();
  if (!j.access_token) throw new Error(`troca de token falhou: ${JSON.stringify(j).slice(0, 300)}`);
  return j.access_token;
}

function upnOf(token) {
  try { return JSON.parse(Buffer.from(token.split(".")[1], "base64").toString("utf8")).upn; } catch { return "?"; }
}

async function dv(path, { method = "GET", body, token }) {
  const r = await fetch(`${ORG_URL}/api/data/v9.2${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "OData-MaxVersion": "4.0", "OData-Version": "4.0",
      Accept: "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const t = await r.text();
  let p; try { p = t ? JSON.parse(t) : null; } catch { p = t; }
  if (r.status >= 400) {
    const e = new Error(`${method} ${path} → ${r.status}: ${p?.error?.message || p?.message || String(p).slice(0, 200)}`);
    e.status = r.status; e.body = p; throw e;
  }
  return p;
}

async function main() {
  const token = await accessToken();
  console.log(`Identidade do token: ${upnOf(token)}\nOrg: ${ORG_URL}\n`);

  for (const plan of PLANS) {
    console.log(`══════════ ${plan.nome} ══════════`);

    // 1) LEITURA
    try {
      const b = await dv(`/msdyn_projectbuckets?$filter=_msdyn_project_value eq '${plan.id}'&$top=5`, { token });
      console.log(`  LEITURA  ✅ ${(b.value || []).length} bucket(s) visível(is)`);
    } catch (e) { console.log(`  LEITURA  ❌ ${e.message}`); }

    // 2) ESCRITA via operation set
    const subject = `TESTE-acesso-${plan.id.slice(0, 8)}-${Date.now()}`;
    let setId = null;
    try {
      const r = await dv("/msdyn_CreateOperationSetV1", {
        method: "POST", token, body: { ProjectId: plan.id, Description: `TESTE de acesso — ${subject}` },
      });
      setId = r.OperationSetId || r.msdyn_OperationSetId;
      console.log(`  CRIAR SET ✅ ${setId}`);
    } catch (e) { console.log(`  CRIAR SET ❌ ${e.message}`); }

    if (setId) {
      try {
        await dv("/msdyn_PssCreateV2", {
          method: "POST", token,
          body: {
            OperationSetId: setId,
            EntityCollection: [{
              "@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttask",
              msdyn_projecttaskid: require("node:crypto").randomUUID(),
              msdyn_subject: subject,
              msdyn_description: "Task de teste de acesso — criada e removida automaticamente.",
              msdyn_start: "2026-10-27", msdyn_finish: "2026-11-03", msdyn_progress: 0,
              "msdyn_project@odata.bind": `/msdyn_projects(${plan.id})`,
              "msdyn_projectbucket@odata.bind": `/msdyn_projectbuckets(${plan.bucket})`,
            }],
          },
        });
        console.log(`  ENFILEIRAR ✅`);
      } catch (e) { console.log(`  ENFILEIRAR ❌ ${e.message}`); }

      try {
        await dv("/msdyn_ExecuteOperationSetV1", { method: "POST", token, body: { OperationSetId: setId } });
        console.log(`  EXECUTAR ✅ (sem erro — mas pode falhar assíncrono)`);
        // confere materialização
        for (let i = 0; i < 20; i++) {
          await new Promise((r) => setTimeout(r, 3000));
          const t = await dv(`/msdyn_projecttasks?$filter=_msdyn_project_value eq '${plan.id}' and msdyn_subject eq '${subject}'&$top=1`, { token });
          if ((t.value || []).length) { console.log(`  MATERIALIZOU ✅ task ${t.value[0].msdyn_projecttaskid}`); break; }
          if (i === 19) console.log(`  MATERIALIZOU ❌ (não apareceu em 60s)`);
        }
      } catch (e) { console.log(`  EXECUTAR ❌ ${e.message}`); }
    }
    console.log("");
  }
}

main().catch((e) => { console.error("Teste falhou:", e.message || e); process.exit(1); });
