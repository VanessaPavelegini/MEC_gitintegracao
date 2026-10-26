# RUNBOOK — Sync GitLab → Planner Premium (Homologação _NOVO SISTEC 2 - Cópia)

Passo a passo para deixar o sync rodando. Cada passo depende do anterior.

Ambiente: repo `MEC_gitintegracao` · Function App `func-gitintegracao` (RG
`rg-pnld-app-hmg-mec`, subscription `ccmecapppnld13383hom`) · org Planner Premium
`https://orgcf194dda.crm.dynamics.com` · org do mapping `https://org41ecace2.crm2.dynamics.com`.

---

## 1. Autorizar a conta de serviço (precisa do navegador)

O app `app-pnld` (client credentials) é bloqueado com `UserNotLicensed` no Planner
Premium. A identidade da escrita é a conta `portaldedemandas@mec.gov.br`, via device
code flow.

```bash
cd /Users/antoniojunior/Dev/projetos_spfx/MEC_gitintegracao
node scripts/autorizarContaServicoPremium.js
```

O script imprime a URL (`https://login.microsoftonline.com/devicelogin` ou
`https://login.microsoft.com/device`) e um código. Abra a URL, entre com a conta
`portaldedemandas@mec.gov.br`, digite o código e autorize. Se o código expirar
(15 min), o script emite outro sozinho — pode deixar o terminal rodando.

No fim ele grava o refresh token no Blob `service-tokens/premium-dataverse-refresh-token.json`
da Function App e em `.premium-refresh-token.json` (local, fora do git).

> Concluído quando o script imprimir `Login concluído!`.

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

## 3. Dry run (não escreve nada)

```bash
curl -s -X POST \
  -H "Content-Type: application/json" \
  -H "x-functions-key: $FUNCTION_KEY" \
  -d '{"planId":"c385351a-e450-4d54-87ed-d54c57794f7b","dryRun":true,"pageSize":100}' \
  "https://func-gitintegracao-febwfvfnbwchbbhb.brazilsouth-01.azurewebsites.net/api/gitlab-planner-premium-homologacao" \
  | python3 -m json.tool
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

> A cota do Premium é de **10 operation sets vivos por usuário**: o sync descarta
> cada set logo após executar, então uma página (100 tasks) consome 1 set por vez.

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

Repita o passo 4. O diff (`pmo_gitlab_updatedat`, ou `pmo_dataultimasincronizacao`
enquanto a coluna nova não existir) faz o sync não recriar task nenhuma: o
resultado esperado é `created: 0`, `updated: N` (só o que mudou no GitLab).

## 7. Criar o flow do Power Automate

Blueprint passo a passo em
[`PA-FLOW-sync-gitlab-planner-premium-homologacao.md`](PA-FLOW-sync-gitlab-planner-premium-homologacao.md).

O flow: `HTTP > Repetir` numa chamada ao endpoint, repassa o `nextCursor` e
termina quando vier `null`. Ativar "Repetir" com 3 tentativas (senão a mesma
página é repetida em caso de falha).

---

## Diagnóstico

| Sintoma | Causa | O que fazer |
|---|---|---|
| `UserNotLicensed` | identidade sem licença de projeto no Planner Premium | refazer o passo 1 com a conta `portaldedemandas` |
| `invalid_grant` no refresh | refresh token expirado/rotacionado | refazer o passo 1 |
| `Acesso restrito` (403) do GitLab | WAF barra rajadas de requests | rodar página a página (o runtime por página funciona) |
| `AuthorizationFailed` no `az` | RBAC da conta oscilando | retry; se persistir, pedir reatribuição de papel no RG |
| `nextCursor` sempre igual | a Function falhou no meio | ver o erro no corpo da resposta / logs da Function App |
