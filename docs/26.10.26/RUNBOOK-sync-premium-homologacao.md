# RUNBOOK — Sync GitLab → Planner Premium (Homologação _NOVO SISTEC 2 - Cópia)

Passo a passo para deixar o sync rodando. Cada passo depende do anterior.

Ambiente: repo `MEC_gitintegracao` · Function App `func-gitintegracao` (RG
`rg-pnld-app-hmg-mec`, subscription `ccmecapppnld13383hom`) · org Planner Premium
`https://orgcf194dda.crm.dynamics.com` · org do mapping `https://org41ecace2.crm2.dynamics.com`.

> **Estado em 26/10/2026:** o sync rodou de ponta a ponta **localmente**
> (588 tasks criadas, ver §4-alt) porque o deploy na Function App está bloqueado
> por RBAC (§2). A identidade de escrita que funciona é
> `antoniojunior@mec.gov.br` — **não** `portaldedemandas@mec.gov.br` (§1).

---

## 1. Autorizar a conta de serviço (precisa do navegador)

O app `app-pnld` (client credentials) é bloqueado com `UserNotLicensed` no Planner
Premium. A identidade da escrita é uma **conta de usuário delegada** com
permissão de escrita no plano — e o teste de fumaça (T0) mostrou que a
`portaldedemandas@mec.gov.br` **não tem essa permissão**: ela lê o plano, mas o
`msdyn_ExecuteOperationSetV1` responde
`Forbidden — Permissions required: Write.` A identidade que passa é a conta do
próprio usuário, `antoniojunior@mec.gov.br`.

```bash
cd /Users/antoniojunior/Dev/projetos_spfx/MEC_gitintegracao
node scripts/autorizarContaServicoPremium.js
```

O script imprime a URL (`https://login.microsoftonline.com/devicelogin` ou
`https://login.microsoft.com/device`) e um código. Abra a URL, entre com a conta
que vai escrever (**`antoniojunior@mec.gov.br`**), digite o código e autorize.
Se o código expirar (15 min), o script emite outro sozinho — pode deixar o
terminal rodando.

No fim ele grava o refresh token no Blob `service-tokens/premium-dataverse-refresh-token.json`
da Function App e em `.premium-refresh-token.json` (local, fora do git). Se a
gravação no Blob falhar, o script avisa explicitamente (e sai com código 1) — o
arquivo local sozinho **não** serve para a Function publicada.

> Concluído quando o script imprimir `Login concluído!` **e**
> `Refresh token salvo no Blob ... e em .premium-refresh-token.json`.

## 2. Publicar o código na Function App

```bash
func pack --output ./tmp/functionApp.zip
az functionapp deployment source config-zip \
  --subscription ccmecapppnld13383hom \
  --name func-gitintegracao \
  --resource-group rg-pnld-app-hmg-mec \
  --src tmp/functionApp.zip/MEC_gitintegracao.zip
```

Alternativas: extensão "Azure Functions" do VS Code (Deploy to Function App) ou
Deployment Center > Zip deploy no Portal.

> **Bloqueado em 26/10/2026.** A conta `antoniobjunior@mec.gov.br` não tem
> `Microsoft.Web/sites/*` no RG `rg-pnld-app-hmg-mec` — o `az` responde
> `AuthorizationFailed` em `sites/read` e em `sites/config/list/action`.
> Não é token velho: o erro persiste em qualquer comando do `az` sobre o app.
> **Desbloqueio:** pedir (ao dono do RG) a atribuição de `Contributor` no
> `rg-pnld-app-hmg-mec` — ou, no mínimo, `Microsoft.Web/sites/*` (ler, escrever
> configuração e fazer deploy de zip). Sem isso, o passo 2 não roda e o sync
> precisa ser feito localmente (§4-alt).

## 3. Dry run (não escreve nada)

Via Function (precisa do passo 2):

```bash
curl -s -X POST \
  -H "Content-Type: application/json" \
  -H "x-functions-key: $FUNCTION_KEY" \
  -d '{"planId":"c385351a-e450-4d54-87ed-d54c57794f7b","dryRun":true,"pageSize":100}' \
  "https://func-gitintegracao-febwfvfnbwchbbhb.brazilsouth-01.azurewebsites.net/api/gitlab-planner-premium-homologacao" \
  | python3 -m json.tool
```

Local (sem deploy — mesmo handler, mesmas dependências):

```bash
node scripts/sync-premium-homologacao-local.js --dry-run
```

Esperado na primeira vez: `created: 588`, `skipped: 134` (issues canceladas),
`updated: 0`, `errors: []`. O `nextCursor` devolvido é o da página seguinte.

