# Deploy

## Como fazer deploy

1. Abra o VS Code nesta pasta
2. Instale a extensao Azure Functions
3. Faca login na sua conta Azure
4. Botao direito na Function App `func-gitintegracao`
5. Selecione **Deploy to Function App**
6. Aguarde o deploy completar (2-3 min)

## Application Settings (Portal Azure)

Configure antes de testar.

### Variaveis necessarias

- AZURE_TENANT_ID
- AZURE_CLIENT_ID
- AZURE_CLIENT_SECRET
- DATAVERSE_URL
- PLANNER_PLAN_ID
- GITLAB_URL
- GITLAB_TOKEN
- GITLAB_PROJECT_ID
- GITLAB_BOARD_ID
- GITLAB_WEBHOOK_SECRET

Para os valores reais, consulte o arquivo local.settings.json (nao versionado).
Adicione os mesmos valores no Portal Azure em Configuration > Application settings.

## Endpoints

- POST /api/gitlab-planner-sync - Webhook GitLab
- GET /api/gitlab-planner-sync?iid=X - Sincronizar 1 issue
- GET /api/gitlab-planner-sync?bulk=true - Sincronizar todas abertas

## Troubleshooting

Erro de credenciais Azure AD:
- Verifique AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET
- Restart a Function App apos adicionar
