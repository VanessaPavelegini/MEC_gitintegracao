# Power Automate - Dataverse → SharePoint Dashboard

## Arquitetura

```
Dataverse (pmo_mapeamentoplanner)
   ↓ Trigger: Quando uma linha é modificada
Power Automate Flow
   ↓ Buscar/Criar item na lista SharePoint
SharePoint List (mec_integracao_gitlab_dashboard)
   ↓ Visualizado na página
```

## Como criar o Flow

1. Acesse https://make.powerautomate.com
2. Certifique-se que está no ambiente correto (mecbrasil)
3. **+ Criar** → **Fluxo de nuvem automatizado**
4. Nome: `Dataverse → SharePoint Dashboard Sync`
5. Trigger: Pesquise por "Dataverse" → **"Quando uma linha é modificada"**
6. Em **Tipo de linha**, selecione: `mapeamento planners` (pmo_mapeamentoplanner)

## Configuração do Trigger

**Quando uma linha é modificada:**
- **Nome da tabela:** mapeamento planners
- **Escopo:** Organização
- (sem filtro por enquanto, vamos pegar todas as modificações)

## Action 1: Condição

Clique em **+ Nova etapa** → **Condição**

**Expressão:**
```
not(empty(triggerOutputs()?['body/pmo_plannertaskid']))
```

**Configuração:**
- Se sim: Item tem Task Planner ID (foi sincronizado)
- Se não: Item está pendente (sem Task Planner ainda)

## Branch SIM - Sincronizado

### Action 1.1: Inicializar variável (TaskURL)
**Tipo:** Inicializar variável
- **Nome:** `PlannerTaskURL`
- **Tipo:** Cadeia de caracteres
- **Valor:**
```
https://tasks.office.com/mecbrasil.onmicrosoft.com/Home/Task/
```
+ `@{triggerOutputs()?['body/pmo_plannertaskid']}`

### Action 1.2: SharePoint - Obter itens
**Tipo:** SharePoint - Obter itens
- **Site:** `AutomacoesdeProcessos`
- **Lista:** `mec_integracao_gitlab_dashboard`
- **Filtro:**
```
GitLabIID eq @{triggerOutputs()?['body/pmo_gitlab_iid']}
```

### Action 1.3: Condição (existe item?)
**Expressão:**
```
length(body('Obter_itens')?['value'])
greater
0
```

### Branch SIM (já existe item) - SharePoint - Atualizar item
- **Site:** `AutomacoesdeProcessos`
- **Lista:** `mec_integracao_gitlab_dashboard`
- **ID:** `@{first(body('Obter_itens')?['value'])?['ID']}`

**Valores das colunas:**
| Campo SharePoint | Expressão |
|-----------------|-----------|
| Title | `@{triggerOutputs()?['body/pmo_title']}` |
| GitLabIID | `@{triggerOutputs()?['body/pmo_gitlab_iid']}` |
| PlannerTaskID | `@{triggerOutputs()?['body/pmo_plannertaskid']}` |
| Status | "Sincronizado" |
| LastSyncedAt | `@{triggerOutputs()?['body/pmo_dataultimasincronizacao']}` |
| IssueURL | `@{triggerOutputs()?['body/pmo_gitlab_url']}` |
| PlannerURL | `@{variables('PlannerTaskURL')}` |
| Description | `@{triggerOutputs()?['body/pmo_description']}` |
| IssueLabels | `@{triggerOutputs()?['body/pmo_issue_labels']}` |

### Branch NÃO (não existe) - SharePoint - Criar item
- **Site:** `AutomacoesdeProcessos`
- **Lista:** `mec_integracao_gitlab_dashboard`

**Valores:**
| Campo SharePoint | Expressão |
|-----------------|-----------|
| Title | `@{triggerOutputs()?['body/pmo_title']}` |
| GitLabIID | `@{triggerOutputs()?['body/pmo_gitlab_iid']}` |
| PlannerTaskID | `@{triggerOutputs()?['body/pmo_plannertaskid']}` |
| Status | "Sincronizado" |
| LastSyncedAt | `@{triggerOutputs()?['body/pmo_dataultimasincronizacao']}` |
| IssueURL | `@{triggerOutputs()?['body/pmo_gitlab_url']}` |
| PlannerURL | `@{variables('PlannerTaskURL')}` |
| Description | `@{triggerOutputs()?['body/pmo_description']}` |
| IssueLabels | `@{triggerOutputs()?['body/pmo_issue_labels']}` |

## Branch NÃO (Sem TaskPlanner) - só atualiza Status

### Action: SharePoint - Obter itens (mesma config acima)

### Action: Condição (existe item?)

### Branch SIM - SharePoint - Atualizar item
- Atualiza **Status** para "Pendente"
- Atualiza **LastSyncedAt**
- Atualiza **GitLabIID** etc

## Salvar o Flow

1. Clique em **Salvar** (canto superior direito)
2. Volte na lista SharePoint
3. Execute uma sincronização no GitLab
4. Verifique se aparece na lista

## Teste Manual

1. Power Automate → Seu Flow → **Executar** → **Executar fluxo**
2. Selecione um registro do Dataverse
3. Verifique se aparece/atualiza na lista SharePoint
