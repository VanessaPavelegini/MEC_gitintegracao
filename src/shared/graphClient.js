"use strict";

const { ClientSecretCredential } = require("@azure/identity");
const { Client } = require("@microsoft/microsoft-graph-client");
const { TokenCredentialAuthenticationProvider } = require("@microsoft/microsoft-graph-client/authProviders/azureTokenCredentials");

let _client = null;

function getGraphClient() {
  if (_client) return _client;

  const credential = getAppCredential();
  const authProvider = new TokenCredentialAuthenticationProvider(credential, {
    scopes: ["https://graph.microsoft.com/.default"],
  });

  _client = Client.initWithMiddleware({ authProvider });
  return _client;
}

function getAppCredential() {
  const tenantId     = process.env.DATAVERSE_TENANT_ID;
  const clientId     = process.env.DATAVERSE_CLIENT_ID;
  const clientSecret = process.env.DATAVERSE_CLIENT_SECRET;
  if (!tenantId || !clientId || !clientSecret) {
    throw new Error("Credenciais Azure AD app-only não configuradas (DATAVERSE_TENANT_ID, DATAVERSE_CLIENT_ID, DATAVERSE_CLIENT_SECRET).");
  }
  return new ClientSecretCredential(tenantId, clientId, clientSecret);
}

module.exports = { getGraphClient };
