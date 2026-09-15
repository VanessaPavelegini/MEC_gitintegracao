# Application Settings para Azure Function App

> Fonte da verdade: [`local.settings.json`](local.settings.json). Use este guia para configurar os mesmos pares nome/valor no **Portal Azure → func-gitintegracao → Configuration → Application settings**.

## Variáveis consumidas pelo código

Estas variáveis são lidas pela function. Todas precisam estar configuradas para a function subir.

| Nome | Lida em | Obrigatória | Descrição |
|------|---------|:-----------:|-----------|
| `AzureWebJobsStorage` | host (Azure Functions) | ✅ | Connection string do storage account (cria automaticamente no Portal). |
| `FUNCTIONS_WORKER_RUNTIME` | host | ✅ | `node`. |
| `AZURE_TENANT_ID` | [src/shared/graphClient.js](src/shared/graphClient.js), [src/functions/gitlab-planner-sync/tableStorage.js](src/functions/gitlab-planner-sync/tableStorage.js) | ✅ | Tenant do Azure AD. |
| `AZURE_CLIENT_ID` | idem | ✅ | Client ID do app registration. |
| `AZURE_CLIENT_SECRET` | idem | ✅ | Secret do app (rotacionar periodicamente). |
| `DATAVERSE_URL` | [src/functions/gitlab-planner-sync/tableStorage.js](src/functions/gitlab-planner-sync/tableStorage.js) | ✅ | URL do ambiente Dataverse (ex: `https://org41ecace2.crm2.dynamics.com`). |
| `PLANNER_PLAN_ID` | [src/functions/gitlab-planner-sync/tableStorage.js](src/functions/gitlab-planner-sync/tableStorage.js), [src/functions/gitlab-planner-sync/syncGitLabPlanner.js](src/functions/gitlab-planner-sync/syncGitLabPlanner.js) | ✅ | ID do plano Planner. |
| `GITLAB_URL` | [src/functions/gitlab-planner-sync/gitlabService.js](src/functions/gitlab-planner-sync/gitlabService.js) | ✅ | URL do GitLab. |
| `GITLAB_TOKEN` | idem | ✅ | PAT do GitLab (scopes `api` + `read_api`). |
| `GITLAB_USER_AGENT` | idem | ❌ | User-Agent customizado exigido pelo proxy corporativo (ver `GITLAB_PLANNER_SYNC.md`). |
| `GITLAB_PROJECT_ID` | idem | ✅ | Path do projeto (`namespace/slug`). |
| `GITLAB_BOARD_ID` | idem | ✅ | ID do board para mapeamento de labels → buckets. |
| `GITLAB_WEBHOOK_SECRET` | [src/functions/gitlab-planner-sync/syncGitLabPlanner.js](src/functions/gitlab-planner-sync/syncGitLabPlanner.js) | ✅ | Segredo do webhook (validado no header `X-Gitlab-Token`). |

## Variáveis informativas (não consumidas pela function)

Existem no settings mas **nenhum arquivo em `src/` as lê** hoje. São parâmetros consumidos por sistemas externos (Power Apps Portals, scripts de deploy, workflows SPFx) ou apenas referências operacionais.

| Nome | Uso provável |
|------|--------------|
| `DATAVERSE_URL_DEV` | Ambiente de homologação Dataverse (uso manual). |
| `SP_SITE_ID` / `SP_SITE_URL` | Site SharePoint associado aos fluxos Power Automate. |
| `PORTAL_BASE_URL` | Power Apps Portal que dispara/consome a function. |
| `FUNCTION_KEY` | Function key de acesso (rotacionar se exposta). |
| `URL_FUNCTION` | URL pública da function (montagem de webhooks, links de retorno). |

> Se você está depurando um erro "variável X não configurada", verifique primeiro as variáveis da tabela **consumidas pelo código**. As da segunda tabela podem ser deixadas em branco em ambientes onde não se aplicam.

## Passos no Portal Azure

1. Acesse https://portal.azure.com
2. Abra **func-gitintegracao**
3. Menu lateral → **Configuration** → aba **Application settings**
4. Clique em **+ New application setting**
5. Adicione cada par nome/valor da tabela "consumidas pelo código"
6. Clique em **Save** → **Continue**

## Permissões necessárias no App Registration (Azure AD)

Para a function operar, o app registration precisa destas permissões com consentimento do administrador:

| API | Permissão | Usada em |
|-----|-----------|----------|
| Microsoft Graph | `Application.ReadWrite.All` ou `Sites.ReadWrite.All` | [src/shared/graphClient.js](src/shared/graphClient.js) |
| Dynamics CRM | `user_impersonation` | [src/functions/gitlab-planner-sync/tableStorage.js](src/functions/gitlab-planner-sync/tableStorage.js) |
| Microsoft Planner | Tasks.ReadWrite.All | [src/functions/gitlab-planner-sync/syncGitLabPlanner.js](src/functions/gitlab-planner-sync/syncGitLabPlanner.js) |

---

**⚠️ Segurança:** antes de subir estes valores para o Portal Azure, **revogue e regenere** `AZURE_CLIENT_SECRET`, `GITLAB_TOKEN` e `FUNCTION_KEY`. Os valores atuais em [`local.settings.json`](local.settings.json) são apenas para desenvolvimento local e estão versionados.
