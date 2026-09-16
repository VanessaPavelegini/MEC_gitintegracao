# Deploy da Function `func-gitintegracao`

Guia operacional para publicar esta Azure Function em produção. Fontes de verdade relacionadas:

- [`local.settings.json`](local.settings.json) — variáveis de ambiente em desenvolvimento (não versionado, ver `.gitignore`).
- [`AZURE_SETTINGS.md`](AZURE_SETTINGS.md) — referência completa das Application Settings consumidas pelo código.
- [`GITLAB_PLANNER_SYNC.md`](GITLAB_PLANNER_SYNC.md) — configuração do webhook GitLab e do plano Planner.
- [`README.md`](README.md) — visão geral do projeto.

---

## 1. Pré-requisitos

| Ferramenta | Versão verificada | Instalação |
|------------|-------------------|------------|
| Node.js | 18+ | https://nodejs.org |
| Azure Functions Core Tools | 4.x (`func --version`) | `npm install -g azure-functions-core-tools@4` |
| Azure CLI | latest (`az --version`) | `brew install azure-cli` (macOS) |
| Git | any | — |

Confirme o ambiente:

```bash
func --version
az --version
az account show        # precisa estar logado
git status             # working tree limpo antes de publicar
```

---

## 2. Métodos de publicação

### 2.1 Azure Functions Core Tools (CLI) — recomendado

Equivalente direto ao botão "Deploy to Function App" da extensão do VS Code, sem precisar abrir a IDE.

```bash
func azure functionapp publish func-gitintegracao
```

O comando:

1. Empacota o projeto (excluindo `local.settings.json` por padrão).
2. Faz upload do zip para o slot de produção.
3. Sincroniza os triggers HTTP automaticamente.

Verifique o resultado:

```bash
func azure functionapp list-functions func-gitintegracao
```

Saída esperada:

```
Functions in func-gitintegracao:
    syncGitLabPlanner - [httpTrigger]
        Invoke url: https://func-gitintegracao-febwfvfnbwchbbhb.brazil south-01.azurewebsites.net/api/gitlab-planner-sync
```

> O `func-tools` reusa a sessão do `az login`. Se a sessão expirar, o comando falha com `Azure authentication failed` — basta rodar `az login` novamente.

### 2.2 Extensão Azure Functions do VS Code (manual)

1. Abra o VS Code nesta pasta.
2. Instale a extensão **Azure Functions** (Microsoft).
3. Faça login: barra lateral → **Azure** → **Sign in to Azure**.
4. Localize **Function App** → `func-gitintegracao`.
5. Botão direito → **Deploy to Function App**.
6. Confirme a sobrescrita e aguarde 2–3 min.

Use este método quando não houver `az` configurado no terminal.

### 2.3 Pipeline CI/CD

Para deploy automatizado em `main`, use a Action oficial:

```yaml
- uses: Azure/functions-action@v1
  with:
    app-name: func-gitintegracao
    package: .
    publish-profile: ${{ secrets.AZURE_FUNCTIONAPP_PUBLISH_PROFILE }}
```

Gere o publish profile no Portal Azure → Function App → **Get publish profile** e salve como secret no GitHub.

---

## 3. Application Settings (Portal Azure)

A function **não inicia** sem as variáveis obrigatórias. Configure **antes** do primeiro deploy se for um ambiente novo.

### 3.1 Caminho no Portal

1. https://portal.azure.com
2. Abra **func-gitintegracao**.
3. Menu lateral → **Configuration** → aba **Application settings**.
4. **+ New application setting** para cada par nome/valor.
5. **Save** → **Continue**.

### 3.2 Variáveis obrigatórias

Lista completa e referência cruzada em [`AZURE_SETTINGS.md`](AZURE_SETTINGS.md). Resumo das obrigatórias:

| Variável | Origem |
|----------|--------|
| `AzureWebJobsStorage` | Connection string do storage account (gerada pelo Portal) |
| `FUNCTIONS_WORKER_RUNTIME` | `node` |
| `AZURE_TENANT_ID` / `AZURE_CLIENT_ID` / `AZURE_CLIENT_SECRET` | App registration Azure AD |
| `DATAVERSE_URL` | URL do ambiente Dataverse (ex: `https://org41ecace2.crm2.dynamics.com`) |
| `PLANNER_PLAN_ID` | ID do plano Planner alvo |
| `GITLAB_URL` / `GITLAB_TOKEN` / `GITLAB_PROJECT_ID` / `GITLAB_BOARD_ID` | Projeto GitLab que dispara o webhook |
| `GITLAB_WEBHOOK_SECRET` | Mesmo valor configurado no webhook GitLab (header `X-Gitlab-Token`) |

