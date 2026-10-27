# Flow do Power Automate — Sync GitLab → Planner Premium (Homologação)

Complemento operacional do [plano de sync](PLAN-sync-gitlab-planner-premium-homologacao.md).
O flow existe porque o Function App é **Consumption Y1**: a resposta HTTP é cortada
em ~230 s, e o sync do plano de homologação tem ~720 issues. Cada chamada da
Function processa **uma página** e devolve o cursor da próxima.

> **Status (27/10/2026):** o flow ainda não foi criado e a rota **ainda não está
> publicada** — o app publicado responde **404** em
> `/api/gitlab-planner-premium-homologacao` (o app tem `/api/health`,
> `/api/gitlab-planner-sync` e `/api/premium-health`, mas não a rota nova),
> porque o deploy está bloqueado por RBAC. O código da rota está pronto e
> testado (91 testes; dry run e execução real rodados **localmente**). Este
> documento é o passo a passo para montar o flow.
>
> Relatório completo (o que foi feito, com qual conta, o que trava):
> [`RELATORIO-sync-premium-homologacao.md`](RELATORIO-sync-premium-homologacao.md).

---

## 1. Dados do plano (homologação)

| Item | Valor |
|---|---|
| Plano (msdyn_project) | `c385351a-e450-4d54-87ed-d54c57794f7b` — "Homologação _NOVO SISTEC 2 - Cópia" |
| Bucket | `f704c207-84be-f111-a04d-7c1e520d9f67` — "Bucket 1" (único no plano) |
| Org do Planner Premium | `https://orgcf194dda.crm.dynamics.com` (Default) |
| Org do mapping | `https://org41ecace2.crm2.dynamics.com` (Aplicativos PRD) |
| Endpoint | `POST https://func-gitintegracao-febwfvfnbwchbbhb.brazilsouth-01.azurewebsites.net/api/gitlab-planner-premium-homologacao?code=<FUNCTION_KEY>` |

`planId`, `bucketId`, `pageSize`, `dryRun` e `cursor` podem ir no corpo do POST.
Se `bucketId` não vier, a Function resolve pelo nome (`Bucket 1`).

---

## 2. Estrutura do flow

1. **Trigger**: "Executar manualmente (Instant cloud)" — para chamar na mão durante a validação.
   (Depois dá para trocar por "Agendamento" a cada 30 min, se Make.make sense.)
2. **Inicializar variável `terminate`** (Boolean) = `false` e **Inicializar variável `cursor`** (String) = `""`.
3. **Until** — condição: `variables('terminate')` é **igual a** `true`:
   - **HTTP — "Sincronizar página"**
     - Método: `POST`
     - URI: o endpoint acima (com `?code=<FUNCTION_KEY>`)
     - Cabeçalhos: `Content-Type: application/json`
     - Corpo:
       ```json
       {
         "planId": "c385351a-e450-4d54-87ed-d54c57794f7b",
         "bucketId": "f704c207-84be-f111-a04d-7c1e520d9f67",
         "pageSize": 100,
         "dryRun": false,
         "cursor": "@{variables('cursor')}"
       }
       ```
     - Configurações da ação: **Repetir** até 3 vezes, intervalo 60 s.
   - **Definir variável `cursor`** = `coalesce(body('Sincronizar página')?['nextCursor'], '')`
   - **Definir variável `terminate`** = `equals(body('Sincronizar página')?['nextCursor'], null)`
   - **Aplicar a cada** de `body('Sincronizar página')?['created']` → registrar o iid (opcional, só log).
   - **Aplicar a cada** de `body('Sincronizar página')?['updated']` → idem.
4. **Responder/encerrar** com o resumo (opcional).

### Por que a condição do Until é uma variável booleana

O Until avalia a condição **antes** da primeira iteração. Se a condição fosse
`equals(variables('cursor'), null)` e o cursor começasse como `""` (ou `null`),
o laço terminaria **sem executar nenhuma página** — o flow não faria nada. Por
isso a condição é a variável `terminate`, que começa `false` e só vira `true`
quando a Function devolve `nextCursor: null` (fim das páginas). A alternativa
equivalente é inicializar o cursor com um valor não-vazio (ex.: `"start"`) e
usar `empty(variables('cursor'))` como condição.

