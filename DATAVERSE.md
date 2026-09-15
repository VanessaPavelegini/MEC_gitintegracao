# Dataverse - Configuração

## Tabela utilizada
**Nome:** `pmo_mapeamentoplanner` (Label: "Mapeamento Planner")
**EntitySet:** `pmo_mapeamentoplanners`
**Environment:** `https://org41ecace2.crm2.dynamics.com`

## Colunas existentes (já na tabela):

| Campo | Tipo | Descrição |
|-------|------|-----------|
| `pmo_mapeamentoplannerid` | Uniqueidentifier | ID único |
| `pmo_plannerplanid` | String | Planner Plan ID |
| `pmo_plannertaskid` | String | Planner Task ID |
| `pmo_plannerbucketid` | String | Planner Bucket ID |
| `pmo_dataultimasincronizacao` | DateTime | Última sincronização |
| `pmo_statussincronizacao` | String | Status da sincronização |
| `pmo_datacriacao` | DateTime | Data de criação |
| `pmo_projeto_id` | Lookup | Projeto relacionado |

## Colunas customizadas criadas (GitLab):

| Campo | Tipo | Obrigatório | Descrição |
|-------|------|-------------|-----------|
| `pmo_gitlab_iid` | Integer | ✅ Sim | IID da issue no GitLab |
| `pmo_gitlab_url` | String (URL) | ❌ Não | URL da issue no GitLab |
| `pmo_title` | String (500) | ❌ Não | Título da issue |
| `pmo_description` | String (2000) | ❌ Não | Descrição da issue |
| `pmo_issue_labels` | String (500) | ❌ Não | Labels separadas por vírgula |

## API URLs:

**Ambiente:** `org41ecace2`

- Listar todos: `GET /api/data/v9.2/pmo_mapeamentoplanners`
- Buscar por IID: `GET /api/data/v9.2/pmo_mapeamentoplanners?$filter=pmo_gitlab_iid eq X`
- Criar: `POST /api/data/v9.2/pmo_mapeamentoplanners`
- Atualizar: `PATCH /api/data/v9.2/pmo_mapeamentoplanners(<id>)`
- Deletar: `DELETE /api/data/v9.2/pmo_mapeamentoplanners(<id>)`
