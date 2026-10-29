# RUNBOOK — Sync GitLab → Planner Premium (Homologação _NOVO SISTEC 2 - Cópia)

Passo a passo para deixar o sync rodando. Cada passo depende do anterior.

Ambiente: repo `MEC_gitintegracao` · Function App `func-gitintegracao` (RG
`rg-pnld-app-hmg-mec`, subscription `ccmecapppnld13383hom`) · org Planner Premium
`https://orgcf194dda.crm.dynamics.com` · org do mapping `https://org41ecace2.crm2.dynamics.com`.

> **Estado em 29/10/2026 (ATUALIZADO — use estes valores):**
>
> | Item | Valor atual |
> |---|---|
> | Identidade de escrita | **`portaldedemandas@mec.gov.br`** (conta de serviço) |
> | Plano | **`c0ecce95-1107-4343-8c05-bcf7c9a291f8`** (novo) |
> | Bucket | **`be10a1da-0bd2-f111-84dc-7c1e520d9dbb`** ("Bucket 1") |
> | Deploy | **funcional** — rota publicada e respondendo |
> | Manutenção diária | **timer interno de 30 min** — não precisa de Power Automate |
>
> O histórico deste documento (26/10) citava `antoniojunior@mec.gov.br` e o plano
> `c385351a` / bucket `f704c207`. **A conta antiga e o plano antigo ainda
> funcionam**, mas o alvo de produção é o novo. Detalhes de cada virada:
> [RETOMADA de 29/10](../26.10.29/RETOMADA-pos-reinicio.md) e a memória
> `premium-identidade-escrita`.
>
> A identificação do plano continua sendo pelo **app setting**
> (`PREMIUM_HOMOLOGACAO_PLAN_ID` / `PREMIUM_HOMOLOGACAO_BUCKET_ID`) — o corpo do
> POST pode trazer só o `cursor`. Para conferir os valores vigentes:
>
> ```bash
> curl -s -H "x-functions-key: $FUNCTION_KEY" \
>   "https://func-gitintegracao-febwfvfnbwchbbhb.brazilsouth-01.azurewebsites.net/api/gitlab-planner-premium-homologacao-buckets"
> ```
>
> **Este runbook cobre a carga inicial e a varredura completa.** Para a
> manutenção do dia a dia (usuário mexeu na issue → Planner reflete), veja o
> [guia de detecção por timer](DETECCAO-mudancas-gitlab-premium.md).

---

## 1. Autorizar a conta de serviço (precisa do navegador)

O app `app-pnld` (client credentials) é bloqueado com `UserNotLicensed` no Planner
Premium. A identidade da escrita é uma **conta de usuário delegada** com
licença de projeto — hoje é a conta de serviço do Portal de Demandas,
**`portaldedemandas@mec.gov.br`** (dois `d`).

> **Histórico:** até 27/10 a `portaldedemandas` lia o plano mas o
> `msdyn_ExecuteOperationSetV1` respondia
> `Forbidden — Permissions required: Write.`. A causa era falta do service plan
> `DYN365_CDS_PROJECT` — **não** era compartilhamento. A requisição REQ676377
> reatribuiu a licença (ela passou a `PROJECTPROFESSIONAL_FACULTY`) e a escrita
> foi destravada em 28/10/2026. A `antoniojunior@mec.gov.br` tem o mesmo SKU e
> também serve, mas é conta de pessoa: prefira a de serviço.

```bash
cd /Users/antoniojunior/Dev/projetos_spfx/MEC_gitintegracao
node scripts/autorizarContaServicoPremium.js
```

O script imprime a URL (`https://login.microsoftonline.com/devicelogin` ou
`https://login.microsoft.com/device`) e um código. Abra a URL, entre com a conta
que vai escrever (**`portaldedemandas@mec.gov.br`**), digite o código e autorize.
Se o código expirar (15 min), o script emite outro sozinho — pode deixar o
terminal rodando.

No fim ele grava o refresh token no Blob `service-tokens/premium-dataverse-refresh-token.json`
da Function App e em `.premium-refresh-token.json` (local, fora do git). Se a
gravação no Blob falhar, o script avisa explicitamente (e sai com código 1) — o
arquivo local sozinho **não** serve para a Function publicada.

