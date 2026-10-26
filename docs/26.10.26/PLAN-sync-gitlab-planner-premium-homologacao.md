# PLAN — Sincronização GitLab → Planner Premium (plano "Homologação _NOVO SISTEC 2 - Cópia")

> Data: 26/10/2026 · Status: **PLANO — aguardando aprovação** · Autor: Claude (a partir do pedido do usuário)
> Repo: `MEC_gitintegracao` (Azure Functions v4, Node 22, plano de hospedagem Consumption/Y1)

---

## 1. Objetivo

Criar uma nova Azure Function que será **chamada pelo Power Automate** e que:

1. consulta as issues do projeto GitLab **510** (`doc-sis/documentacao-novosistec2`);
2. compara cada issue com o Planner Premium de destino;
3. se a issue **já tem task** no Planner e **mudou no GitLab** → atualiza a task;
4. se a issue **não tem task** no Planner → cria a task;
5. **não** sincroniza comentários;
6. escreve no Planner usando a conta **portaldedemandas@mec.gov.br**.

Plano de destino (o que o usuário informou):

```
https://planner.cloud.microsoft/ui/web/premiumplan/c385351a-e450-4d54-87ed-d54c57794f7b/org/19cb737b-42fe-4f35-b875-6d1e96344cd3?tid=b8c25932-5e76-4b2b-9c53-d41745e9c92d
```

---

## 2. Fatos verificados no ambiente (26/10/2026)

Tudo abaixo foi checado por API nesta sessão, não veio de memória.

### 2.1 GitLab

| Item | Valor |
|---|---|
| Host | `https://gitlabbuilder.mec.gov.br` (self-hosted, Cloudflare) |
| Projeto | `510` = `doc-sis/documentacao-novosistec2` (path id 510 confirmado) |
| Issues **abertas** | **722** (`x-total: 722`) |
| Issues **fechadas** | **89** |
| IID mais recente | 811 |
| Labels existem | `HU cancelada`, `CANCELADAS`, `Em análise`, `DESENVOLVIMENTO`, `Em teste`, `HU homologada`, `Aprovada no teste`, `BACKLOG DA SPRINT`, `Doing`, `FEITO`, … (100+ labels) |
| Token usado | `glpat-…` (PAT, `PRIVATE-TOKEN`), funciona; API de **hooks** retorna 403 (token sem permissão de administer) |

### 2.2 Planner Premium de destino

| Item | Valor |
|---|---|
| Plano (msdyn_project) | `c385351a-e450-4d54-87ed-d54c57794f7b` |
| Nome | **"Homologação _NOVO SISTEC 2 - Cópia"** |
| Org | **Default (Ministério da Educação)** → `https://orgcf194dda.crm.dynamics.com` (organizationid `19cb737b-42fe-4f35-b875-6d1e96344cd3` = o `/org/` do link do Planner) |
| Tasks existentes | **711** (todas em `Bucket 1`, criada em 02/10/2026 = cópia do plano "AutomaçãoTestes" `4603e73f-…`) |
| Buckets | **1 só** — `Bucket 1` = `f704c207-84be-f111-a04d-7c1e520d9f67` (todas as 711 tasks apontam pra ele) |
| Títulos das 711 tasks | **sem** prefixo `[#iid]` (ex.: `AUTENTICAÇÃO DO USUÁRIO`) → são tasks do cliente, **não** vêm do GitLab |

> ⚠️ Consequência: na primeira execução **as 722 issues abertas do GitLab viram 722 tasks novas** neste plano. As 711 tasks do cliente são intocadas (não têm mapping). Confirmar o escopo com o cliente antes de rodar (ver §7).

### 2.3 Identidades e licenças (org Default)

| Identidade | Como entra | islicensed | accessmode | Pode escrever `msdyn_projecttask`? |
|---|---|---|---|---|
| `app-pnld` (18fb3c07, client credentials) | app user `f7f674d4-acb3-f111-aaac-000d3a13078c` | **false** | 4 (Não interativo) | ❌ **não** (UserNotLicensed) |
| `portaldedemandas@mec.gov.br` | systemuser `efc0454c-66a9-ec11-983f-000d3a178dce` | **true** | 0 (Leitura/Escrita) | ✅ **sim** (é o caminho pedido) |
| `antoniojunior@mec.gov.br` | usuário humano | — | — | ✅ tem licença ModernProject (usado pelo flow PA atual) |

