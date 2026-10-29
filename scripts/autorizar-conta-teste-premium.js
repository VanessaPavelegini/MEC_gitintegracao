"use strict";
// Device code flow SALVO EM ARQUIVO SEPARADO.
// NÃO toca no .premium-refresh-token.json nem no Blob (token de produção do
// antoniojunior). Serve para gerar um refresh token de QUALQUER conta
// (ex.: portaldedemandas) e testar a escrita no Planner Premium sem risco.
//
// Uso:
//   node scripts/autorizar-conta-teste-premium.js
// depois:
//   node scripts/verificar-acesso-escrita-premium.js
//
// Contexto (27/10/2026): a portaldedemandas@mec.gov.br LE e ENFILEIRA, mas o
// msdyn_ExecuteOperationSetV1 responde "Forbidden — Permissions required:
// Write." nos DOIS planos. Causa raiz: a conta não tem o service plan
// DYN365_CDS_PROJECT (Dataverse for Project) — só o M365EDU_A5_FACULTY com
// PROJECT_O365_P3. O antoniojunior tem PROJECTPROFESSIONAL_FACULTY (que
// traz DYN365_CDS_PROJECT + PROJECT_CLIENT_SUBSCRIPTION) e por isso escreve.
// Reexecute o verificador depois de atribuir a licença.
const fs = require("fs");
const path = require("path");

const OUT = path.join(__dirname, "..", ".premium-refresh-token.test.json");
const settingsPath = path.join(__dirname, "..", "local.settings.json");
if (fs.existsSync(settingsPath)) {
  const s = JSON.parse(fs.readFileSync(settingsPath, "utf8")).Values;
  for (const [k, v] of Object.entries(s)) if (v != null && process.env[k] === undefined) process.env[k] = String(v);
}
const ORG_URL = process.env.DATAVERSE_URL_PREMIUM || "https://orgcf194dda.crm.dynamics.com";
const TENANT = process.env.AZURE_TENANT_ID;
const CLIENT = process.env.AZURE_CLIENT_ID;

async function deviceCode() {
  const params = new URLSearchParams({ client_id: CLIENT, scope: `${ORG_URL}/user_impersonation offline_access` });
  const res = await fetch(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/devicecode`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: params,
  });
  if (!res.ok) throw new Error(`devicecode ${res.status} ${await res.text()}`);
  return res.json();
}

async function poll(device_code, interval) {
  const params = new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:device_code", client_id: CLIENT, device_code });
  for (;;) {
    await new Promise((r) => setTimeout(r, interval * 1000));
    const res = await fetch(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: params,
    });
    const data = await res.json();
    if (res.ok) return data;
    if (data.error === "authorization_pending") { process.stdout.write("."); continue; }
    if (data.error === "slow_down") { interval += 5; continue; }
    if (data.error === "expired_token") { const e = new Error("expired_token"); e.code = "expired_token"; throw e; }
    throw new Error(`login falhou: ${data.error} — ${data.error_description || ""}`);
  }
}

(async () => {
  for (let i = 0; i < 8; i++) {
    const d = await deviceCode();
    console.log(d.message);
    console.log(">>> Autorize em até 15 minutos (terminal continua rodando).\n");
    try {
      const t = await poll(d.device_code, d.interval || 5);
      fs.writeFileSync(OUT, JSON.stringify({ refresh_token: t.refresh_token, updated_at: new Date().toISOString() }, null, 2));
      const upn = (() => { try { return JSON.parse(Buffer.from(t.access_token.split(".")[1], "base64").toString("utf8")).upn; } catch { return "?"; } })();
      console.log(`\n\nOK. Token de ${upn} salvo em ${path.basename(OUT)} (NÃO sobrescreveu o token de produção).`);
      process.exit(0);
    } catch (e) {
      if (e.code !== "expired_token" || i === 7) { console.error("\nErro:", e.message); process.exit(1); }
      console.log("\n\nCódigo expirou — emitindo novo código.\n");
    }
  }
})();
