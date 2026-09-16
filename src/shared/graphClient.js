"use strict";

const { ClientSecretCredential } = require("@azure/identity");
const { Client } = require("@microsoft/microsoft-graph-client");
const { TokenCredentialAuthenticationProvider } = require("@microsoft/microsoft-graph-client/authProviders/azureTokenCredentials");

function getGraphClient() {
  // Recria o client a cada chamada para evitar estado corrompido entre invocações
  // (cache de token expirado pode causar "Cannot read private member" no SDK Graph)
  const tenantId     = process.env.AZURE_TENANT_ID;
  const clientId     = process.env.AZURE_CLIENT_ID;
  const clientSecret = process.env.AZURE_CLIENT_SECRET;

  if (!tenantId || !clientId || !clientSecret) {
    throw new Error("Credenciais Azure AD app-only não configuradas (AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET).");
  }

  const credential = new ClientSecretCredential(tenantId, clientId, clientSecret);

  const authProvider = new TokenCredentialAuthenticationProvider(credential, {
    scopes: ["https://graph.microsoft.com/.default"],
  });

  return Client.initWithMiddleware({ authProvider });
}

module.exports = { getGraphClient };
