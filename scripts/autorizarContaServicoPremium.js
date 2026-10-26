"use strict";

// Script de USO ÚNICO (ou sempre que o refresh token expirar/for revogado) —
// autentica interativamente a conta de serviço portaldedemandas@mec.gov.br via
// device code flow e salva o refresh token no Blob Storage, de onde
// src/shared/dataverseServiceAccountAuth.js lê pra gerar access tokens novos
// (delegados) a cada página do sync Premium.
//
// Por que device code: a escrita no Planner Premium exige identidade de
// usuário com licença ModernProject — o app user app-pnld (client credentials)
// é bloqueado com UserNotLicensed.
//
// Como rodar (localmente, com local.settings.json presente na raiz):
//   node scripts/autorizarContaServicoPremium.js
//
// O script imprime uma URL + código. Abra a URL em qualquer navegador, entre
// com o código e faça login com a conta portaldedemandas@mec.gov.br (e a
// senha/MFA dela). O script fica em polling até a autenticação ser concluída
// e então grava o refresh token no Blob.
//
// Onde o token é gravado: container `service-tokens`, blob
// `premium-dataverse-refresh-token.json`, na Storage Account do Function App
// func-gitintegracao (rgpnldapphmgmec82e9) — é dela que a Function lê
// (AzureWebJobsStorage). Também deixa uma cópia local em
// .premium-refresh-token.json (ignorado pelo git) para rodar `func start`
// na máquina.

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
if (!globalThis.crypto) globalThis.crypto = require("node:crypto").webcrypto;
const { BlobServiceClient } = require("@azure/storage-blob");

const ORG_URL = process.env.DATAVERSE_URL_PREMIUM || "https://orgcf194dda.crm.dynamics.com";
const CONTAINER = process.env.PREMIUM_SYNC_BLOB_CONTAINER || "service-tokens";
const BLOB_NAME = process.env.PREMIUM_SYNC_BLOB_NAME || "premium-dataverse-refresh-token.json";
const LOCAL_COPY = path.join(__dirname, "..", ".premium-refresh-token.json");
const FUNCTION_APP = "func-gitintegracao";
const RESOURCE_GROUP = "rg-pnld-app-hmg-mec";
const SUBSCRIPTION = "ccmecapppnld13383hom";

function carregarLocalSettings() {
  const settingsPath = path.join(__dirname, "..", "local.settings.json");
  if (!fs.existsSync(settingsPath)) return;
  const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8")).Values;
  for (const [key, value] of Object.entries(settings)) {
    if (!process.env[key] && value != null) process.env[key] = String(value);
  }
}

function connectionStringDoFunctionApp() {
  if (process.env.AZURE_STORAGE_CONNECTION_STRING) return process.env.AZURE_STORAGE_CONNECTION_STRING;
  if (process.env.AzureWebJobsStorage) return process.env.AzureWebJobsStorage;

  // Fallback: lê do Function App via az CLI (a conta logada tem acesso).
  try {
    const out = execFileSync(
      "az",
      [
        "functionapp", "config", "appsettings", "list",
        "--subscription", SUBSCRIPTION,
        "--name", FUNCTION_APP,
        "--resource-group", RESOURCE_GROUP,
        "--query", "[?name=='AzureWebJobsStorage'].value | [0]",
        "-o", "tsv",
      ],
      { encoding: "utf8" }
    ).trim();
    if (out) return out;
  } catch (e) {
    console.error("Não foi possível ler o AzureWebJobsStorage via az CLI:", e.message);
  }
  return null;
}

async function iniciarDeviceCodeFlow() {
  const params = new URLSearchParams({
    client_id: process.env.AZURE_CLIENT_ID,
    scope: `${ORG_URL}/user_impersonation offline_access`,
  });
  const res = await fetch(`https://login.microsoftonline.com/${process.env.AZURE_TENANT_ID}/oauth2/v2.0/devicecode`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params,
  });
  if (!res.ok) throw new Error(`Falha ao iniciar device code flow: ${res.status} ${await res.text()}`);
  return res.json();
}

async function aguardarLogin(deviceCode, intervaloSeg) {
  // Sem client_secret: o refresh token de cliente público é rejeitado pelo
  // AAD quando vem acompanhado de secret (AADSTS700025).
  const params = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    client_id: process.env.AZURE_CLIENT_ID,
    device_code: deviceCode,
  });

  for (;;) {
    await new Promise((r) => setTimeout(r, intervaloSeg * 1000));
    const res = await fetch(`https://login.microsoftonline.com/${process.env.AZURE_TENANT_ID}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params,
    });
    const data = await res.json();
    if (res.ok) return data;
    if (data.error === "authorization_pending") { process.stdout.write("."); continue; }
    if (data.error === "slow_down") { intervaloSeg += 5; continue; }
    if (data.error === "expired_token") {
      const e = new Error("expired_token");
      e.code = "expired_token";
      throw e;
    }
    if (data.error === "access_denied") {
      throw new Error(`Login não concluído: ${data.error} — ${data.error_description || ""}`);
    }
    throw new Error(`Falha no login: ${data.error} — ${data.error_description || ""}`);
  }
}

async function salvarRefreshToken(refreshToken) {
  const connStr = connectionStringDoFunctionApp();
  if (connStr) {
    const serviceClient = BlobServiceClient.fromConnectionString(connStr);
    const containerClient = serviceClient.getContainerClient(CONTAINER);
    await containerClient.createIfNotExists();
    const blobClient = containerClient.getBlockBlobClient(BLOB_NAME);
    const body = JSON.stringify({ refresh_token: refreshToken, updated_at: new Date().toISOString() });
    await blobClient.upload(body, Buffer.byteLength(body), { overwrite: true });
  } else {
    console.warn("Sem connection string do storage — gravando só a cópia local.");
  }

  fs.writeFileSync(
    LOCAL_COPY,
    JSON.stringify({ refresh_token: refreshToken, updated_at: new Date().toISOString() }, null, 2)
  );
}

async function main() {
  carregarLocalSettings();

  if (!process.env.AZURE_CLIENT_ID || !process.env.AZURE_TENANT_ID) {
    throw new Error("AZURE_CLIENT_ID / AZURE_TENANT_ID não configurados (local.settings.json).");
  }

  console.log(`Autorizando a conta de serviço na org ${ORG_URL}\n`);

  // O device code do AAD expira em 15 min. Em vez de encerrar, o script
  // emite um código novo e continua esperando — assim o terminal pode ficar
  // rodando até a pessoa ter chance de autorizar.
  const MAX_RENOVACOES = 8;
  let tokens = null;
  for (let tentativa = 0; tentativa <= MAX_RENOVACOES; tentativa++) {
    const device = await iniciarDeviceCodeFlow();
    console.log(device.message + "\n");
    console.log(">>> Autorize em até 15 minutos e deixe este terminal rodando.\n");
    process.stdout.write("Aguardando login");

    try {
      tokens = await aguardarLogin(device.device_code, device.interval || 5);
      break;
    } catch (e) {
      if (e.code !== "expired_token" || tentativa === MAX_RENOVACOES) throw e;
      console.log("\n\nCódigo expirado — emitindo um novo código.\n");
    }
  }
  console.log("\n\nLogin concluído!");

  await salvarRefreshToken(tokens.refresh_token);
  console.log(`Refresh token salvo no Blob (${CONTAINER}/${BLOB_NAME}) e em ${path.basename(LOCAL_COPY)}.`);
  console.log("A Function syncGitLabPlannerPremiumHomologacao já pode escrever no Planner Premium.");
}

main().catch((err) => {
  console.error("\nErro:", err.message || err);
  process.exit(1);
});
