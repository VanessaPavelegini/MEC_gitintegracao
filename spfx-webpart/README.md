# GitLab Planner Monitor - SPFx Web Part

Web Part para monitorar sincronizacao entre GitLab Issues e Microsoft Planner.

## Visual

```
+-------------------------------------------+
|  GitLab Planner Monitor      14:30  [↻]  |
+-------------------------------------------+
| [Total] [Sync] [Pendente] [Erros]         |
|  42      38      3         1              |
+-------------------------------------------+
| 🔍 Buscar... [Todos ▼]                   |
+-------------------------------------------+
| ✅ #42 - Implementar OAuth        [Sync] |
| ⏳ #43 - Atualizar docs          [Pend.] |
| ❌ #44 - Erro deploy             [Erro]  |
+-------------------------------------------+
```

## Recursos

- Cards de metricas coloridos
- Auto-refresh configuravel (10s a 300s)
- Filtros por status e busca textual
- Cards clicaveis (link para GitLab/Planner)
- Modo mock para testes
- Responsivo (mobile-friendly)

## Estrutura

```
spfx-webpart/
├── package.json           # Dependencias SPFx 1.18
├── tsconfig.json
├── gulpfile.js
├── config/
│   └── package-solution.json
└── src/
    └── webparts/
        └── gitlabPlannerMonitor/
            ├── GitlabPlannerMonitorWebPart.ts
            ├── components/
            │   ├── GitlabPlannerMonitor.tsx
            │   ├── GitlabPlannerMonitor.module.scss
            │   └── IGitlabPlannerMonitorProps.ts
            ├── services/
            │   └── DataverseService.ts
            └── loc/
                ├── en-us.js
                └── mystrings.d.ts
```

## Como Buildar

### Pre-requisitos

- Node.js 18+
- npm ou yarn
- Gulp CLI: `npm install -g gulp-cli`

### Instalacao

```bash
cd spfx-webpart
npm install
```

### Build de desenvolvimento

```bash
npm run build
npm run serve    # Abre workbench local em https://localhost:4321
```

### Build de producao

```bash
npm run bundle        # Bundle otimizado
npm run package       # Gera .sppkg
```

Arquivo gerado em: `sharepoint/solution/gitlab-planner-monitor.sppkg`

## Deploy no SharePoint

### Passo 1: App Catalog

1. Acesse o **App Catalog** do SharePoint (Admin Center)
2. **Apps for SharePoint** → **Upload**
3. Selecione o arquivo `.sppkg`
4. Confirme deploy

### Passo 2: Adicionar na pagina

1. Abra uma pagina moderna do SharePoint
2. **+** → **Web Part**
3. Pesquise: **GitLab Planner Monitor**
4. Adicione

### Passo 3: Configurar

1. Clique em **Edit** (icone de lapis)
2. Selecione a web part
3. **Edit properties** (icone de engrenagem)
4. Configure:
   - **Titulo:** GitLab Planner Monitor
   - **Intervalo:** 30 segundos
   - **Usar dados de exemplo:** Sim (para teste inicial)
   - **URL Dataverse:** `https://org41ecace2.crm2.dynamics.com`

## Conexao com Dataverse Real

Para usar dados reais, desligue "Usar dados de exemplo" e configure a URL do Dataverse.

Permissoes necessarias no App Registration:
- `Dynamics CRM user_impersonation` (ja configurado)

## Modo Mock

Para testes/desenvolvimento, ative "Usar dados de exemplo" para ver a interface com dados ficticios.

## Solucao de Problemas

**Erro: "Cannot find module '@microsoft/sp-*'"**
- Rode `npm install`

**Erro ao buildar: TypeScript errors**
- Verifique `tsconfig.json`

**Web Part nao aparece no SharePoint**
- Verifique se fez upload no App Catalog
- Verifique se esta no site correto

## Personalizacao

### Cores
Edite em `GitlabPlannerMonitor.module.scss`:
- `.metricSynced` - verde sincronizado
- `.metricPending` - amarelo pendente
- `.metricError` - vermelho erro

### Intervalo de refresh
Configuravel via Property Pane (10-300 segundos)

### Tabela no Dataverse
Edite em `DataverseService.ts` o nome da tabela em:
```
${this.dataverseUrl}/api/data/v9.2/pmo_mapeamentoplanners
```