### Por que o cursor é opaco

O `nextCursor` é um base64url com a página e a **fase** (`{"page":N,"phase":"opened"}`
ou `{"page":1,"phase":"closed"}`). O flow só repassa o valor recebido — não precisa
entender o formato. A fase `opened` percorre as issues abertas (cria/atualiza as
tasks); quando ela acaba, a Function devolve o cursor da fase `closed`, que só
completa com 100% as tasks de issues que já existem (nunca cria task nova para
issue fechada). Quando não há mais nada, a Function responde `nextCursor: null` e o
laço termina.

### Laço infinito?

A cada chamada a Function consome uma página do GitLab (100 issues). São **9
iterações** para as 811 issues do projeto (722 abertas + 89 fechadas). Se a
Function falhar, o `nextCursor` não muda e o flow repetiria a mesma página: por
isso **ative "Repetir" com tentativas = 3 e exceção após isso** nas configurações
do Until, e trate erro com um *Terminate* / *Scope* de erro.

---

## 2-bis. Sem deploy: chamar o host local por um túnel

Enquanto o deploy estiver bloqueado por RBAC (§2 do
[RUNBOOK](RUNBOOK-sync-premium-homologacao.md)), a rota nova **existe** no host
local (`func start`, porta 7071) — verificado em 27/10/2026, inclusive sem
chave. Para o Power Automate alcançar a máquina, é preciso um túnel:

```bash
# Azure Dev Tunnels (ou: cloudflared tunnel --url http://localhost:7071)
devtunnel host --port 7071 --allow-anonymous
```

No flow, troque a URI pela URL do túnel (`?code=<FUNCTION_KEY>` continua
valendo; o header `x-functions-key` é aceito). Limitações: a URL muda a cada
sessão, a máquina precisa ficar ligada e o plano ganha tasks enquanto o túnel
estiver aberto. Detalhes no
[relatório](RELATORIO-sync-premium-homologacao.md#54-caminho-b--o-provisório-sem-rbac-túnel-para-o-host-local).

---

## 3. Primeira execução (validação)

1. Rode o **dry run** primeiro (sem o flow, com curl):

   ```bash
   curl -s -X POST \
     -H "Content-Type: application/json" \
     -H "x-functions-key: $FUNCTION_KEY" \
     -d '{"planId":"c385351a-e450-4d54-87ed-d54c57794f7b","dryRun":true,"pageSize":100}' \
     "https://func-gitintegracao-febwfvfnbwchbbhb.brazilsouth-01.azurewebsites.net/api/gitlab-planner-premium-homologacao" \
     | python3 -m json.tool
   ```

   Resposta esperada: `{"ok":true,"dryRun":true,"created":N,"updated":M,"skipped":K,"nextCursor":"..."}`
   com `created` grande (as ~560 tasks do cliente não têm mapping).

2. Navegue de página em página trocando o `cursor` até `nextCursor: null` e some
   os totais — é o número de tasks que serão criadas.

3. Só depois rode o flow de verdade (`"dryRun": false`).

---

## 4. Depois da primeira execução

- O mapping fica em `pmo_mapeamentoplanner` (Aplicativos PRD), filtrado por
  `pmo_plannerplanid = c385351a-e450-4d54-87ed-d54c57794f7b`.
- A segunda execução do flow deve devolver `created: 0, updated: 0` (ou quase) —
  o diff usa o `updated_at` da issue guardado no mapping.
- Reexecuções manuais são seguras: a Function é idempotente por iid.

---

## 5. Limitações conhecidas

- **Timeout de 230 s** do Consumption Y1: a Function processa no máximo uma
  página por chamada. Se uma página demorar demais, reduza `pageSize` (o padrão
  recomendado é 100).
- **Uma execução por vez** no mesmo plano: o sync não usa lock. Duas execuções
  simultâneas podem criar task duplicada.
- **Comentários** da issue não são sincronizados (fora do escopo do v1).
- **Assignee/prioridade** não são mapeados (o modelo Premium é diferente do
  Graph).