> **O AAD rotaciona o refresh token a cada troca.** O token novo precisa ser
> gravado no Blob, senão o próximo cold start falha. O limite do conditional
> access do tenant é de **22 h** (79200 s) — expirado, aparece `AADSTS70043` e
> o passo 1 precisa ser refeito.

> Concluído quando o script imprimir `Login concluído!` **e**
> `Refresh token salvo no Blob ... e em .premium-refresh-token.json`.

Para **testar** uma conta sem tocar no token de produção (grava em
`.premium-refresh-token.test.json`, que é gitignored):

```bash
node scripts/autorizar-conta-teste-premium.js
node scripts/verificar-acesso-escrita-premium.js
```

## 2. Publicar o código na Function App

> **Resolvido em 27/10/2026** — o RBAC foi destravado (PIM renovado) e o deploy
> funciona. Use o comando do Core Tools, que usa credencial própria e funciona
> mesmo com o `az` vencido:
>
> ```bash
> func azure functionapp publish func-gitintegracao --javascript
> ```
>
> Depois do publish, as rotas novas demoram **~2 min** para responder (404 até o
> sync de triggers). Para conferir:
>
> ```bash
> curl -s -H "x-functions-key: $FUNCTION_KEY" \
>   "https://func-gitintegracao-febwfvfnbwchbbhb.brazilsouth-01.azurewebsites.net/api/gitlab-planner-premium-homologacao-buckets"
> ```
>
> O método alternativo (zip deploy) segue válido:
>
> ```bash
> func pack --output ./tmp/functionApp.zip
> az functionapp deployment source config-zip \
>   --subscription ccmecapppnld13383hom \
>   --name func-gitintegracao \
>   --resource-group rg-pnld-app-hmg-mec \
>   --src tmp/functionApp.zip/MEC_gitintegracao.zip
> ```
>
> Alternativas: extensão "Azure Functions" do VS Code (Deploy to Function App) ou
> Deployment Center > Zip deploy no Portal.
>
> **Armadilha do `az`:** o `app-pnld` não tem `Microsoft.Web/sites/*` no ARM
> (403 em listKeys) — para ler app settings é preciso `az login` do usuário. O
> GUID da subscription é `7def3c16-d18b-40d5-9aa4-ce0f1ec495b7` (o nome
> `ccmecapppnld13383hom` no código dos scripts é inválido para a API ARM).

## 3. Dry run (não escreve nada)

Via Function (precisa do passo 2):

```bash
curl -s -X POST \
  -H "Content-Type: application/json" \
  -H "x-functions-key: $FUNCTION_KEY" \
  -d '{"planId":"c0ecce95-1107-4343-8c05-bcf7c9a291f8","dryRun":true,"pageSize":100}' \
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
    -d "{\"planId\":\"c0ecce95-1107-4343-8c05-bcf7c9a291f8\",\"pageSize\":100,\"cursor\":\"$CURSOR\"}" \
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

É o caminho usado em 26/10/2026 enquanto o RBAC do §2 não se resolvia. O runner
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
  `pmo_plannerplanid = c0ecce95-1107-4343-8c05-bcf7c9a291f8` e
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

> **O flow já está publicado e validado.** Ele continua útil para a carga
> inicial e a varredura completa. Para a manutenção do dia a dia, porém, a
> Function App tem **timer interno de 30 min** que faz a varredura incremental
> sozinho — ver [DETECCAO-mudancas-gitlab-premium.md](DETECCAO-mudancas-gitlab-premium.md).
> Com o timer ativo, o Power Automate é redundante.

---

## Diagnóstico

| Sintoma | Causa | O que fazer |
|---|---|---|
| `UserNotLicensed` | identidade sem licença de projeto no Planner Premium | refazer o passo 1 com a conta `portaldedemandas@mec.gov.br` (ou o `app-pnld` — que **nunca** vai funcionar: não tem licença) |
| `Forbidden — Permissions required: Write.` no `msdyn_ExecuteOperationSetV1` | a conta lê o plano mas não tem escrita nele | falta o service plan `DYN365_CDS_PROJECT` (licença `PROJECTPROFESSIONAL_FACULTY`) — pedir reatribuição de licença (REQ676377 resolveu em 28/10/2026); adicionar ao projeto **não** resolve |
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