- `app-pnld` **ler** na org Default funciona (o 403 anotado na memória de 18/09 já não vale mais).
- **Só** `portaldedemandas` (delegada) ou `antoniojunior` (delegada) escrevem task Premium.

### 2.4 Ações Premium disponíveis na org Default (confirmadas no `$metadata`)

| Action | Parâmetros |
|---|---|
| `msdyn_CreateOperationSetV1` | `ProjectId (Edm.String)`, `Description (Edm.String)` |
| `msdyn_PssCreateV1` | `Entity (crmbaseentity)`, `OperationSetId (Edm.String)` |
| `msdyn_PssCreateV2` | `EntityCollection`, `OperationSetId` ← **lote** |
| `msdyn_PssUpdateV1` | `Entity`, `OperationSetId` |
| `msdyn_PssUpdateV2` / `msdyn_PssUpdateBulkV1` | `EntityCollection`, `OperationSetId` ← **lote** |
| `msdyn_ExecuteOperationSetV1` | `OperationSetId (Edm.String)` |

Não existe POST direto em `msdyn_projecttask` (bloqueado pelo Dataverse) — escrita **sempre** via operation set.
Campos da task nesta org: `msdyn_subject`, `msdyn_description`, `msdyn_start`, `msdyn_finish`, `msdyn_progress` (percentual), `msdyn_project` (lookup), `msdyn_projectbucket` (lookup). **Não existe** `msdyn_percentcomplete` aqui (a lógica do handler Premium antigo usou o nome do outro schema).

### 2.5 Tabela de mapeamento

- `pmo_mapeamentoplanner` existe **só no Aplicativos PRD** (`org41ecace2`), **não** na org Default. 763 linhas, todas do plano clássico `hIjg2ZZaY0mWB5gpuJFMZmUABFNv`.
- Colunas úteis: `pmo_gitlab_iid` (Integer), `pmo_plannerplanid` (String 100), `pmo_plannertaskid` (String 100), `pmo_plannerbucketid`, `pmo_title`, `pmo_issue_labels`, `pmo_dataultimasincronizacao` (DateTime), `pmo_statussincronizacao`, `pmo_description`, `pmo_projeto_id` (lookup), `pmo_pwataskuid`/`pmo_pwaprouid` (não usados).
- **Falta** coluna para o `updated_at` do GitLab (detecção de mudança) → precisa criar.
- `getMapping()` hoje filtra **só por iid** → colide com os 763 mappings do plano clássico. Precisa ficar *plan-scoped*.

### 2.6 Código e infraestrutura já existentes (reaproveitáveis)

- `src/functions/gitlab-planner-sync/gitlabService.js` — cliente GitLab, `listIssues`, `getBoardLists`, `normalizeLabel`, `mapLabelToBucket`.
- `src/functions/gitlab-planner-sync/tableStorage.js` — client Dataverse (client credentials) + CRUD de `pmo_mapeamentoplanner`.
- `src/functions/gitlab-planner-sync/syncGitLabPlanner.js` — sync **Clássico** (Graph API): tem `buildDescription`, `createPlannerTask`, `updatePlannerTask`, `handleDryRun`, paginação. Boa referência de *shape*, mas usa Graph (plano clássico) — não serve para Premium.
- `src/functions/gitlab-planner-sync/syncGitLabPlannerPremium.js` — handler Premium que **chama o Power Automate** (trigger `POWER_AUTOMATE_PREMIUM_URL` já configurada no Function App). Aponta para o plano `8ebc738c` (Aplicativos PRD) — **não** é o plano-alvo deste pedido.
- **Padrão de identidade de conta de serviço já validado no projeto irmão** `spfx_mec-main/azure-functions`: device code flow → refresh token no Blob Storage → access token delegado. Exatamente o mecanismo necessário para o `portaldedemandas` escrever no Dataverse.
- Function App: `func-gitintegracao` (rg `rg-pnld-app-hmg-mec`), Consumption **Y1**, Node 22, `alwaysOn=false`.
  ⚠️ Consumption → **resposta HTTP máx 230 s**. 722 tasks não cabem com folga numa chamada só → o endpoint será **paginado por cursor** e o flow PA itera.

---

## 3. Decisões de arquitetura

### 3.1 Identidade: como a Function vira o `portaldedemandas`

