# Application Settings para Azure Function App

Copie e cole cada valor em **Portal Azure → func-gitintegracao → Configuration → Application Settings → New application setting**.

## Configurações obrigatórias:

| Nome | Valor | Descrição |
|------|-------|-----------|
| `AzureWebJobsStorage` | *(já existe - verificar)* | Connection string do storage account da function |
| `FUNCTIONS_WORKER_RUNTIME` | `node` | Runtime da function |
| `AZURE_TENANT_ID` | `b8c25932-5e76-4b2b-9c53-d41745e9c92d` | Tenant do Azure AD |
| `AZURE_CLIENT_ID` | `18fb3c07-66df-40a0-86d6-5d2d84dea60f` | Client ID do app registration |
| `AZURE_CLIENT_SECRET` | `<cole-seu-novo-secret-aqui>` | Secret do app (REVOGUE O ANTIGO!) |
| `PLANNER_PLAN_ID` | `V6eQb5zdBkWHqIzlDh68o2UACro8` | ID do plano Planner |
| `GITLAB_URL` | `https://gitlabbuilder.mec.gov.br` | URL do GitLab |
| `GITLAB_TOKEN` | `<cole-seu-novo-token-gitlab>` | PAT do GitLab (REVOGUE O ANTIGO!) |
| `GITLAB_PROJECT_ID` | `doc-sis/documentacao-novosistec2` | Projeto GitLab |
| `GITLAB_BOARD_ID` | `92` | ID do board |
| `GITLAB_WEBHOOK_SECRET` | `5a4c83dd2fbafbf9cbcff75465e073577bbc7138d5afe699119ba2f65104780e` | Secret do webhook |
| `TABLE_STORAGE_CONN_STRING` | `<cole-connection-string-do-storage>` | Azure Table Storage |

## Passos no Portal Azure:

1. Acesse https://portal.azure.com
2. Abra **func-gitintegracao**
3. Menu lateral → **Configuration**
4. Aba **Application settings**
5. Clique em **+ New application setting**
6. Adicione cada par nome/valor da tabela acima
7. Clique em **Save** → **Continue**

## Como gerar o TABLE_STORAGE_CONN_STRING:

Se você ainda não criou um Storage Account:

```bash
az storage account create \
  --name stgitintegracao \
  --resource-group rg-pnid-app-hmg-mec \
  --location brazilsouth \
  --sku Standard_LRS
```

Depois pegue a connection string:

```bash
az storage account show-connection-string \
  --name stgitintegracao \
  --resource-group rg-pnid-app-hmg-mec
```

## Criar a Tabela:

```bash
az storage table create \
  --name GitLabPlannerMapping \
  --connection-string "<sua-connection-string>"
```

---

**⚠️ Segurança:** Revogue e gere novos secrets para `AZURE_CLIENT_SECRET` e `GITLAB_TOKEN` antes de usar.
