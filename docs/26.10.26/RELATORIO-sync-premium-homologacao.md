# RELATÓRIO — Sync GitLab → Planner Premium (plano de homologação)

Escopo: o que foi feito, como foi feito, com qual conta, e como colocar isso
no Power Automate. Fatos verificados em 26 e 27/10/2026.

---

## 1. Resumo

O sync de issues do GitLab para o Planner Premium do plano "Homologação _NOVO
SISTEC 2 - Cópia" foi **implementado, testado e executado de verdade**: 588 tasks
criadas no plano, 588 mappings gravados no PRD, reexecução idempotente
(588 unchanged, 0 erro).

O que **não** está pronto é a etapa de publicação: a rota HTTP da Function
ainda **não está no ar** (o app publicado responde 404 nela), porque o deploy
está bloqueado por RBAC. Por isso o Power Automate ainda não tem o que chamar.

---

## 2. O que foi feito

| Peça | Onde | O que faz |
|---|---|---|
| Cliente Premium (operation sets) | [premiumDataverse.js](../../src/functions/gitlab-planner-sync/premiumDataverse.js) | cria/Atualiza tasks em lote (`msdyn_PssCreateV2`, `msdyn_PssUpdateV2`, `msdyn_ExecuteOperationSetV1`), espera a materialização e descarta o set |
| Núcleo do sync (diff, payload, cursor) | [premiumSync.js](../../src/functions/gitlab-planner-sync/premiumSync.js) | monta a task a partir da issue, decide criar/atualizar/ignorar, pagina por cursor e por fase (`opened` → `closed`) |
| Mapping plan-scoped | [premiumMapping.js](../../src/functions/gitlab-planner-sync/premiumMapping.js) | lê/grava `pmo_mapeamentoplanner` (PRD) com `pmo_plannerplanid` + `pmo_gitlab_updatedat` |
| Handler (lógica pura, testável) | [premiumHandler.js](../../src/functions/gitlab-planner-sync/premiumHandler.js) | contrato da rota: entrada (body/query) e saída (`nextCursor`, contadores) |
| Rota HTTP | [syncGitLabPlannerPremiumHomologacao.js](../../src/functions/gitlab-planner-sync/syncGitLabPlannerPremiumHomologacao.js) | `POST|GET /api/gitlab-planner-premium-homologacao` (auth `function`) e `GET /api/gitlab-planner-premium-homologacao-buckets` |
| Identidade (device code → Blob) | [dataverseServiceAccountAuth.js](../../src/shared/dataverseServiceAccountAuth.js) + [autorizarContaServicoPremium.js](../../scripts/autorizarContaServicoPremium.js) | refresh token no Blob → access token delegado para a org Default |
| Runner local (sem deploy) | [sync-premium-homologacao-local.js](../../scripts/sync-premium-homologacao-local.js) | roda o **mesmo** handler da Function, na máquina |
| Limpeza / conferência | [limpar-lixo-homologacao.js](../../scripts/limpar-lixo-homologacao.js), [conferir-sync-premium-homologacao.js](../../scripts/conferir-sync-premium-homologacao.js) | apaga lixo de teste e mappings órfãos; confere tasks × mappings |
| Coluna nova no PRD | [criar-coluna-pmo-gitlab-updatedat.js](../../scripts/criar-coluna-pmo-gitlab-updatedat.js) | cria `pmo_gitlab_updatedat` (DateTime) — a base do diff idempotente |
| Testes | [tests/](../../tests) | **91 testes passando** (`npm test`) |

Fora do escopo (decidido): comentários da issue, assignee/prioridade, e as 711
tasks do cliente (sem mapping) — não são lidas para escrita nem alteradas.

---

## 3. Como foi feito

**Fluxo de uma página (100 issues):**

```
1. GitLab      GET /api/v4/projects/<id>/issues?state=opened&page=N
2. PRD         GET pmo_mapeamentoplanner?$filter=pmo_plannerplanid eq <planId> and pmo_gitlab_iid in (...)
               → para cada issue: há mapping? a issue mudou (updated_at)?
3. Premium     POST msdyn_CreateOperationSetV1  → OperationSetId
               POST msdyn_PssCreateV2 (ou PssUpdateV2) com 100 tasks (cada uma com msdyn_projecttaskid = GUID do cliente)
               POST msdyn_ExecuteOperationSetV1
               espera a materialização (sonda 1 task por vez, prazo 120 s)
               DELETE msdyn_operationsets(OperationSetId)   ← só depois de confirmar
4. PRD         grava o mapping só das tasks CONFIRMADAS (pmo_plannertaskid + pmo_gitlab_updatedat)
5. Resposta    { processed, created, updated, unchanged, skipped, errors[], nextCursor }
```

