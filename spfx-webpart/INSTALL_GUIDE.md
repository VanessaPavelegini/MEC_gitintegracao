# Guia de Instalacao - GitLab Planner Monitor

## ✅ Arquivo ja hospedado em:

```
https://mecbrasil.sharepoint.com/sites/AutomacoesdeProcessos/Documentos%20Compartilhados/GitLabMonitor/gitlab-planner-monitor.html
```

Permissoes: visitantes (read), membros (write), proprietarios (owner)

---

## Como adicionar na pagina SharePoint

### Passo 1: Abrir pagina
1. Acesse https://mecbrasil.sharepoint.com/sites/AutomacoesdeProcessos
2. Abra ou crie uma pagina (Pagina do Site > + Nova > Pagina Moderna)

### Passo 2: Adicionar Embed Web Part
1. Clique em **+** (adicionar nova web part)
2. Pesquise: **Incorporar** ou **Embed**
3. Selecione **Incorporar**

### Passo 3: Configurar URL
1. Na web part, clique em **Editar** (icone de lapis)
2. Cole a URL:
```
https://mecbrasil.sharepoint.com/sites/AutomacoesdeProcessos/Documentos%20Compartilhados/GitLabMonitor/gitlab-planner-monitor.html
```
3. Clique em **Aplicar**

### Passo 4: Salvar pagina
1. **Salvar e fechar** (canto superior direito)
2. **Publicar** se necessario

---

## Configuracoes uteis

### Alterar para dados reais do Dataverse

Edite o arquivo HTML (biblioteca de documentos):
1. Abra a biblioteca `Documentos Compartilhados/GitLabMonitor`
2. Clique nos 3 pontos do arquivo HTML > **Editar**
3. Encontre o bloco `CONFIG` no JavaScript
4. Mude:
```javascript
useMockData: false  // era true
```
5. Salve

### Alterar intervalo de atualizacao

No mesmo arquivo, mude:
```javascript
refreshIntervalSec: 30  // padrao 30s (minimo 10s)
```

### Alterar titulo

```javascript
title: 'Meu Dashboard Customizado'
```

---

## Troubleshooting

### "Pagina nao carrega"
- Verifique se voce esta logado no SharePoint
- Teste a URL diretamente em nova aba

### "Dados nao aparecem (tela branca)"
- Abra DevTools (F12) > Console
- Verifique erros
- Se configurado `useMockData: false`, pode ser problema de CORS com Dataverse

### "Auto-refresh nao funciona"
- Verifique se a pagina nao esta em modo de edicao
- Navegadores podem pausar timers em abas em background

---

## Para deploy em producao (CDN)

Para evitar dependencia de autenticacao SharePoint, hospede em CDN publico:

1. **Azure Blob Storage** (recomendado):
   - Criar container publico
   - Upload do HTML
   - Usar URL do blob

2. **GitHub Pages**:
   - Branch `gh-pages`
   - Usar raw.githubusercontent.com ou jekyll

3. **Cloudflare Pages / Netlify / Vercel**:
   - Drag & drop do arquivo

---

## Atualizacoes futuras

Quando o codigo React/TSX mudar:
1. Recompilar: `cd spfx-webpart && gulp build`
2. Fazer upload do novo `dist/gitlab-planner-monitor.html`
3. Substituir arquivo existente na biblioteca SharePoint
