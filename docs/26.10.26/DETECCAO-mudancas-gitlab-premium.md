# Detecção de mudanças no GitLab → Planner Premium

> **29/10/2026** — como o "usuário atualiza a issue no GitLab" chega ao
> Planner Premium. Complementa o
> [plano de sync](PLAN-sync-gitlab-planner-premium-homologacao.md) e o
> [PA-FLOW](PA-FLOW-sync-gitlab-planner-premium-homologacao.md).

---

## 1. A pergunta e a resposta curta

**Pergunta:** um usuário atualiza uma issue no GitLab; como o Planner
Premium fica sabendo?

**Resposta:** com uma **varredura incremental disparada por timer**. A Function
App roda de 30 em 30 minutos, pergunta ao GitLab só o que mudou na janela
(`updated_after`), compara com o que já está sincronizado (o diff por issue) e
reescreve só o que de fato mudou.

**Não precisa de Power Automate para isso.** O PA foi criado porque o sync
completo não cabia numa chamada HTTP (230 s do plano Consumption) e porque
faltava licença para a conta de serviço. As duas coisas mudaram:

| Problema | Antes | Agora |
|---|---|---|
| Sync de 811 issues | 9 chamadas, ~13 s cada | 2 chamadas, ~2,5 s (janela de 24 h) |
| Timeout de 230 s | paginação por cursor + loop no PA | cabe numa chamada só |
| Licença de escrita | app user sem licença | `portaldedemandas@mec.gov.br` |

O flow do PA **continua funcionando** e continua sendo útil para a carga
inicial (811 issues, primeira vez). O que muda é que a manutenção do dia a
dia passa a ser automática.

---

## 2. As três peças

### 2.1 A janela (`updated_after`)

O GitLab filtra issues por data de alteração. Medido no projeto real
(510, 811 issues):

| Janela | Issues devolvidas |
|---|---|
| 1 h | 0 |
| 6 h | 17 |
| 24 h | 18 |
| 30 dias | 197 |
| sem filtro | 811 |

É esse filtro que troca 811 issues por ~18. No service de GitLab, o filtro
virou `updatedAfter` em `listIssuesPage`.

### 2.2 O diff por issue

A janela é só um **filtro de tráfego**. Quem decide o que é "mudança" é o
diff por issue, que compara o `updated_at` do GitLab com o
`pmo_gitlab_updatedat` gravado no mapping (org PRD).

Por que os dois são necessários:

- A janela **pode perder** uma issue alterada antes dela (se o sync não rodou
  naquele período). Por isso a fase de varredura completa continua existindo.
- O diff é quem garante a **correção**: uma issue que voltou na janela mas
  cujo mapping já registra o mesmo `updated_at` **não** é reescrita. Sem
  ele, cada disparo reescreveria as mesmas tasks.

O diff reusa o `decideAction` do `premiumSync` — não existe uma segunda
cópia da regra de comparação (duas cópias divergindo foi exatamente o que
causou o descasamento de precisão de segundo).

**Comparação em segundos:** o Dataverse grava `DateTime` com precisão de
segundo, o GitLab manda milissegundos. Comparar no milissegundo faria **toda**
issue parecer alterada.

### 2.3 O disparo

`app.timer` na Function App, a cada 30 minutos, com janela de 60 minutos.
A janela é **maior** que o intervalo de propósito: se um disparo falhar ou
demorar, o próximo ainda cobre a janela toda.

---

## 3. Endpoints

### `POST /api/gitlab-planner-premium-changes`

Varre a janela e aplica as mudanças.

| Parâmetro | Padrão | O que faz |
|---|---|---|
| `planId` | app setting | plano alvo |
| `bucketId` | app setting | bucket destino (se não vier, resolve pelo nome) |
| `lookbackMinutes` | 1440 (24 h) | tamanho da janela |
| `pageSize` | 100 | issues por página |
| `maxPages` | 50 | teto de páginas por execução |
| `dryRun` | false | só o diff, sem escrever |

Resposta:

```json
{
  "ok": true,
  "planId": "c0ecce95-1107-4343-8c05-bcf7c9a291f8",
  "window": { "lookbackMinutes": 1440, "since": "2026-10-28T12:23:11.580Z" },
  "pages": 2,
  "processed": 107,
  "created": 0,
  "updated": 1,
  "unchanged": 106,
  "skipped": 0,
  "errors": [],
  "durationMs": 2492
}
```

### `POST /api/gitlab-planner-premium-timer`

Roda o mesmo sync com a janela do timer (60 min). Existe para **rodar na
hora** e para **confirmar o comportamento depois do deploy**, sem esperar o
próximo disparo.

### `app.timer` — `syncGitLabPlannerPremiumTimer`

Dispara sozinho a cada 30 min. Configurável por app setting:

| App setting | Padrão | O que faz |
|---|---|---|
| `PREMIUM_TIMER_INTERVAL_MINUTES` | 30 | intervalo entre disparos |
| `PREMIUM_TIMER_LOOKBACK_MINUTES` | 60 | janela lida em cada disparo |

---

## 4. A trava de execução

O sync **não é idempotente no momento da criação**: duas execuções
simultâneas podem ver a mesma issue sem mapping e criar **duas** tasks (o
mapping só é gravado depois que a task materializa).

Com o timer rodando sozinho isso era raro. Com timer + execução manual, a
colisão deixa de ser hipotética. A trava é um blob de nome fixo
(`premium-sync-lock.json`, container `service-tokens`):

- criar o blob é atômico — o primeiro a criar ganha;
- o blob carrega o instante de expiração (TTL de 10 min) — se o processo
  morrer no meio, a trava expira e a próxima execução assume;