## 4. Primeira execução real (588 tasks)

Rode o mesmo curl **sem** `dryRun`, página a página, repassando o `nextCursor`:

```bash
CURSOR=""
while : ; do
  RESP=$(curl -s -X POST -H "Content-Type: application/json" \
    -H "x-functions-key: $FUNCTION_KEY" \
    -d "{\"planId\":\"c385351a-e450-4d54-87ed-d54c57794f7b\",\"pageSize\":100,\"cursor\":\"$CURSOR\"}" \
    "https://func-gitintegracao-febwfvfnbwchbbhb.brazilsouth-01.azurewebsites.net/api/gitlab-planner-premium-homologacao")
  echo "$RESP" | python3 -m json.tool
  CURSOR=$(echo "$RESP" | python3 -c "import json,sys; print(json.load(sys.stdin).get('nextCursor') or '')")
  [ -z "$CURSOR" ] && break
done
```

São **9 chamadas** (8 páginas de issues abertas + 1 de issues fechadas). O ciclo
termina quando `nextCursor` vier `null`.

> A cota do Premium é de **10 operation sets vivos por usuário**: o sync apaga o
> registro de cada set assim que as tasks materializam, então uma página
> (100 tasks) consome 1 set por vez.
>
> **A ordem importa:** o Dataverse aplica o operation set de forma assíncrona.
> Apagar o registro do set *antes* das tasks aparecerem cancela a criação
> pendente (a task nunca chega a existir). O sync espera a materialização
> (até ~30 s) antes de apagar o registro, e só grava o mapping das tasks
> confirmadas — mapping com id de task inexistente nunca é gravado.

### 4-alt. Execução real sem deploy (local)

É o caminho usado em 26/10/2026 enquanto o RBAC do §2 não se resolve. O runner
chama o mesmo handler (`premiumHandler.runPremiumSync`) e os mesmos módulos da
Function — a única diferença é onde ele roda e de onde sai o token de escrita.

```bash
# token delegado da conta logada no Azure CLI (sem navegador)
export PREMIUM_TEST_ACCESS_TOKEN=$(az account get-access-token \
  --resource https://orgcf194dda.crm.dynamics.com --query accessToken -o tsv)

node scripts/sync-premium-homologacao-local.js
```

O token do PRD (org Aplicativos, onde fica o mapping) sai sempre por client
credentials (`app-pnld`). Sem `PREMIUM_TEST_ACCESS_TOKEN`, o runner usa o refresh
token do device code flow (Blob/arquivo) — que é o caminho da Function
publicada.

### 4-bis. Limpeza (tasks de teste e mappings órfãos)

Se uma rodada morreu antes de gravar o mapping (ou o set foi apagado no
momento errado), sobram mappings apontando para tasks que não existem. O
script apaga as tasks de teste do plano e os mappings órfãos do PRD:

```bash
export PREMIUM_TEST_ACCESS_TOKEN=$(az account get-access-token \
  --resource https://orgcf194dda.crm.dynamics.com --query accessToken -o tsv)

node scripts/limpar-lixo-homologacao.js --dry-run   # só conta
node scripts/limpar-lixo-homologacao.js             # apaga
```

A remoção de tasks também é assíncrona (vai por `msdyn_PssDeleteV2`), então o
script espera as tasks sumirem antes de apagar o registro do set.

## 5. Conferir o resultado

- Planner: plano "Homologação _NOVO SISTEC 2 - Cópia" → bucket "Bucket 1" → 588 tasks
  novas com assunto `[#iid] título`.
- Dataverse PRD: tabela `pmo_mapeamentoplanner` → 588 linhas com
  `pmo_plannerplanid = c385351a-e450-4d54-87ed-d54c57794f7b` e
  `pmo_plannertaskid` preenchido.

```bash
node scripts/diag-mapeamento-schema.js   # ou a consulta OData direta
```

## 6. Rodar de novo (idempotência)

Repita o passo 4. O diff (`pmo_gitlab_updatedat`, criado em 26/10/2026) faz o
sync não recriar task nenhuma: o resultado esperado é `created: 0`, `updated: N`
(só o que mudou no GitLab).

> A coluna `pmo_gitlab_updatedat` **existe** desde 26/10/2026 (criada por
> `scripts/criar-coluna-pmo-gitlab-updatedat.js`). O plano B
> (`pmo_dataultimasincronizacao`) continua no código como fallback, para orgs
> onde a coluna não pode ser criada.

