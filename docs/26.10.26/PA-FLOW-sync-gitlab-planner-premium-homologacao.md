# Flow do Power Automate — Sync GitLab → Planner Premium (Homologação)

Complemento operacional do [plano de sync](PLAN-sync-gitlab-planner-premium-homologacao.md).
O flow existe porque o Function App é **Consumption Y1**: a resposta HTTP é cortada
em ~230 s, e o sync do plano de homologação tem ~720 issues. Cada chamada da
Function processa **uma página** e devolve o cursor da próxima.

> **Status:** o flow ainda não foi criado. O endpoint já está pronto e testado
> (dry run). Este documento é o passo a passo para montá-lo.

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
2. **Inicializar variável `cursor`** (String) = `""`.
3. **Until** — condição: `equals(variables('cursor'), null)`:
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
   - **Definir variável `cursor`** = `body('Sincronizar página')?['nextCursor']`
   - **Aplicar a cada** de `body('Sincronizar página')?['created']` → registrar o iid (opcional, só log).
   - **Aplicar a cada** de `body('Sincronizar página')?['updated']` → idem.
4. **Responder/encerrar** com o resumo (opcional).

### Por que o cursor é opaco

O `nextCursor` é um base64url com o número da página. O flow só repassa o valor
recebido — não precisa entender o formato. Quando o GitLab não devolve mais
páginas, a Function responde `nextCursor: null` e o laço termina.

### Laço infinito?

A cada chamada a Function consome uma página do GitLab (100 issues). São ~8
iterações para as ~720 issues. Se a Function falhar, o `nextCursor` não muda e o
flow repetiria a mesma página: por isso **ative "Repetir" com tentativas = 3 e
exceção após isso** nas configurações do Until, e trate erro com um *Terminate* /
*Scope* de erro.

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