**Escolhido — device code flow + refresh token no Blob Storage** (mesmo padrão do projeto irmão):

1. Script de uso único `scripts/autorizarContaServicoPremium.js` roda local, imprime URL + código;
2. alguém loga no navegador com `portaldedemandas@mec.gov.br` (senha + MFA);
3. o refresh token resultante é gravado no Blob `service-tokens/premium-dataverse-refresh-token.json` (Storage Account `rgpnldapphmgmeca8a8`, mesma do projeto irmão);
4. em runtime, `src/shared/dataverseServiceAccountAuth.js` troca o refresh token por **access token delegado** para a org Default
   (scope `https://orgcf194dda.crm.dynamics.com/user_impersonation offline_access`, client público `18fb3c07`, **sem** `client_secret` — o Graph rejeita segredo em RT de cliente público, o mesmo vale para o Dataverse);
5. rotação: cada troca devolve RT novo → salvar sempre o mais recente.

**Por que não as alternativas:**

| Alternativa | Motivo da recusa |
|---|---|
| `app-pnld` (client credentials) | `islicensed=false` → `UserNotLicensed` em escrita Premium (já visto no Aplicativos PRD) |
| ROPC (usuário/senha) | senha de conta de serviço em app setting + não passa por MFA/CA; device code é mais seguro e já é padrão do time |
| O Function App chamar o flow PA (como o handler Premium antigo faz) | cria ciclo PA→Function→PA e a licença vem do dono da conexão do flow, não da conta pedida |

**Fallback (só se a conta não tiver licença ModernProject na org Default):** usar `antoniojunior@mec.gov.br` (licença ModernProject confirmada). Decide-se após o smoke test da T0 — não assumo.

### 3.2 Escrita no Planner: operation sets em lote

Fluxo por lote de N tasks:

```
POST msdyn_CreateOperationSetV1 { ProjectId, Description }
  → OperationSetId
POST msdyn_PssCreateV2 { EntityCollection: [...], OperationSetId }   // ou PssUpdateV2 / PssUpdateBulkV1
POST msdyn_ExecuteOperationSetV1 { OperationSetId }
DELETE msdyn_operationsets(OperationSetId)   // descarta o set (cota de 10 sets/usuário)
```

- **Lote = 100 tasks** (PssCreateV2). 722 tasks ⇒ 8 lotes; cada lote nasce, executa e é descartado, então a cota de 10 operationsets por usuário nunca é ultrapassada.
- Payload da task (`mscrm.crmbaseentity`):
  ```json
  {
    "msdyn_subject": "[#811] HU0xxx [Matrícula] - …",
    "msdyn_description": "…markdown da issue…",
    "msdyn_start": "2026-10-19T00:00:00Z",
    "msdyn_finish": "2026-10-26T00:00:00Z",
    "msdyn_progress": 0,
    "msdyn_project@odata.bind": "/msdyn_projects(c385351a-e450-4d54-87ed-d54c57794f7b)",
    "msdyn_projectbucket@odata.bind": "/msdyn_projectbuckets(f704c207-84be-f111-a04d-7c1e520d9f67)"
  }
  ```
- Update: `msdyn_PssUpdateV2` (ou `PssUpdateBulkV1`) com o mesmo shape + `msdyn_projecttaskid` da task.

### 3.3 Onde fica o mapping

Reusar `pmo_mapeamentoplanner` no **Aplicativos PRD** (é onde a solution PMOImportacao está instalada e onde o webhook já grava).

- `pmo_plannerplanid` = `c385351a-e450-4d54-87ed-d54c57794f7b` (distingue do clássico `hIjg2ZZaY0mWB5gpuJFMZmUABFNv`).
- `pmo_plannertaskid` = GUID da task Premium (vira String, cabe em 100).
- `pmo_plannerbucketid` = `f704c207-…`.
- **Nova coluna `pmo_gitlab_updatedat` (DateTime)** — guarda o `updated_at` do GitLab visto no último sync. Criar via Web API (o `app-pnld` é System Admin no Aplicativos PRD).
  *Alternativa sem mexer no schema*: gravar o `updated_at` do GitLab em `pmo_dataultimasincronizacao` (o nome fica semântico errado). **Preferência: coluna nova**, com a alternativa como plano B.
- `tableStorage.js` ganha: `getMappingByPlan(planId, iid)`, `listMappingsByPlan(planId)`, e `saveMapping` passa a gravar `pmo_gitlab_updatedat` + plan-scoped.

