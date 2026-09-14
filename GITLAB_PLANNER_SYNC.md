# Guia de Configuração: GitLab Planner Sync

## Visão Geral

Esta function sincroniza tarefas entre o GitLab e o Microsoft Planner:
- Quando uma **nova issue** é criada no GitLab → cria tarefa no Planner
- Quando uma **issue é alterada** no GitLab → atualiza a tarefa no Planner
- Usa **labels do GitLab** para determinar o **bucket** no Planner

---

## Estrutura de Arquivos

```
MEC_gitintegracao/
├── index.js                           # Entry point
├── package.json                       # Dependências
├── host.json                          # Configuração Azure Functions
├── local.settings.json                # Configurações
├── GITLAB_PLANNER_SYNC.md            # Este guia
└── src/
    ├── shared/
    │   └── graphClient.js             # Autenticação Graph API
    └── functions/
        └── gitlab-planner-sync/       # ← Módulo da function
            ├── index.js
            ├── gitlabService.js       # Comunicação com GitLab API
            ├── tableStorage.js        # Azure Table Storage
            └── syncGitLabPlanner.js   # Function principal
```

---

## 1. Configurar Azure Table Storage

### 1.1 Criar Storage Account (se não existir)

1. Acesse o [Portal Azure](https://portal.azure.com)
2. Criar novo recurso → Storage Account
3. Anote a **Connection String** (em Access Keys)

### 1.2 Criar Tabela

1. No Storage Account, vá em **Tables**
2. Clique em **+ Table**
3. Nome: `GitLabPlannerMapping`

### 1.3 Atualizar local.settings.json

```json
{
  "TABLE_STORAGE_CONN_STRING": "DefaultEndpointsProtocol=https;AccountName=SEU_STORAGE;AccountKey=SUA_CHAVE;EndpointSuffix=core.windows.net"
}
```

---

## 2. Configurar GitLab

### 2.1 Criar Personal Access Token

1. Acesse: `https://gitlabbuilder.mec.gov.br/-/profile/personal_access_tokens`
2. Crie token com scopes:
   - ✅ `read_api`
   - ✅ `api`
3. Copie o token (começa com `glpat-`)

### 2.2 Configurar Webhook

1. Acesse: `https://gitlabbuilder.mec.gov.br/doc-sis/documentacao-novosistec2/-/settings/webhooks`
2. URL: `https://SUA-FUNCTION-APP.azurewebsites.net/api/gitlab-planner-sync`
3. Secret Token: Gere uma string aleatória (ex: `openssl rand -hex 32`)
4. Selecione triggers:
   - ✅ **Issue** → Create
   - ✅ **Issue** → Update
   - ✅ **Issue** → Close
   - ✅ **Issue** → Reopen
5. Marque **Enable SSL verification** (se tiver certificado válido)
6. Clique em **Add webhook**

### 2.3 Atualizar local.settings.json

```json
{
  "GITLAB_TOKEN": "glpat-SEU-TOKEN-AQUI",
  "GITLAB_WEBHOOK_SECRET": "SEU-SECRET-GERADO"
}
```

---

## 3. Configurar Planner

### 3.1 Verificar Plan ID

O Plan ID já está configurado: `V6eQb5zdBkWHqIzlDh68o2UACro8`

Para verificar:
1. Acesse: `https://planner.cloud.microsoft/webui/plan/V6eQb5zdBkWHqIzlDh68o2UACro8`
2. Confirme que é o plano correto

### 3.2 Buckets que serão criados automaticamente

| Label GitLab | Bucket Planner |
|--------------|---------------|
| `to do`, `backlog` | Backlog |
| `em análise`, `analise` | Análise |
| `in progress`, `em desenvolvimento` | Em Desenvolvimento |
| `review`, `in review` | Revisão |
| `pronto`, `done`, `concluído` | Pronto |
| `blocked`, `bloqueado` | Bloqueado |

---

## 4. Atualizar local.settings.json

```json
{
  "IsEncrypted": false,
  "Values": {
    "AzureWebJobsStorage": "UseDevelopmentStorage=true",
    "FUNCTIONS_WORKER_RUNTIME": "node",
    "AZURE_TENANT_ID": "b8c25932-5e76-4b2b-9c53-d41745e9c92d",
    "AZURE_CLIENT_ID": "18fb3c07-66df-40a0-86d6-5d2d84dea60f",
    "AZURE_CLIENT_SECRET": "<cole-seu-client-secret-aqui>",
    "PLANNER_PLAN_ID": "V6eQb5zdBkWHqIzlDh68o2UACro8",
    "GITLAB_URL": "https://gitlabbuilder.mec.gov.br",
    "GITLAB_TOKEN": "<cole-seu-gitlab-token-aqui>",
    "GITLAB_PROJECT_ID": "doc-sis/documentacao-novosistec2",
    "GITLAB_BOARD_ID": "92",
    "GITLAB_WEBHOOK_SECRET": "cole-seu-secret-aqui",
    "TABLE_STORAGE_CONN_STRING": "DefaultEndpointsProtocol=https;AccountName=SEU_STORAGE;AccountKey=SUA_CHAVE;EndpointSuffix=core.windows.net"
  }
}
```

---

## 5. Testar Localmente

### 5.1 Pré-requisitos

- Node.js 18+
- Azure Functions Core Tools: `npm install -g azure-functions-core-tools@4`
- Azurite (emulador de storage): `npm install -g azurite`

### 5.2 Iniciar Azurite

```bash
npx azurite
```

### 5.3 Iniciar Function

```bash
npm start
```

### 5.4 Testar Webhook

```bash
curl -X POST http://localhost:7071/api/gitlab-planner-sync ^
  -H "Content-Type: application/json" ^
  -H "X-Gitlab-Token: seu-secret" ^
  -d "{
    \"object_kind\": \"issue\",
    \"object_attributes\": {
      \"iid\": 999,
      \"title\": \"Teste de Issue\",
      \"description\": \"Descrição da issue de teste\",
      \"labels\": [\"in progress\"],
      \"due_date\": \"2024-12-31\",
      \"state\": \"opened\",
      \"web_url\": \"https://gitlabbuilder.mec.gov.br/test\"
    }
  }"
```

### 5.5 Testar Sincronização Manual

```bash
curl "http://localhost:7071/api/gitlab-planner-sync?iid=42"
```

---

## 6. Deploy para Azure

### 6.1 Via Azure CLI

```bash
az functionapp deployment source config-zip ^
  --resource-group SEU-RESOURCE-GROUP ^
  --name SUA-FUNCTION-APP ^
  --src deploy-functions.zip
```

### 6.2 Via Visual Studio Code

1. Instale extensão **Azure Functions**
2. Clique com botão direito no projeto → **Deploy to Function App**

### 6.3 Após Deploy

1. Configure as **Application Settings** no Portal Azure com os valores corretos
2. Teste o webhook: `https://SUA-FUNCTION-APP.azurewebsites.net/api/gitlab-planner-sync`

---

## 7. Verificar Funcionamento

### 7.1 Logs da Function

No Portal Azure → Function App → Functions → syncGitLabPlanner → Monitor

### 7.2 Azure Table

Verifique se os mapeamentos estão sendo salvos:
1. Storage Explorer → Tables → GitLabPlannerMapping
2. Deve haver entidades com `gitlabIid` e `plannerTaskId`

---

## 8. Estrutura dos Dados

### 8.1 Azure Table: GitLabPlannerMapping

| Campo | Tipo | Descrição |
|-------|------|-----------|
| PartitionKey | string | `"gitlab-planner"` |
| RowKey | string | `gitlabIid` da issue |
| gitlabIid | int | ID da issue no GitLab |
| plannerTaskId | string | ID da task no Planner |
| plannerBucketId | string | ID do bucket atual |
| title | string | Título da issue |
| lastSyncedAt | datetime | Última sincronização |
| issueLabels | string | Labels separadas por vírgula |
| gitlabUrl | string | URL da issue |

### 8.2 Task Planner

- **Título**: `[#IID] Título da Issue`
- **Bucket**: Baseado na label de status
- **Descrição**: Link para GitLab + detalhes
- **Due Date**: Data de vencimento da issue
- **% Concluído**: 0% (aberta) ou 100% (fechada)

---

## 9. Troubleshooting

### Erro: "GITLAB_TOKEN não configurado"
- Verifique se `GITLAB_TOKEN` está em Application Settings

### Erro: "TABLE_STORAGE_CONN_STRING não configurado"
- Verifique se a connection string está correta
- Para local: use `UseDevelopmentStorage=true`

### Erro: "Token inválido ou ausente"
- O header `X-Gitlab-Token` não confere com `GITLAB_WEBHOOK_SECRET`
- Verifique se o secret está igual no GitLab webhook e nas settings

### Erro: "Task não encontrada"
- A task pode ter sido deletada no Planner
- Remova o mapping manualmente da Table Storage

### Planner Bucket não encontrado
- Verifique se o Plan ID está correto
- buckets são criados automaticamente na primeira sync

---

## 10. Personalização

### 10.1 Alterar Mapeamento de Labels

Edite `src/functions/gitlab-planner-sync/gitlabService.js` → função `mapLabelToBucket()`:

```javascript
const mapping = {
  "sua-label": "Nome do Bucket",
  // Adicione suas labels aqui
};
```

### 10.2 Alterar Plan ID Padrão

Edite `src/functions/syncGitLabPlanner.js`:

```javascript
const PLANNER_PLAN_ID = process.env.PLANNER_PLAN_ID || "SEU-PLAN-ID";
```
