# SharePoint Dashboard - GitLab Planner Sync

Guia para criar dashboard de monitoramento no SharePoint.

## Arquitetura

```
Dataverse (pmo_mapeamentoplanner)
        ↓ Power Automate (sincronização)
SharePoint List (mec_integracao_gitlab_dashboard)
        ↓ JSON Formatting
Dashboard visual moderno
```

---

## Passo 1 - Criar Lista no SharePoint

**Site:** `mecbrasil.sharepoint.com/sites/AutomacoesdeProcessos`

1. Vá em **Conteúdo do site** → **+ Nova** → **Lista**
2. Nome: `mec_integracao_gitlab_dashboard`
3. Descrição: "Monitoramento de sincronização GitLab → Planner"
4. Clique em **Criar**

## Passo 2 - Adicionar Colunas

Vá em **Configurações da lista** (engrenagem) → **Configurações de lista** → em **Colunas** clique em **+ Criar coluna**:

| Nome da coluna | Tipo | Configuração |
|----------------|------|--------------|
| `GitLabIID` | Número | Sem casas decimais, obrigatório |
| `PlannerTaskID` | Linha de texto | - |
| `Status` | Opção | Opções: Sincronizado, Pendente, Erro |
| `LastSyncedAt` | Data e Hora | Apenas data |
| `IssueURL` | URL | - |
| `PlannerURL` | URL | - |
| `Description` | Várias linhas de texto | - |
| `IssueLabels` | Linha de texto | - |

**Não delete** a coluna `Title` padrão - ela será usada como Título da Issue.

## Passo 3 - JSON Formatting (visual moderno)

Vá em **Configurações da lista** → **Formatação de coluna** → **JSON** para as seguintes colunas:

### 3.1 - Coluna `Status`

Cole este JSON:

```json
{
  "$schema": "https://developer.microsoft.com/json-schemas/sp/v2/column-formatting.schema.json",
  "elmType": "div",
  "attributes": {
    "class": "=if(@isCurrent, 'sp-field-severity--good', '')"
  },
  "children": [
    {
      "elmType": "span",
      "style": {
        "padding": "4px 8px",
        "border-radius": "12px",
        "font-weight": "600",
        "display": "inline-block",
        "color": "white",
        "background-color": "=if([$Status] == 'Sincronizado', '#107C10', if([$Status] == 'Pendente', '#FFB900', '#D83B01'))"
      },
      "txtContent": "[$Status]"
    }
  ]
}
```

### 3.2 - Coluna `Title`

```json
{
  "$schema": "https://developer.microsoft.com/json-schemas/sp/v2/column-formatting.schema.json",
  "elmType": "a",
  "txtContent": "[$Title]",
  "attributes": {
    "href": "[$IssueURL]",
    "target": "_blank",
    "class": "sp-field-name"
  }
}
```

### 3.3 - Coluna `PlannerTaskID`

```json
{
  "$schema": "https://developer.microsoft.com/json-schemas/sp/v2/column-formatting.schema.json",
  "elmType": "a",
  "txtContent": "[$PlannerTaskID]",
  "attributes": {
    "href": "='https://tasks.office.com/....' + [$PlannerTaskID]",
    "target": "_blank"
  }
}
```

## Passo 4 - JSON View Formatting (toda a lista)

Vá em **Configurações** → **Formatar exibição atual** → **Modo: Avançado** → cole:

```json
{
  "$schema": "https://developer.microsoft.com/json-schemas/sp/view-formatting.schema.json",
  "hideSelection": true,
  "hideColumnHeader": false,
  "rowFormatter": {
    "elmType": "div",
    "attributes": {
      "class": "sp-row-card sp-row-card--compact"
    },
    "style": {
      "display": "flex",
      "align-items": "center",
      "padding": "12px",
      "border-bottom": "1px solid #edebe9"
    },
    "children": [
      {
        "elmType": "div",
        "style": {
          "flex": "1",
          "display": "flex",
          "flex-direction": "column"
        },
        "children": [
          {
            "elmType": "a",
            "txtContent": "[$Title]",
            "attributes": {
              "href": "[$IssueURL]",
              "target": "_blank"
            },
            "style": {
              "font-weight": "600",
              "font-size": "16px",
              "color": "#0078d4",
              "text-decoration": "none",
              "margin-bottom": "4px"
            }
          },
          {
            "elmType": "div",
            "txtContent": "[$Description]",
            "style": {
              "color": "#605e5c",
              "font-size": "13px"
            }
          },
          {
            "elmType": "div",
            "style": {
              "margin-top": "8px",
              "font-size": "12px",
              "color": "#8a8886"
            },
            "children": [
              {
                "elmType": "span",
                "txtContent": "Issue "
              },
              {
                "elmType": "span",
                "txtContent": "[$GitLabIID]",
                "style": {
                  "font-weight": "600"
                }
              },
              {
                "elmType": "span",
                "txtContent": "  •  "
              },
              {
                "elmType": "span",
                "txtContent": "[$IssueLabels]"
              }
            ]
          }
        ]
      },
      {
        "elmType": "div",
        "style": {
          "display": "flex",
          "flex-direction": "column",
          "align-items": "flex-end"
        },
        "children": [
          {
            "elmType": "span",
            "txtContent": "[$Status]",
            "style": {
              "padding": "4px 12px",
              "border-radius": "12px",
              "font-weight": "600",
              "color": "white",
              "background-color": "=if([$Status] == 'Sincronizado', '#107C10', if([$Status] == 'Pendente', '#FFB900', '#D83B01'))"
            }
          },
          {
            "elmType": "span",
            "txtContent": "[$LastSyncedAt]",
            "style": {
              "font-size": "12px",
              "color": "#8a8886",
              "margin-top": "4px"
            }
          }
        ]
      }
    ]
  }
}
```

## Passo 5 - Power Automate (sincronização Dataverse → SharePoint)

### 5.1 - Criar Flow

1. https://make.powerautomate.com
2. **+ Criar** → **Fluxo de nuvem automatizado**
3. Nome: "Dataverse → SharePoint Dashboard Sync"
4. Escolher gatilho: **"Quando uma linha é modificada"** (Dataverse)
5. Nome da tabela: `pmo_mapeamentoplanners`
6. Filtro: `pmo_dataultimasincronizacao` é maior que

### 5.2 - Adicionar Actions

**Condição:** Se `pmo_plannertaskid` não está vazio
- **SIM:** Atualizar item na SharePoint
  - Site: `AutomacoesdeProcessos`
  - Lista: `mec_integracao_gitlab_dashboard`
  - ID da coluna `Title`: `pmo_title`
  - ID da coluna `GitLabIID`: `pmo_gitlab_iid`
  - ID da coluna `PlannerTaskID`: `pmo_plannertaskid`
  - ID da coluna `Status`: "Sincronizado"
  - ID da coluna `LastSyncedAt`: `pmo_dataultimasincronizacao`
  - ID da coluna `IssueURL`: `pmo_gitlab_url`
  - ID da coluna `Description`: `pmo_description`
  - ID da coluna `IssueLabels`: `pmo_issue_labels`

### 5.3 - Filtros para a view

Na lista SharePoint, criar uma view padrão que mostra:
- Ordenar por: `LastSyncedAt` (decrescente)
- Filtrar: `Status` é igual a "Sincronizado"

## Passo 6 - Adicionar à página

1. Criar página moderna: **+ Nova** → **Página**
2. Adicionar web part: **Lista** → escolher `mec_integracao_gitlab_dashboard`
3. Salvar e publicar

## Resultado Final

Dashboard no SharePoint mostrando:
- ✅ Status color-coded (verde/amarelo/vermelho)
- 🔗 Links diretos para GitLab
- 📊 Informações detalhadas
- 🔄 Sincronização automática via Power Automate