### 3.4 Detecção de "teve update no GitLab"

```
mudou = issue.updated_at > mapping.pmo_gitlab_updatedat
```
- Sem mapping → **criar**.
- Com mapping e `pmo_gitlab_updatedat` vazio (primeira execução em plano novo) → tratar como **atualizar** (idempotente).
- Com mapping e não mudou → `unchanged` (não toca na task).
- Issue fechada no GitLab → task vai para `msdyn_progress = 100` (e o mapping é atualizado). *(decisão §7.4)*

### 3.5 Escopo e segmentação

- Filtro default: `state=opened`, excluindo issues com label de cancelamento (`HU cancelada`, `CANCELADAS`, `cancelada` — a regra `SKIP_LABELS` já existe no `syncGitLabPlannerPremium.js` e será reaproveitada).
- **Paginação por cursor**: 1 chamada = 1 lote de `pageSize` (default 100) issues → response traz `nextCursor`; o flow PA repete até `nextCursor = null`.
  Motivo: Consumption/Y1 corta a resposta HTTP em 230 s.
- `dryRun: true` → não escreve nada, só devolve o diff (criar/atualizar/ignorar) — mesmo formato do `handleDryRun` do sync clássico.

### 3.6 O que NÃO entra

- Comentários (pedido explícito) — a descrição da task é montada sem a seção de comentários.
- As 711 tasks do cliente (sem mapping) — não são lidas para escrita, nem alteradas.
- Assignments/prioridade: o Premium não expõe o mesmo modelo do Graph; ficam fora do v1 (só assunto, descrição, datas, progresso, bucket).

---

## 4. Contrato da API

```
POST https://func-gitintegracao-febwfvfnbwchbbhb.brazilsouth-01.azurewebsites.net/api/gitlab-planner-premium-sync?code=<FUNCTION_KEY>
Content-Type: application/json
```

Request:

```json
{
  "planId": "c385351a-e450-4d54-87ed-d54c57794f7b",
  "cursor": null,
  "pageSize": 100,
  "state": "opened",
  "labels": null,
  "dryRun": false,
  "skipLabels": ["hu cancelada", "canceladas"]
}
```

Response 200:

```json
{
  "ok": true,
  "planId": "c385351a-e450-4d54-87ed-d54c57794f7b",
  "processed": 100,
  "created": 97,
  "updated": 2,
  "unchanged": 1,
  "skipped": 0,
  "errors": [],
  "nextCursor": "eyJpZCI6MTAwfQ",
  "durationMs": 18422
}
```

Erros por item não derrubam o lote: vão em `errors[]` com `iid` + mensagem; o batch segue.

---

## 5. Roteiro de implementação

| # | Tarefa | Arquivos | Depende de |
|---|---|---|---|
| **T0** | **Consentimento + smoke test** (usuário + eu) | `scripts/autorizarContaServicoPremium.js`, `src/shared/dataverseServiceAccountAuth.js` | — |
| T1 | Coluna `pmo_gitlab_updatedat` + helpers plan-scoped | `tableStorage.js`, script pontual de schema | — |
| T2 | Cliente Premium (operation sets) | `src/functions/gitlab-planner-sync/premiumDataverse.js` (novo) | T0 |
| T3 | Orquestração do diff | `src/functions/gitlab-planner-sync/premiumSync.js` (novo) | T1, T2 |
| T4 | Handler HTTP + rota | `src/functions/gitlab-planner-sync/syncGitLabPlannerPremiumHomologacao.js` (novo), `index.js` | T3 |
| T5 | Settings no Azure | `az functionapp config appsettings set` | T4 |
| T6 | Dry run (5 issues) + conferência do diff | — | T4, T5 |
| T7 | Sync real em lotes + verificação no Planner UI | — | T6 |
| T8 | Flow PA (loop de cursor) + doc/memória | docs + `MEMORY.md` | T7 |

**T0 (o passo que precisa de você):** rodar o device code flow e logar com `portaldedemandas@mec.gov.br`. Eu te entrego o script e o comando exato. Em seguida eu faço o smoke test: criar 1 task de teste no plano `c385351a` com o token delegado, verificar que ela aparece no Planner UI, e **deletar** a task de teste.