### 3.3 Permissões do App Registration

- **Microsoft Graph**: `Application.ReadWrite.All` (ou `Sites.ReadWrite.All`)
- **Dynamics CRM**: `user_impersonation`
- **Microsoft Planner**: `Tasks.ReadWrite.All`

Com consentimento do admin: Portal Azure → **Microsoft Entra ID** → **App registrations** → app → **API permissions** → **Grant admin consent**.

### 3.4 Segurança

> ⚠️ **Antes** de subir valores reais para o Portal, regenere `AZURE_CLIENT_SECRET`, `GITLAB_TOKEN` e `FUNCTION_KEY`. Os valores em `local.settings.json` são apenas para desenvolvimento local.

---

## 4. Validar o deploy

### 4.1 Endpoints disponíveis

- `POST /api/gitlab-planner-sync` — webhook GitLab (autenticado por header `X-Gitlab-Token`)
- `GET  /api/gitlab-planner-sync?iid=<N>` — sincroniza 1 issue específica (requer `FUNCTION_KEY` se auth habilitada)
- `GET  /api/gitlab-planner-sync?bulk=true` — sincroniza todas as issues abertas

URL pública (slot de produção):

```
https://func-gitintegracao-febwfvfnbwchbbhb.brazilsouth-01.azurewebsites.net/api/gitlab-planner-sync
```

### 4.2 Smoke test

Sincronização manual de uma issue conhecida:

```bash
curl "https://func-gitintegracao-febwfvfnbwchbbhb.brazilsouth-01.azurewebsites.net/api/gitlab-planner-sync?iid=42"
```

Resposta esperada: 200 com JSON listando a task criada/atualizada no Planner.

### 4.3 Webhook de teste

```bash
curl -X POST \
  -H "Content-Type: application/json" \
  -H "X-Gitlab-Token: $GITLAB_WEBHOOK_SECRET" \
  -d '{
    "object_kind": "issue",
    "object_attributes": {
      "iid": 999,
      "title": "Deploy smoke test",
      "description": "Issue criada para validar o deploy",
      "labels": ["in progress"],
      "state": "opened",
      "web_url": "https://gitlabbuilder.mec.gov.br/test"
    }
  }' \
  "https://func-gitintegracao-febwfvfnbwchbbhb.brazilsouth-01.azurewebsites.net/api/gitlab-planner-sync"
```

### 4.4 Verificar resultado

- **Portal Azure** → Function App → **syncGitLabPlanner** → **Monitor**: invocações, exceções, latência.
- **Power Apps** → ambiente do `DATAVERSE_URL` → tabela **Mapeamento Planner** (`pmo_mapeamentoplanner`): registros `Sincronizado` com `pmo_plannertaskid` preenchido.
- **Planner** (https://planner.cloud.microsoft): nova task no bucket correspondente à label.

---

## 5. Rollback

A Function App mantém histórico de deployments:

```bash
az functionapp deployment list \
  --name func-gitintegracao \
  --resource-group <seu-rg> \
  --query "[?properties.status=='Active'].{timestamp:properties.timestamp, id:id}" -o table
```

Para reverter para o deployment anterior, re publique o commit anterior:

```bash
git checkout <commit-anterior>
func azure functionapp publish func-gitintegracao
git checkout -
```

Ou no Portal: **Deployment Center** → histórico → **Redeploy**.

---

## 6. Troubleshooting

| Sintoma | Causa provável | Ação |
|---------|----------------|------|
| `Azure authentication failed` no `func publish` | Sessão `az login` expirou | `az login` e tente novamente |
| `Error: Function app not found` | Nome ou resource group errado | Confirme em `az functionapp list --output table` |
| Function sobe mas dá 500 | Variável obrigatória faltando | Veja logs em **Monitor** → entrada mais recente → stack trace |
| `X-Gitlab-Token` inválido | Secret do GitLab ≠ `GITLAB_WEBHOOK_SECRET` | Regenere em **Configuration** e atualize o webhook no GitLab |
| Bucket não muda | Label da issue não está no mapa `mapLabelToBucket` | Veja `GITLAB_PLANNER_SYNC.md` §10.1 |

Para erros de credenciais Azure AD, restart a Function App depois de ajustar as Application Settings.
