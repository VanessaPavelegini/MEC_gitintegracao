"use strict";

// Script de USO ÚNICO — cria a coluna pmo_gitlab_updatedat na tabela
// pmo_mapeamentoplanner (Aplicativos PRD).
//
// Por que a coluna: é ela que guarda o `updated_at` da issue no momento do
// último sync — sem ela não há como decidir "a issue mudou?" (o sync só
// atualiza a task quando a issue foi alterada depois do último sync).
// A coluna pmo_dataultimasincronizacao (que já existe) guarda o instante da
// sincronização, não o da alteração da issue — não serve para o diff.
//
// Idempotente: se a coluna já existir, não faz nada.
//
// Como rodar (da raiz do projeto):
//   node scripts/criar-coluna-pmo-gitlab-updatedat.js

const fs = require("fs");
const path = require("path");
const axios = require("axios");

const LOGICAL_NAME = "pmo_gitlab_updatedat";
const TARGET_TABLE = "pmo_mapeamentoplanner";

function carregarLocalSettings() {
  const settingsPath = path.join(__dirname, "..", "local.settings.json");
  if (!fs.existsSync(settingsPath)) return;
  const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8")).Values;
  for (const [key, value] of Object.entries(settings)) {
    if (!process.env[key] && value != null) process.env[key] = String(value);
  }
}

async function getToken() {
  const params = new URLSearchParams();
  params.append("grant_type", "client_credentials");
  params.append("client_id", process.env.AZURE_CLIENT_ID);
  params.append("client_secret", process.env.AZURE_CLIENT_SECRET);
  params.append("scope", `${process.env.DATAVERSE_URL}/.default`);

  const res = await axios.post(
    `https://login.microsoftonline.com/${process.env.AZURE_TENANT_ID}/oauth2/v2.0/token`,
    params.toString(),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
  );
  return res.data.access_token;
}

function headers(token) {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "OData-Version": "4.0",
    "OData-MaxVersion": "4.0",
  };
}

async function listarAtributos(token, baseUrl) {
  const res = await axios.get(
    `${baseUrl}/api/data/v9.2/EntityDefinitions(LogicalName='${TARGET_TABLE}')/Attributes`,
    { headers: headers(token) }
  );
  return res.data.value || [];
}

async function criarAtributo(token, baseUrl) {
  // Payload que o Dataverse aceita (nesta org, na API v9.2):
  //   - o tipo vem em "@odata.type" (não em "AttributeType" — com o nome curto
  //     ou completo no atributo errado, o Dataverse responde
  //     "Attribute of type AttributeMetadata cannot be created through the SDK");
  //   - "Format" é obrigatório e o único valor aceito aqui é "DateAndTime";
  //   - "DisplayName" é obrigatório e precisa vir como
  //     { LocalizedLabels: [{ Label, LanguageCode }] } — string simples ou
  //     { Value, LanguageCode } dão erro de payload OData.
  const payload = {
    "@odata.type": "#Microsoft.Dynamics.CRM.DateTimeAttributeMetadata",
    LogicalName: LOGICAL_NAME,
    SchemaName: LOGICAL_NAME,
    AttributeOf: null,
    Format: "DateAndTime",
    DisplayName: {
      LocalizedLabels: [{ Label: "GitLab Updated At", LanguageCode: 1046 }],
    },
  };
  const res = await axios.post(
    `${baseUrl}/api/data/v9.2/EntityDefinitions(LogicalName='${TARGET_TABLE}')/Attributes`,
    payload,
    { headers: headers(token) }
  );
  return res.data;
}

async function main() {
  carregarLocalSettings();

  const baseUrl = process.env.DATAVERSE_URL;
  if (!baseUrl) throw new Error("DATAVERSE_URL não configurada (local.settings.json).");

  const token = await getToken();
  console.log(`Org: ${baseUrl}`);

  const atributos = await listarAtributos(token, baseUrl);
  const existente = atributos.find((a) => a.LogicalName === LOGICAL_NAME);

  if (existente) {
    console.log(`Coluna ${LOGICAL_NAME} JÁ EXISTE (tipo ${existente.AttributeType}). Nada a fazer.`);
    return;
  }

  const criada = await criarAtributo(token, baseUrl);
  console.log(`Coluna ${LOGICAL_NAME} criada: ${JSON.stringify(criada.LogicalName || LOGICAL_NAME)}`);

  // Confirma
  const depois = await listarAtributos(token, baseUrl);
  const confere = depois.find((a) => a.LogicalName === LOGICAL_NAME);
  console.log(confere ? `OK — ${LOGICAL_NAME} presente no schema.` : "ATENÇÃO: coluna não apareceu no schema.");
}

main().catch((err) => {
  console.error("Erro:", err.message || err);
  if (err.response) console.error(JSON.stringify(err.response.data).substring(0, 600));
  process.exit(1);
});