**Definição de pronto (T7):**
- as 722 issues abertas viraram task no plano `c385351a` (ou o subconjunto aprovado no §7.1);
- o contador de issues sem task volta a 0;
- reexecutar o sync não cria duplicata (idempotência);
- rodar de novo depois de editar uma issue no GitLab atualiza só aquela task.

---

## 6. Riscos

| Risco | Mitigação |
|---|---|
| Cota de 10 operation sets por usuário | 1 set por lote, descartado após executar; monitorar `msdyn_operationsets` |
| 230 s de timeout HTTP (Consumption) | paginação por cursor + loop no PA |
| 722 tasks de uma vez → plano poluído | §7.1 (escopo) + dry-run antes |
| Refresh token expira/revogado (≈90 dias, CA policy) | erro claro na response + re-rodar o script de autorização |
| `portaldedemandas` sem licença ModernProject na org Default | smoke test da T0 decide; fallback `antoniojunior@mec.gov.br` |
| Task criada mas não aparece no Planner UI (latência de replicação) | verificar no Dataverse (fonte da verdade) e no UI depois |
| Colisão de título com as 711 tasks do cliente | prefixo `[#iid]` no assunto + comparação só por mapping |

---

## 7. Decisões que preciso confirmar com você

> **Respostas (26/10/2026):** 1. sim · 2. sim · 3. sim · 4. "viremos criar um flow no
> Power Automate" (flow novo, depois). As perguntas 5–7 ficaram sem resposta →
> valem os defaults do plano: conta `portaldedemandas` (com fallback
> `antoniojunior`), bucket `Bucket 1`, mesma Function App.

1. **Escopo**: as **722** issues abertas entram todas? Ou filtra por label (ex.: só `BACKLOG DA SPRINT`, só `EM HOMOLOGAÇÃO`) ou por data (últimos 30 dias)? *Default do plano: todas as abertas, exceto canceladas.* → **sim, todas as abertas** (a dry run confirmou 134 canceladas fora).
2. **Assunto da task**: mantém o prefixo `[#iid]` (como o sync clássico faz, e como o `syncGitLabPlannerPremium.js` já envia ao PA) ou título puro? *Default: `[#iid] título`.*
3. **Datas**: `msdyn_start` = data de criação da issue; `msdyn_finish` = `due_date` (fallback: start + 7 dias)? Issue fechada → `msdyn_progress = 100`? *Default: sim.*
4. **Bucket**: o plano tem **1 só** (`Bucket 1`). Deixar tudo em `Bucket 1` ou criar buckets por status (Backlog / Em Desenvolvimento / Homologada…)? *Default: `Bucket 1`.*
5. **Conta**: você tem a senha/MFA do `portaldedemandas@mec.gov.br` para o device code flow da T0? Se essa conta não tiver licença ModernProject na org Default, autoriza eu usar `antoniojunior@mec.gov.br` como fallback?
6. **Flow PA**: é um **flow novo** (recomendado, isolado) ou adaptar o `IntegraçãoGitLab` que já existe (que hoje aponta para o plano `8ebc738c` do Aplicativos PRD)? *Default: flow novo, `IntegraçãoGitLabHomologacao`.*
7. **Escopo de código**: a nova Function fica **no mesmo Function App** (`func-gitintegracao`, com as outras rotas) ou em Function App nova? *Default: mesmo app, rota nova `gitlab-planner-premium-sync`.*

---

## 8. Arquivos involved

| Caminho | Ação |
|---|---|
| `src/functions/gitlab-planner-sync/syncGitLabPlannerPremiumHomologacao.js` | novo — handler HTTP |
| `src/functions/gitlab-planner-sync/premiumSync.js` | novo — orquestração GitLab→Planner |
| `src/functions/gitlab-planner-sync/premiumDataverse.js` | novo — operation sets (create/update/execute/discard) |
| `src/shared/dataverseServiceAccountAuth.js` | novo — token delegado do `portaldedemandas` (RT no Blob) |
| `src/functions/gitlab-planner-sync/tableStorage.js` | alterar — lookups plan-scoped + `pmo_gitlab_updatedat` |
| `src/functions/gitlab-planner-sync/gitlabService.js` | talvez alterar — paginação já existe |
| `src/functions/gitlab-planner-sync/index.js` | alterar — registrar o módulo novo |
| `scripts/autorizarContaServicoPremium.js` | novo — device code flow (uso único) |
| `scripts/diag-plano-homologacao-default.js` | já criado (diagnóstico desta sessão) |
| `scripts/diag-mapeamento-schema.js` | já criado (diagnóstico desta sessão) |

