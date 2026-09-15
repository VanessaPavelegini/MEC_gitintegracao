# Como Aplicar JSON Formatting no Portal SharePoint

## Passo 1: Formatar coluna Status

1. Abra a lista `mec_integracao_gitlab_dashboard`
2. Localize o cabeçalho da coluna **Status**
3. Clique na seta para baixo (▼) ao lado de **Status**
4. **Configurações da coluna** → **Formatar esta coluna**
5. No painel à direita, mude de "Layout" para **Avançado**
6. **Apague** todo o conteúdo do campo JSON
7. **Cole** o JSON abaixo:

```json
{
  "$schema": "https://developer.microsoft.com/json-schemas/sp/v2/column-formatting.schema.json",
  "elmType": "div",
  "children": [
    {
      "elmType": "span",
      "style": {
        "padding": "4px 10px",
        "border-radius": "12px",
        "font-weight": "600",
        "font-size": "12px",
        "color": "white",
        "display": "inline-block",
        "background-color": "=if([$Status] == 'Sincronizado', '#107C10', if([$Status] == 'Pendente', '#FFB900', '#D83B01'))"
      },
      "txtContent": "[$Status]"
    }
  ]
}
```

8. Clique em **Visualizar** para ver como fica
9. Clique em **Salvar**

---

## Passo 2: Formatar coluna Título

1. Localize o cabeçalho da coluna **Título**
2. Clique na seta para baixo (▼) → **Configurações da coluna** → **Formatar esta coluna**
3. **Avançado**
4. Apague tudo
5. Cole:

```json
{
  "$schema": "https://developer.microsoft.com/json-schemas/sp/v2/column-formatting.schema.json",
  "elmType": "a",
  "txtContent": "[$Title]",
  "attributes": {
    "href": "[$IssueURL]",
    "target": "_blank",
    "class": "sp-field-name"
  },
  "style": {
    "color": "#0078d4",
    "font-weight": "600",
    "text-decoration": "none"
  }
}
```

6. **Salvar**

---

## Passo 3: Formatar coluna PlannerTaskID

1. Cabeçalho **PlannerTaskID** → seta ▼ → **Configurações da coluna** → **Formatar esta coluna**
2. **Avançado**
3. Cole:

```json
{
  "$schema": "https://developer.microsoft.com/json-schemas/sp/v2/column-formatting.schema.json",
  "elmType": "a",
  "txtContent": "[$PlannerTaskID]",
  "attributes": {
    "href": "='https://tasks.office.com/mecbrasil.onmicrosoft.com/Home/Task/' + [$PlannerTaskID]",
    "target": "_blank"
  },
  "style": {
    "color": "#0078d4",
    "font-family": "monospace",
    "font-size": "12px"
  }
}
```

4. **Salvar**

---

## Passo 4: Formatar coluna GitLabIID

1. Cabeçalho **GitLabIID** → seta ▼ → **Configurações da coluna** → **Formatar esta coluna**
2. **Avançado**
3. Cole:

```json
{
  "$schema": "https://developer.microsoft.com/json-schemas/sp/v2/column-formatting.schema.json",
  "elmType": "span",
  "style": {
    "font-weight": "600",
    "color": "#0078d4"
  },
  "txtContent": "[$GitLabIID]"
}
```

4. **Salvar**

---

## Passo 5: Formatar a View (tabela inteira)

1. Vá em **Configurações** (⚙️ canto superior direito) → **Formatar exibição atual**
2. Mude para **Modo Avançado** (terceiro botão, lado direito)
3. Apague tudo do campo JSON
4. Cole:

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
      "padding": "12px 16px",
      "border-bottom": "1px solid #edebe9",
      "transition": "background-color 0.2s"
    },
    "children": [
      {
        "elmType": "div",
        "style": {
          "flex": "1",
          "display": "flex",
          "flex-direction": "column",
          "min-width": "0"
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
              "font-size": "13px",
              "overflow": "hidden",
              "text-overflow": "ellipsis",
              "white-space": "nowrap"
            }
          },
          {
            "elmType": "div",
            "style": {
              "margin-top": "8px",
              "font-size": "12px",
              "color": "#8a8886",
              "display": "flex",
              "gap": "12px",
              "flex-wrap": "wrap"
            },
            "children": [
              {
                "elmType": "span",
                "children": [
                  {
                    "elmType": "span",
                    "txtContent": "Issue #"
                  },
                  {
                    "elmType": "span",
                    "txtContent": "[$GitLabIID]",
                    "style": {
                      "font-weight": "600"
                    }
                  }
                ]
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
          "align-items": "flex-end",
          "margin-left": "16px",
          "flex-shrink": "0"
        },
        "children": [
          {
            "elmType": "span",
            "txtContent": "[$Status]",
            "style": {
              "padding": "6px 14px",
              "border-radius": "12px",
              "font-weight": "600",
              "font-size": "13px",
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
              "margin-top": "6px"
            }
          }
        ]
      }
    ]
  }
}
```

5. Clique em **Visualizar** para ver como fica
6. **Salvar**

---

## Resultado Final

Sua lista vai ter:
- ✅ Status com badges coloridos (verde/amarelo/vermelho)
- ✅ Título clicável (link para GitLab)
- ✅ PlannerTaskID como link clicável
- ✅ Visual moderno em cards
- ✅ Última sincronização visível

---

## Próximo Passo

Depois de aplicar os JSONs, criar o Power Automate seguindo `POWER_AUTOMATE_GUIDE.md`.
