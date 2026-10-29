# Flow do Power Automate — Sync GitLab → Planner Premium (Homologação)

Complemento operacional do [plano de sync](PLAN-sync-gitlab-planner-premium-homologacao.md).
O flow existe porque o Function App é **Consumption Y1**: a resposta HTTP é cortada
em ~230 s, e o sync do plano de homologação tem ~720 issues. Cada chamada da
Function processa **uma página** e devolve o cursor da próxima.

> **Leia antes (29/10/2026):** o PA **não é mais a única forma** de manter o
> Planner em dia. A manutenção do dia a dia passou a ser feita por um **timer
> interno da Function App** com varredura incremental (811 issues → ~18 por
> janela), que dispensa o PA e cabe numa chamada só. O flow abaixo continua
> válido e útil para a **carga inicial** e para a varredura completa.
> Detalhes em
> [DETECCAO-mudancas-gitlab-premium.md](DETECCAO-mudancas-gitlab-premium.md).

> **Status (27/10/2026):** a rota **está publicada** na `func-gitintegracao` e
> responde — verificado em 27/10/2026:
>
> | Verificação | Resultado |
> |---|---|
> | `POST /api/gitlab-planner-premium-homologacao` com `?code=` | 200 |
> | `POST` sem chave | 401 (authLevel `function`) |
> | `GET /api/gitlab-planner-premium-homologacao-buckets` | 200, devolve `Bucket 1` = `be10a1da-…` |
> | Dry run completo (9 chamadas, cursor repassado) | 811 issues: 576 unchanged, 223 skipped, 12 a atualizar, 0 a criar |
>
> **O único bloqueio para a execução real:** o refresh token da conta de
> serviço está vencido (`AADSTS70043`, expirado por sign-in frequency do
> conditional access) — o token no Blob e o arquivo local estão ambos mortos.
> Qualquer chamada que não seja dry run responde 500 até reautorizar:
>
> ```bash
> node scripts/autorizarContaServicoPremium.js
> ```
>
> O dry run passa porque não escreve no Dataverse, e por isso não precisa do
> token delegado.
>
> A identidade de escrita é `portaldedemandas@mec.gov.br` — a conta de serviço
> do Portal de Demandas.
>
> **Histórico do bloqueio de licença (resolvido em 28/10/2026).** Até 27/10 a
> `portaldedemandas` lia o plano mas o `msdyn_ExecuteOperationSetV1` respondia
> `400 Forbidden — "Permissions required: Write."` nos **dois** planos (o novo
> `c0ecce95` e o antigo `c385351a`):
>
> | Passo | Resultado (até 27/10) |
> |---|---|
> | Ler buckets (`GET msdyn_projectbuckets`) | ✅ 1 bucket visível |
> | `msdyn_CreateOperationSetV1` | ✅ cria o set |
> | `msdyn_PssCreateV2` (enfileirar task) | ✅ enfileira |
> | `msdyn_ExecuteOperationSetV1` (gravar) | ❌ `400 Forbidden — "Permissions required: Write."` |
>
> **Causa raiz: falta de licença, não de compartilhamento.** A conta não tinha o
> service plan `DYN365_CDS_PROJECT` (Dataverse for Project). Só tinha
> `M365EDU_A5_FACULTY`, que traz `PROJECT_O365_P3` / `PROJECTWORKMANAGEMENT` —
> o Project for the web, que **não** dá escrita em plano Premium. Não era
> permissão de plano: a `portaldedemandas` já estava no grupo M365 owner do
> plano (`CpiaNOVOSISTEC2-@mec.gov.br`), no owning team do Dataverse dos dois
> planos e tinha os diretórios Dynamics 365 Administrator e Power Platform
> Administrator. **Adicionar alguém ao projeto não resolve** — o que resolve é
> atribuir a licença com `DYN365_CDS_PROJECT`.
>
> **Resolução:** a requisição **REQ676377** reatribuiu a licença e a conta
> passou a ter `PROJECTPROFESSIONAL_FACULTY` (que traz `DYN365_CDS_PROJECT` +
> `PROJECT_CLIENT_SUBSCRIPTION`). Em 28/10/2026 a escrita foi reconfirmada:
> o `msdyn_ExecuteOperationSetV1` responde 200 e a task materializa nos dois
> planos. O refresh token no Blob foi rotacionado para a conta de serviço, e o
> sync completo rodou pela rota publicada com 0 erros.
>
> Para reconfirmar depois de mudar a licença (não toca no token de produção):
>
> ```bash
> node scripts/autorizar-conta-teste-premium.js   # device code com a conta
> node scripts/verificar-acesso-escrita-premium.js # leitura + set + execute
> ```
>
> Relatório completo (o que foi feito, com qual conta, o que trava):
> [`RELATORIO-sync-premium-homologacao.md`](RELATORIO-sync-premium-homologacao.md).

---

## 1. Dados do plano (homologação)