**Por que o cursor existe:** o Function App é Consumption Y1, que corta a
resposta HTTP em ~230 s; o plano tem 811 issues. Cada chamada processa **uma
página** e devolve o cursor da próxima (9 iterações: 8 de issues abertas + 1 de
issues fechadas).

**Fase `closed`:** a issue fechada no GitLab não cria task nova — ela apenas
completa com 100% a task que já existe. Sem essa fase, a regra nunca dispararia
(o fetch era só `state=opened`).

**Decisões de robustez que mudaram o resultado (7 defeitos achados e corrigidos,
todos com teste):**

| Defeito | Como se manifestava | Correção |
|---|---|---|
| Set apagado antes da materialização | o sync contava 588 criadas, mas só 24 existiam no plano | esperar a task aparecer **e** ter o conteúdo esperado antes de apagar o set; mapping só da task confirmada |
| Janela de espera curta (30 s) | lote de 100 tasks não materializava a tempo | espera em duas fases: sonda barata até o lote aparecer, depois confirma todas (prazo 120 s) |
| `msdyn_progress` é razão 0..1 | API recusava 50/100 (`percent outside of bounds`) | issue fechada → `msdyn_progress: 1` |
| Id do cliente ignorado | task nascia com id do servidor e o sync não sabia o id | mandar `msdyn_projecttaskid` (GUID do cliente) em cada task |
| Delete exigia entidade completa | `PssDeleteV2` recusava sem assunto e vínculo do projeto | mandar `msdyn_subject` + `msdyn_project@odata.bind` |
| Comparação de "mudou" ignorava precisão | GitLab manda milissegundos, Dataverse trunca em segundos → **toda** issue parecia alterada | comparar em segundos |
| Planner Premium reescreve a descrição | HTML normalizado (`<ul>` minúsculo, `&gt;`, `&quot;`, espaço duplo, comentário inicial descartado) | conferir por **impressão digital** do texto (unescape, tira tags, colapsa espaço, compara o começo) |

**O que já está no ambiente (verificado em 27/10/2026):**

- Plano "Homologação _NOVO SISTEC 2 - Cúpia" (`c385351a-e450-4d54-87ed-d54c57794f7b`),
  bucket "Bucket 1" (`f704c207-84be-f111-a04d-7c1e520d9f67`): **588 tasks** com
  assunto `[#iid] título`.
- PRD (`org41ecace2.crm2.dynamics.com`), tabela `pmo_mapeamentoplanner`:
  **588 mappings**, todos com `pmo_plannertaskid` e `pmo_gitlab_updatedat`, 0 órfãos, 0 duplicatas.
- Reexecução: **588 unchanged, 0 created, 0 updated, 0 erros** (1–2 s por página) — o sync é idempotente.

---

## 4. Qual conta foi usada

| Papel | Conta / app | Como autentica | Situação |
|---|---|---|---|
| **Escrita no Planner Premium** (o que importa) | **`antoniojunior@mec.gov.br`** | delegated token: `az account get-access-token` (runner local) ou device code flow → refresh token no Blob (Function publicada) | ✅ é a única que passa: tem licença ModernProject **e** escrita no plano |
| Leitura do plano (teste) | `portaldedemandas@mec.gov.br` | device code flow | ⚠️ **lê, mas não escreve**: `msdyn_ExecuteOperationSetV1` → `Forbidden — Permissions required: Write.` |
| Client credentials (app `app-pnld`, id `18fb3c07`) | — | segredo do app | ❌ `UserNotLicensed` ao escrever no Planner Premium; ✅ usado só para **ler** o mapping no PRD |
| Leitura do GitLab | token de projeto (`GITLAB_TOKEN`) | PAT | ✅ |
| Azure CLI (deploy) | `antoniobjunior@mec.gov.br` (sub `ccmecapppnld13383hom`) | `az login` | ❌ sem `Microsoft.Web/sites/*` no RG `rg-pnld-app-hmg-mec` → `AuthorizationFailed` |