**Variáveis de ambiente novas (Function App):**

| Nome | Valor |
|---|---|
| `DATAVERSE_URL_PREMIUM` | `https://orgcf194dda.crm.dynamics.com` |
| `PLANNER_PREMIUM_PROJECT_ID` | `c385351a-e450-4d54-87ed-d54c57794f7b` |
| `PLANNER_PREMIUM_BUCKET_ID` | `f704c207-84be-f111-a04d-7c1e520d9f67` |
| `PREMIUM_SYNC_BLOB_CONTAINER` | `service-tokens` |
| `PREMIUM_SYNC_BLOB_NAME` | `premium-dataverse-refresh-token.json` |
| `AZURE_STORAGE_CONNECTION_STRING` | já existe no app (mesma Storage Account do projeto irmão) |

---

## 9. Fora do escopo (v2)

- Comentários / menções nas tasks.
- Assignments e prioridade (o Premium não tem o mesmo modelo do Graph).
- Deleção de tasks quando a issue é deletada no GitLab.
- Sincronização reversa (Planner → GitLab).
- Replicar o comportamento para o plano `8ebc738c` (Aplicativos PRD) — hoje o handler Premium existente aponta pra ele e fica como está.

---

## 10. Status da execução (26/10/2026)

Código pronto e testado; o que falta depende de ação humana.

**Implementado (commits `365c3ee` → `29fda1c`):**

| Item | Onde |
|---|---|
| Cliente Premium (operation sets) | `src/functions/gitlab-planner-sync/premiumDataverse.js` |
| Núcleo do sync (diff, payload, cursor) | `src/functions/gitlab-planner-sync/premiumSync.js` |
| Mapping plan-scoped + coluna `pmo_gitlab_updatedat` (com fallback) | `src/functions/gitlab-planner-sync/premiumMapping.js` |
| Handler (lógica pura) | `src/functions/gitlab-planner-sync/premiumHandler.js` |
| Rota HTTP | `src/functions/gitlab-planner-sync/syncGitLabPlannerPremiumHomologacao.js` |
| Device code flow (refresh token no Blob) | `scripts/autorizarContaServicoPremium.js` + `src/shared/dataverseServiceAccountAuth.js` |
| Blueprint do flow do Power Automate | `docs/26.10.26/PA-FLOW-sync-gitlab-planner-premium-homologacao.md` |

**Rota real (difere do §4 do plano):** `POST|GET /api/gitlab-planner-premium-homologacao`
(auth level `function`) e `GET /api/gitlab-planner-premium-homologacao-buckets`.

**Settings aplicadas na Function App** (`func-gitintegracao`, `rg-pnld-app-hmg-mec`,
subscription `ccmecapppnld13383hom`): `DATAVERSE_URL_PREMIUM`,
`PREMIUM_HOMOLOGACAO_PLAN_ID`, `PREMIUM_HOMOLOGACAO_BUCKET_ID`,
`PREMIUM_HOMOLOGACAO_BUCKET_NAME`, `PREMIUM_SYNC_BLOB_CONTAINER`,
`PREMIUM_SYNC_BLOB_NAME` (nomeseffective: `PREMIUM_HOMOLOGACAO_*`, não os
`PLANNER_PREMIUM_*` do §8).

**Dry run local (`func start`, 9 páginas, 12,2 s):** 811 issues lidas
(722 abertas + 89 fechadas) → **588 tasks a criar**, 0 atualizadas, 223 puladas
(134 canceladas + 89 fechadas sem task), 0 erros.

**Mudança de escopo do §3.5:** o cursor passou a ter fase (`opened` → `closed`).
Sem isso a regra "issue fechada → 100%" do §3.4 nunca dispararia, porque o
fetch era só `state=opened`. Na fase `closed` nada é criado e o filtro de label
de cancelamento não se aplica (task existente é completada assim mesmo).

**Pendências:**
1. Autorizar a conta de serviço (`node scripts/autorizarContaServicoPremium.js`).
2. Publicar o pacote na Function App (o deploy via ARM estava com
   `AuthorizationFailed` intermitente na conta do usuário).
3. Rodar a execução real e criar o flow do Power Automate.