- quando outro sync está em andamento, a resposta é **409** com
  `skipped: true`, e **nada** é tocado no Planner.

---

## 5. O que a varredura incremental **não** cobre

Duas coisas seguem precisando da varredura completa, e é por isso que a rota
`/gitlab-planner-premium-homologacao` continua existindo:

1. **A fase de issues fechadas.** Ela varre **todas** as issues fechadas
   (89 no projeto), sem filtro de janela. É ela que leva a task a 100%. Uma
   issue fechada há três semanas está fora de qualquer janela de 24 h, mas a
   task dela ainda precisa ser completada.
2. **A carga inicial.** 811 issues pela primeira vez.

Recomendação de rotina: um disparo da rota **completa** por dia (de madrugada)
e os disparos de 30 min do timer cobrem o resto.

---

## 6. Validação em produção (29/10/2026)

Publicado na `func-gitintegracao` e verificado contra o GitLab e o Planner
reais:

| Verificação | Resultado |
|---|---|
| Rotas registradas no app | `syncGitLabPlannerPremiumChanges`, `syncGitLabPlannerPremiumTimer`, `syncGitLabPlannerPremiumTimerHttp` |
| Agendamento do timer | `*/30 * * * *` (a cada 30 min) |
| Disparo real do timer | `Last=2026-10-29T13:00:00Z`, `Next=13:30:00Z` — disparou no horário |
| O que o timer fez | detectou a issue #762 (alterada no GitLab às 12:49) e atualizou a task no Planner às 13:00:09 |
| Task após o disparo | assunto e progresso conferem com o GitLab ✅ |
| Idempotência | segundo sync imediato: `criadas 0, atualizadas 0, iguais 21` |
| Trava | dois syncs simultâneos: um 200, o outro **409** `trava em uso por sync` |
| Sync real | 1 issue atualizada, **0 erros** |
| Varredura completa × incremental | **mesmas 87 issues** alteradas (811 → 107 issues, 87% menos) |

Comparação entre a varredura completa e a incremental, no mesmo instante, com
as mesmas regras do sync (filtro de label de cancelamento):

```
COMPLETA   → elegíveis: 811 | MUDADAS: 87
INCREMENTAL→ elegíveis: 107 | MUDADAS: 87
SÓ na completa (perdidas pela incremental): (nenhuma)
SÓ na incremental (falsas): (nenhuma)
ACORDO EXATO: SIM ✅
```

Redução: 811 → 107 issues (87% menos), 12,5 s → 2,5 s.

> **Nota sobre o `az`:** o token do CLI estava vencido (`AADSTS70043`) e foi
> renovado no meio da sessão. O `func azure functionapp publish` do Core Tools
> funciona mesmo com o `az` vencido — ele usa credencial própria.

---

## 7. Correções de bug feitas junto

### 7.1 Update não confirmado não pode avançar o mapping

**Bug:** quando uma task não materializava dentro do prazo, o sync registrava
o erro — **mas gravava o mapping mesmo assim**, avançando o
`pmo_gitlab_updatedat` para o `updated_at` da issue.

**Consequência:** na rodada seguinte, o diff via `issue.updated_at` contra
`mapping.pmo_gitlab_updatedat` veria a issue como **"não mudou"**. O update
perdecido **nunca mais seria tentado** — a falha virava permanente e
silenciosa. O Planner ficaria com conteúdo desatualizado sem nenhum sinal.

**Correção:** o mapping só é gravado quando a task foi **confirmada** no
Planner (`premiumSync.js`, bloco `semTask`). O erro continua sendo reportado
em `errors[]`.

> Foi esse bug que produziu a issue #802 com assunto divergente no plano.

### 7.2 O lote de update ignorava o timeout injetado

O `applyBatch` do modo `update` não recebia `materializeTimeoutMs` /
`materializeDelayMs` — só o modo `create` recebia. O tempo de espera ficava
sempre no padrão de 120 s, sem forma de ajustar em teste ou em produção.

---

## 8. Como rodar

```bash
# Dry run da varredura incremental (não escreve nada)
curl -s -X POST \
  -H "Content-Type: application/json" \
  -H "x-functions-key: $FUNCTION_KEY" \
  -d '{"dryRun":true,"lookbackMinutes":1440}' \
  "https://func-gitintegracao-febwfvfnbwchbbhb.brazilsouth-01.azurewebsites.net/api/gitlab-planner-premium-changes" \
  | python3 -m json.tool

# Dispara o sync do timer na hora
curl -s -X POST \
  -H "Content-Type: application/json" \
  -H "x-functions-key: $FUNCTION_KEY" \
  "https://func-gitintegracao-febwfvfnbwchbbhb.brazilsouth-01.azurewebsites.net/api/gitlab-planner-premium-timer" \
  | python3 -m json.tool
```

---

## 9. Referência

| Arquivo | Papel |
|---|---|
| `src/functions/gitlab-planner-sync/premiumChangeDetector.js` | janela + diff por issue |
| `src/functions/gitlab-planner-sync/premiumSyncRunner.js` | percorre as páginas até o fim |
| `src/functions/gitlab-planner-sync/premiumChangesHandler.js` | rota incremental (com trava) |
| `src/functions/gitlab-planner-sync/premiumSyncLock.js` | trava de execução |
| `src/functions/gitlab-planner-sync/syncGitLabPlannerPremiumChanges.js` | rota HTTP da detecção |
| `src/functions/gitlab-planner-sync/syncGitLabPlannerPremiumTimer.js` | timer + rota de disparo manual |