> **Ponto de atenção (verificado hoje):** o refresh token guardado no Blob
> (`service-tokens/premium-dataverse-refresh-token.json`) é **da
> `portaldedemandas@mec.gov.br`** — decodificando o token ACCESSO que ele gera,
> o `upn` é `portaldedemandas@mec.gov.br`. Ou seja: **se a Function for
> publicada agora, ela escreve com a conta errada** e vai falhar com
> `Forbidden — Permissions required: Write.` O token precisa ser refeito com
> `antoniojunior@mec.gov.br` (passo 1 do RUNBOOK). A execução bem-sucedida de
> 26/10 usou o token do `az` (a conta certa).

---

## 5. Como usar a Function no Power Automate

### 5.1 Por que "não deu a opção" ainda

O app publicado hoje responde **404** na rota nova. Verificado:

| Rota | Status no app publicado |
|---|---|
| `GET /api/health` | 200 |
| `GET /api/gitlab-planner-sync` | 400 (falta `iid` — ou seja, existe) |
| `GET /api/premium-health` | 200 |
| `GET /api/gitlab-planner-premium-homologacao` | **404 — não existe** |
| `GET /api/gitlab-planner-premium-homologacao-buckets` | **404 — não existe** |

O Power Automate não "não tem a opção": ele precisa de uma **URL que responda**.
A URL existe só depois do deploy (ou de um túnel para o host local). A chave de
função que está no `local.settings.json` **é válida** no app publicado (o
`/api/health` e o `/api/gitlab-planner-sync` responderam 200/400 com ela, não
401) — o que falta é o código novo no ar.

### 5.2 O flow (o que montar)

Estrutura (detalhe passo a passo em
[PA-FLOW-sync-gitlab-planner-premium-homologacao.md](PA-FLOW-sync-gitlab-planner-premium-homologacao.md)):

```
Trigger: "Executar manualmente" (instantâneo)
   ↓
Inicializar variável  booleana  terminate = false
   ↓
Until  (condição: variables('terminate')  é  igual a  true)
   ├─ HTTP — "Sincronizar página"
   │     Método: POST
   │     URI:    https://func-gitintegracao-febwfvfnbwchbbhb.brazilsouth-01.azurewebsites.net
   │             /api/gitlab-planner-premium-homologacao?code=<FUNCTION_KEY>
   │     Cabeçalhos: Content-Type: application/json
   │     Corpo:
   │       { "planId": "c385351a-e450-4d54-87ed-d54c57794f7b",
   │         "bucketId": "f704c207-84be-f111-a04d-7c1e520d9f67",
   │         "pageSize": 100, "dryRun": false,
   │         "cursor": "@{variables('cursor')}" }
   │     Configurações: Repetir até 3 vezes, intervalo 60 s
   ├─ Definir variável  cursor = coalesce(body('Sincronizar_página')?['nextCursor'], '')
   └─ Definir variável  terminate = equals(body('Sincronizar_página')?['nextCursor'], null)
   ↓
Resumo: total created/updated/unchanged
```

**Pegadinhas que quebram o flow (corrigidas aqui em relação ao blueprint):**

1. **Não use `equals(variables('cursor'), null)` como condição do Until.** O Until
   avalia a condição **antes** da primeira iteração: com o cursor inicializado
   como `""` (ou `null`), o laço termina sem executar nada. Use a variável
   booleana `terminate` (iniciada em `false`) como condição, ou inicialize o
   cursor com um valor não-vazio.
2. **A primeira execução do flow é lenta:** 9 páginas, e a página que cria
   100 tasks leva ~30 s só de materialização. O timeout padrão do action HTTP
   do Power Automate (120 s) dá conta, mas o conjunto leva ~5 min.
3. **`Repetir` precisa estar ligado** (3 tentativas). Se a chamada falhar no
   meio, o `nextCursor` não muda e o flow repetiria a mesma página para sempre.
4. **Uma execução por vez** no mesmo plano: o sync não usa lock. Duas
   execuções simultâneas podem criar task duplicada.

### 5.3 Caminho A — o de verdade (URL pública)

Pré-requisitos (dois, ambos bloqueados hoje):

1. **RBAC:** pedir ao dono do RG `rg-pnld-app-hmg-mec` a atribuição de
   `Contributor` para `antoniobjunior@mec.gov.br` (ou no mínimo
   `Microsoft.Web/sites/*`). Sem isso, `az functionapp` responde
   `AuthorizationFailed` — e hoje o `az` nem consegue **listar** as functions do app.