Se uma rodada anterior tiver criado as tasks e **morreu antes de gravar o
mapping** (timeout do HTTP, rede caiu), a rodada seguinte não duplica: ela
pergunta o que já existe no plano, adota a task com o mesmo assunto e grava o
mapping com o id existente. Nesse caso o contador `created` ainda conta a issue
(ela não tinha task antes), mas nenhuma task nova é criada no Planner — confira
o plano para ter certeza.

## 7. Criar o flow do Power Automate

Blueprint passo a passo em
[`PA-FLOW-sync-gitlab-planner-premium-homologacao.md`](PA-FLOW-sync-gitlab-planner-premium-homologacao.md).

O flow: `HTTP > Repetir` numa chamada ao endpoint, repassa o `nextCursor` e
termina quando vier `null`. Ativar "Repetir" com 3 tentativas (senão a mesma
página é repetida em caso de falha).

> O flow só entra em produção depois do §2 (deploy) — hoje o endpoint publicado
> ainda é a versão antiga do sync.

---

## Diagnóstico

| Sintoma | Causa | O que fazer |
|---|---|---|
| `UserNotLicensed` | identidade sem licença de projeto no Planner Premium | refazer o passo 1 com a conta `antoniojunior@mec.gov.br` |
| `Forbidden — Permissions required: Write.` no `msdyn_ExecuteOperationSetV1` | a conta lê o plano mas não tem escrita nele | trocar de identidade (a `portaldedemandas` cai aqui) e refazer o passo 1 |
| `invalid_grant` no refresh | refresh token expirado/rotacionado | refazer o passo 1 |
| `Acesso restrito` (403) do GitLab | WAF barra rajadas de requests | rodar página a página (o runtime por página funciona) |
| `AuthorizationFailed` no `az` | RBAC da conta oscilando | retry; se persistir, pedir reatribuição de papel no RG (§2) |
| `nextCursor` sempre igual | a Function falhou no meio | ver o erro no corpo da resposta / logs da Function App |
| Task criada mas não aparece no plano | o Dataverse replica a task alguns segundos depois do execute | esperar ~5 s e consultar de novo (o smoke test já faz retry) |
| `Não é possível executar diretamente a operação "Delete"` | o Dataverse recusa `DELETE` em `msdyn_projecttask` | apagar via operation set (`msdyn_PssDeleteV2`) ou pela UI do Planner |
| `OperationSet do tipo Create contém entidades duplicadas` | faltou `msdyn_projecttaskid` nas entidades (o action exige um id por entidade) | o código já atribui um GUID por task; se reaparecer, é entidade montada à mão |
| `Beyond max limit of 100000 characters field: notes` | `msdyn_description` com 100.000+ caracteres (limite exclusivo) | truncar em 99.000 (já é o default do código) |
| `percent outside of bounds on element: ... field: percentComplete` | `msdyn_progress` é razão **0..1** nesta API (1 = 100%); 50 e 100 são recusados | mandar 1 para issue fechada (já é o default do código) |
| Task não aparece no plano, mas o `created`Contou a issue | o registro do operation set foi apagado antes da materialização e a criação pendente foi cancelada | o código já espera a materialização antes de apagar o set; rode `scripts/limpar-lixo-homologacao.js` para limpar mappings órfãos |
| `O projeto referenciado com a ID 00000000-0000-... não corresponde` (no delete) | a entidade de delete precisa do vínculo do projeto | mandar `msdyn_project@odata.bind` na entidade de delete |
| `OperationSet do tipo Delete contém entidades duplicadas` | a entidade de delete sem assunto colide com as outras | mandar `msdyn_subject` e o vínculo do projeto na entidade de delete |
| A data de fim gravada é um dia útil **antes** da pedida | o Planner Premium reAgenda as datas pelo calendário de trabalho do projeto | esperado — o `finish` vira o último dia útil antes da data pedida |
| A descrição gravada difere do que foi enviado (tags em minúsculas, `&gt;`, `&quot;`, sem o comentário HTML inicial) | o Planner Premium normaliza o texto como HTML | esperado — a confirmação compara a impressão digital do texto, não o texto exato |
| Toda rodada reescreve todas as tasks (nada é "unchanged") | o `pmo_gitlab_updatedat` é gravado com precisão de segundo, mas o GitLab manda milissegundos | comparação corrigida para segundos — em 26/10/2026 a rodada de validação marcou o que era realmente igual |
| A task não materializa dentro de ~30 s | o lote materializa inteiro de uma vez, ~30 s depois do execute (100 tasks) | a espera do sync tem prazo de 120 s e sonda 1 task por vez até o lote aparecer |