| Item | Valor |
|---|---|
| Plano (msdyn_project) | `c0ecce95-1107-4343-8c05-bcf7c9a291f8` — plano Premium de homologação (novo) |
| Bucket | `be10a1da-0bd2-f111-84dc-7c1e520d9dbb` — "Bucket 1" (único no plano) |
| Org do Planner Premium | `https://orgcf194dda.crm.dynamics.com` (Default) |
| Org do mapping | `https://org41ecace2.crm2.dynamics.com` (Aplicativos PRD) |
| Endpoint | `POST https://func-gitintegracao-febwfvfnbwchbbhb.brazilsouth-01.azurewebsites.net/api/gitlab-planner-premium-homologacao?code=<FUNCTION_KEY>` |

`planId`, `bucketId`, `pageSize`, `dryRun` e `cursor` podem ir no corpo do POST.
Se `bucketId` não vier, a Function resolve pelo nome (`Bucket 1`).

> **O plano e o bucket já vêm do app setting** (`PREMIUM_HOMOLOGACAO_PLAN_ID`,
> `PREMIUM_HOMOLOGACAO_BUCKET_ID`), que a Function publicada usa como padrão.
> O corpo do POST pode trazer só o `cursor` — e é o que o flow de §2 faz.
>
> ⚠️ Os valores acima são os **atuais** (verificados na Function App em
> 27/10/2026). A versão anterior deste documento apontava para o plano
> `c385351a` / bucket `f704c207`, que era o plano da cópia anterior. Copiar
> aqueles IDs no corpo faria o sync escrever no plano errado. Para conferir os
> valores vigentes a qualquer momento:
>
> ```bash
> curl -s -H "x-functions-key: $FUNCTION_KEY" \
>   "https://func-gitintegracao-febwfvfnbwchbbhb.brazilsouth-01.azurewebsites.net/api/gitlab-planner-premium-homologacao-buckets"
> ```

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
         "cursor": "@{variables('cursor')}"
       }
       ```
     - Configurações da ação: **Repetir** até 3 vezes, intervalo 60 s.
   - **Definir variável `cursor`** = `coalesce(body('Sincronizar página')?['nextCursor'], '')`
   - **Definir variável `terminate`** = `equals(body('Sincronizar página')?['nextCursor'], null)`
   - **Compor** o log da iteração: `concat('página ', string(body('Sincronizar página')?['page']), ' — criadas: ', string(body('Sincronizar página')?['created']), ', atualizadas: ', string(body('Sincronizar página')?['updated']), ', ignoradas: ', string(body('Sincronizar página')?['skipped']))`
4. **Responder/encerrar** com o resumo (opcional).

> **`created` e `updated` são contadores, não listas.** A resposta da Function
> traz `created: 12`, `updated: 3` — números. A versão anterior deste documento
> pedia "Aplicar a cada" sobre eles, o que quebraria o flow com erro de tipo.
> Para iterar item a item, o único array da resposta é `errors` (lista de
> `{ iid, message }` das issues que falharam) — e, num fluxo happy path, ela vem
> vazia.

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

## 2-bis. Alternativa sem deploy: chamar o host local por um túnel

O deploy **está feito** (ver status no topo), então o caminho normal é a URL
publicada. Mas se em algum momento for preciso rodar contra a máquina local
(`func start`, porta 7071), o Power Automate precisa de um túnel:

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
     -d '{"dryRun":true,"pageSize":100}' \
     "https://func-gitintegracao-febwfvfnbwchbbhb.brazilsouth-01.azurewebsites.net/api/gitlab-planner-premium-homologacao" \
     | python3 -m json.tool
   ```

   Resposta esperada: `{"ok":true,"planId":"c0ecce95-…","dryRun":true,"created":N,"updated":M,"skipped":K,"nextCursor":"..."}`.

   No plano de homologação atual o mapping já existe (588 tasks sincronizadas),
   então o dry run devolve **`created: 0`** e `updated` = quantas issues mudaram
   desde o último sync. `created` grande só happens em plano novo.

2. Navegue de página em página trocando o `cursor` até `nextCursor: null` e some
   os totais — é o número de tasks que serão criadas ou atualizadas.

3. Só depois rode o flow de verdade (`"dryRun": false`).

---

## 4. Depois da primeira execução

- O mapping fica em `pmo_mapeamentoplanner` (Aplicativos PRD), filtrado por
  `pmo_plannerplanid = c0ecce95-1107-4343-8c05-bcf7c9a291f8`.
- A segunda execução do flow deve devolver `created: 0, updated: 0` (ou quase) —
  o diff usa o `updated_at` da issue guardado no mapping
  (`pmo_gitlab_updatedat`, que já existe no schema do PRD).
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
- **O refresh token da conta de serviço expira** — o conditional access do
  tenant impõe sign-in frequency, e o AAD devolve `AADSTS70043` quando o token
  passa do limite (79200 s ≈ 22 h). A Function renova o token sozinho a cada
  troca, mas se a renovação falhar a rota responde 500 e o flow para. A
  remediacão é rodar `scripts/autorizarContaServicoPremium.js` de novo. Se o
  flow for agendado e não supervisionado, vale monitorar o 500 no histórico
  da execução.