2. **Device code** refeito com `antoniojunior@mec.gov.br` (seção 4 — o token no
   Blob é da conta errada).

Depois:

```bash
func pack --output ./tmp/functionApp.zip
az functionapp deployment source config-zip \
  --subscription ccmecapppnld13383hom \
  --name func-gitintegracao \
  --resource-group rg-pnld-app-hmg-mec \
  --src tmp/functionApp.zip/MEC_gitintegracao.zip
```

E o flow usa a URL pública exatamente como no blueprint. Alternativa de deploy
sem `az`: extensão "Azure Functions" do VS Code (Deploy to Function App) ou
Deployment Center > Zip deploy no Portal.

### 5.4 Caminho B — o provisório, sem RBAC (túnel para o host local)

O host local (`func start`) já serve a rota nova — verificado hoje em
`http://localhost:7071/api/gitlab-planner-premium-homologacao` (200, dry run,
24 unchanged) e **sem exigir chave** localmente. Para o Power Automate alcançar
a máquina é preciso um túnel (nenhuma ferramenta de túnel está instalada aqui:
`ngrok`, `cloudflared`, `devtunnel` e `localtunnel` ausentes).

Ordem sugerida:

1. Instalar o Azure Dev Tunnels (`devtunnel`) ou `cloudflared`.
2. `func start` (o código precisa estar no ar **localmente**; o host já está
   rodando na porta 7071) e expor: `devtunnel host --port 7071 --allow-anonymous`
   (ou `cloudflared tunnel --url http://localhost:7071`).
3. No flow: trocar a URI pela URL do túnel (+ `?code=<FUNCTION_KEY>`, o header
   `x-functions-key` é aceito localmente mas não é exigido).
4. Reautorizar o token com a conta que tem escrita (§4) — o host local usa o
   mesmo refresh token do Blob.

Limitações do caminho B: a URL do túnel muda a cada sessão, o host precisa da
máquina ligada, e o plano ganha tasks enquanto o túnel estiver aberto.

### 5.5 Teste do endpoint antes de montar o flow

```bash
KEY=$(node -e "console.log(JSON.parse(require('fs').readFileSync('local.settings.json','utf8')).Values.FUNCTION_KEY)")
curl -s -X POST -H "Content-Type: application/json" -H "x-functions-key: $KEY" \
  -d '{"planId":"c385351a-e450-4d54-87ed-d54c57794f7b","dryRun":true,"pageSize":100}' \
  "https://func-gitintegracao-febwfvfnbwchbbhb.brazilsouth-01.azurewebsites.net/api/gitlab-planner-premium-homologacao"
```

Resposta esperada depois do deploy: `{"ok":true,"dryRun":true,"created":0,"updated":0,"unchanged":24,...}`
(hoje, no app publicado, a mesma chamada devolve **404**).

---

## 6. Pendências (ação humana)

| # | Pendência | Quem faz | Trava o quê |
|---|---|---|---|
| 1 | `Contributor` (ou `Microsoft.Web/sites/*`) no RG `rg-pnld-app-hmg-mec` para `antoniobjunior@mec.gov.br` | dono do RG | deploy → caminho A → flow com URL pública |
| 2 | Device code flow com **`antoniojunior@mec.gov.br`** (o token no Blob é da `portaldedemandas`) | quem tem a conta | escrita da Function publicada (e do host local) |
| 3 | Montar o flow (blueprint pronto) | quem tem o Power Automate | execução automática |
| 4 | (opcional) `pmo_gitlab_updatedat` já existe no PRD — nada a fazer | — | — |

**Ordem:** 2 → 1 → 3. (O passo 2 é o mais rápido: é só abrir o navegador e
autorizar um código.)

### Comandos de conferência

```bash
node scripts/conferir-sync-premium-homologacao.js   # tasks no plano × mappings no PRD
node scripts/sync-premium-homologacao-local.js --dry-run
npm test                                          # 91 testes
```

---

## 7. Documentos relacionados

- [PLAN-sync-gitlab-planner-premium-homologacao.md](PLAN-sync-gitlab-planner-premium-homologacao.md) — decisões, contrato da API, o que quebrou e o que foi consertado
- [RUNBOOK-sync-premium-homologacao.md](RUNBOOK-sync-premium-homologacao.md) — passo a passo operacional
- [PA-FLOW-sync-gitlab-planner-premium-homologacao.md](PA-FLOW-sync-gitlab-planner-premium-homologacao.md) — blueprint do flow
