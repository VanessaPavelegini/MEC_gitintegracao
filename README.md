# MEC GitLab Integration

Azure Function que sincroniza issues do GitLab com tarefas no Microsoft Planner.

## Arquitetura

```
GitLab (webhook) 
    ↓
Azure Function (HTTP trigger)
    ↓
Dataverse (mapeamento GitLabIID <-> PlannerTaskID)
    ↓
Microsoft Planner (cria/atualiza tasks)
```

## Componentes

### 1. Function App Azure
- **Endpoint:** `https://func-gitintegracao-febwfvfnbwchbbhb.brazilsouth-01.azurewebsites.net`

### 2. Tabela Dataverse
- **Nome:** `pmo_mapeamentoplanner` (EntitySet: `pmo_mapeamentoplanners`)
- **URL:** `https://org41ecace2.crm2.dynamics.com`

### 3. Projeto GitLab
- **URL:** `https://gitlabbuilder.mec.gov.br/doc-sis/documentacao-novosistec2`
- **Board ID:** `92`

### 4. Plano Planner
- **Plan ID:** `V6eQb5zdBkWHqIzlDh68o2UACro8`

## Endpoints da Function

| Método | Rota | Descrição |
|--------|------|-----------|
| `POST` | `/api/gitlab-planner-sync` | Webhook do GitLab |
| `GET` | `/api/gitlab-planner-sync?iid=X` | Sincronizar uma issue |
| `GET` | `/api/gitlab-planner-sync?bulk=true` | Sincronizar todas abertas |

## Application Settings (configurar no Portal Azure)

| Nome | Valor |
|------|-------|
| `AZURE_TENANT_ID` | `b8c25932-5e76-4b2b-9c53-d41745e9c92d` |
| `AZURE_CLIENT_ID` | `18fb3c07-66df-40a0-86d6-5d2d84dea60f` |
| `AZURE_CLIENT_SECRET` | `<seu-secret-aqui>` |
| `DATAVERSE_URL` | `https://org41ecace2.crm2.dynamics.com` |
| `PLANNER_PLAN_ID` | `V6eQb5zdBkWHqIzlDh68o2UACro8` |
| `GITLAB_URL` | `https://gitlabbuilder.mec.gov.br` |
| `GITLAB_TOKEN` | `<seu-token-aqui>` |
| `GITLAB_PROJECT_ID` | `doc-sis/documentacao-novosistec2` |
| `GITLAB_BOARD_ID` | `92` |
| `GITLAB_WEBHOOK_SECRET` | `5a4c83dd2fbafbf9cbcff75465e073577bbc7138d5afe699119ba2f65104780e` |

## Mapeamento de Labels → Buckets

| Label do GitLab | Bucket do Planner |
|------------------|-------------------|
| `To Do`, `A Fazer`, `Backlog` | `To Do` |
| `In Progress`, `Em Progresso`, `Em Andamento` | `In Progress` |
| `In Review`, `Em Revisão` | `In Review` |
| `Done`, `Concluído`, `Completed` | `Done` |
| `Blocked`, `Bloqueado` | `Blocked` |

## Estrutura de Arquivos

```
.
├── index.js                      # Entry point
├── host.json                     # Config Azure Functions
├── package.json                  # Dependências
├── .gitignore
├── DATAVERSE.md                  # Docs tabela Dataverse
├── AZURE_SETTINGS.md             # Guia de Application Settings
└── src/
    └── functions/
        └── gitlab-planner-sync/
            ├── index.js          # Registro da function
            ├── syncGitLabPlanner.js  # Handler principal
            ├── gitlabService.js  # API GitLab
            └── tableStorage.js   # API Dataverse
```

## Como fazer deploy

1. Abra o VS Code na pasta deste repositório
2. Instale a extensão "Azure Functions" (se não tiver)
3. Login no Azure pela extensão
4. Botão direito em `func-gitintegracao` → **Deploy to Function App**

## Como configurar Settings no Azure

1. Portal Azure → `func-gitintegracao` → **Configuration**
2. Aba **Application settings**
3. Adicione cada par `nome/valor` da tabela acima
4. Clique em **Save** → **Continue**

## Como testar

```bash
# Sincronizar uma issue específica
curl "https://func-gitintegracao-febwfvfnbwchbbhb.brazilsouth-01.azurewebsites.net/api/gitlab-planner-sync?iid=123"

# Sincronizar todas as issues abertas
curl "https://func-gitintegracao-febwfvfnbwchbbhb.brazilsouth-01.azurewebsites.net/api/gitlab-planner-sync?bulk=true"
```

## Como configurar Webhook no GitLab

No projeto GitLab → Settings → Webhooks:
- **URL:** `https://func-gitintegracao-febwfvfnbwchbbhb.brazilsouth-01.azurewebsites.net/api/gitlab-planner-sync`
- **Secret Token:** `5a4c83dd2fbafbf9cbcff75465e073577bbc7138d5afe699119ba2f65104780e`
- **Trigger:** Issues events (check "Create", "Update", "Close")
