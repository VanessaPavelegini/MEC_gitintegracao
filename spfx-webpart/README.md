# GitLab Planner Monitor

Dashboard para monitorar sincronizacao entre GitLab Issues e Microsoft Planner.

## Como Usar (Metodo Mais Rapido)

### Opcao 1: Embed Web Part (Recomendado - 5 minutos)

Nao requer build SPFx. Funciona em qualquer SharePoint.

1. Abra uma pagina moderna do SharePoint
2. Clique em **+** → procure **"Incorporar"** ou **"Embed"**
3. Cole a URL do arquivo `dist/gitlab-planner-monitor.html` hospedado
4. Pronto!

#### Como hospedar o HTML:

**Opcao A: SharePoint Document Library** (mais facil)
1. Faca upload de `dist/gitlab-planner-monitor.html` em uma biblioteca de documentos
2. Copie o link publico
3. Cole no Embed Web Part

**Opcao B: Azure Blob Storage**
1. Faca upload para um container publico
2. Use a URL do blob

**Opcao C: GitHub Pages / gist publico**
1. Faca commit do arquivo no GitHub
2. Use raw.githubusercontent.com

### Opcao 2: SPFx Web Part (Build Completo)

Ja temos o codigo TypeScript + React mas o build do webpack tem erro.

Para usar SPFx real:
1. Atualize o codigo React em `src/`
2. Faca deploy tradicional no App Catalog

## Visual

```
+-------------------------------------------+
|  GitLab Planner Monitor       14:30  [↻] |
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

## Configuracao

Edite o objeto `CONFIG` em `dist/gitlab-planner-monitor.html`:

```javascript
const CONFIG = {
  useMockData: true,   // true = dados de exemplo
  dataverseUrl: 'https://org41ecace2.crm2.dynamics.com',
  refreshIntervalSec: 30,
  title: 'GitLab Planner Monitor'
};
```

Para usar dados reais do Dataverse:
1. Mude `useMockData: false`
2. Configure `dataverseUrl` correto
3. O navegador fara a chamada GET para `/api/data/v9.2/pmo_mapeamentoplanners`

**Nota:** chamada direta de Dataverse a partir do navegador so funciona se o usuario tiver acesso SSO ao ambiente.

## Arquivos

- `dist/gitlab-planner-monitor.html` - Dashboard standalone (pronto para usar)
- `src/` - Codigo fonte SPFx React (para build futuro)
- `config/` - Configuracoes SPFx
- `lib/` - Output TypeScript compilado
