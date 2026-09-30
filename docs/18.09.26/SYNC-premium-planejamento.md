# Plano: Sync GitLab → Planner Premium (Project for the Web)

**Data:** 18/09/2026
**Status:** Pronto pra executar (esperando autorização)

---

## Contexto

O cliente passou o Plano `4603e73f-637a-453a-aedf-51051ac963f9` ("AutomaçãoTestes") que é **Planner Premium** (Project for the Web / Project Operations), mas o webhook atual `syncGitLabPlanner.js` foi feito **só pra Planner Classic** via Graph API (`/planner/tasks`). Os dois backends não conversam entre si.

Em 18/09/2026, Antônio instalou **Microsoft Project Service Core** no ambiente **Aplicativos PRD** (`org41ecace2`), que ganhou `msdyn_project`, `msdyn_projecttask` e `msdyn_projectbucket`. O App User (`18fb3c07-…`) já tinha role **Administrador do Sistema** lá (systemuserid `837e9242-c502-f111-8407-00224836c197`). Decisão: **recriar o Plano Premium do zero no Aplicativos PRD** (sem migração de dados do Default, porque o plano Premium no Default nunca recebeu sync do GitLab).

Resultado: 1 ambiente só, com Project Operations + tabela custom `pmo_mapeamentoplanner`, e webhook passa a ter dois caminhos (Classic + Premium).

---

## Fase 1 — Setup do plano Premium novo no Aplicativos PRD

**Objetivo:** Criar `msdyn_project` "AutomaçãoTestes" + buckets a partir dos labels do GitLab.

### 1.1 Criar `msdyn_project` no Aplicativos PRD
- **API:** `POST /api/data/v9.2/msdyn_projects`
- **Body mínimo:**
  ```json
  {
    "msdyn_subject": "AutomaçãoTestes",
    "msdyn_scheduledstart": "<hoje ISO>",
    "msdyn_scheduledend": "<+90 dias ISO>",
    "msdyn_projectstatus": 1
  }
  ```
- **Validar:** `GET /msdyn_projects(<new_id>)?$select=msdyn_projectid,msdyn_subject` retorna o registro criado.
- **Guardar:** novo GUID do plano Premium → variável de ambiente `PLANNER_PLAN_ID_PREMIUM`.

### 1.2 Criar buckets baseados em labels do GitLab
- **Origem:** labels do GitLab `doc-sis/documentacao-novosistec2` (`Plano Premium`, `EM1`, `EM2`, …).
- **API:** `POST /api/data/v9.2/msdyn_projectbuckets`
- **Body:**
  ```json
  {
    "msdyn_projectid@odata.bind": "/msdyn_projects(<new_id>)",
    "msdyn_name": "<label>",
    "msdyn_order": 1
  }
  ```
- **Mapeamento label → bucket:** persistir na tabela `pmo_mapeamentoplanner` em um campo dedicado (a criar — `pmo_labelbucketmap`) ou em memória no startup da function.

**Verificação:** `GET /msdyn_projectbuckets?$filter=_msdyn_projectid_value eq <new_id>` retorna 1 bucket por label.

---

## Fase 2 — Smoke test do destino

### 2.1 Validar `POST /msdyn_projecttasks`
- Criar 1 task de teste (não persiste dados reais).
- **Body mínimo:**
  ```json
  {
    "msdyn_project@odata.bind": "/msdyn_projects(<new_id>)",
    "msdyn_projectbucket@odata.bind": "/msdyn_projectbuckets(<bucket_id>)",
    "msdyn_subject": "SMOKE-TEST-premium-sync"
  }
  ```
- **Validar:** retorno 201 + ID. Em seguida, `DELETE` (task de teste).

### 2.2 Validar Graph API / Dataverse / GitLab ainda funcionam
- Reusar `healthCheck.js` que existe em [`src/functions/gitlab-planner-sync/healthCheck.js`](src/functions/gitlab-planner-sync/healthCheck.js).
- Adicionar campo `dataverse_premium.ok` retornando `true` se a chamada `GET /msdyn_projects?$top=1` passar.

**Verificação:** `curl /api/health` retorna `{ planner_ok: true, dataverse_ok: true, dataverse_premium_ok: true, gitlab_ok: true }`.

---

## Fase 3 — Adaptar o webhook

### 3.1 Criar `src/functions/gitlab-planner-sync/syncGitLabPlannerPremium.js`
- **Espelho de** [`syncGitLabPlanner.js`](src/functions/gitlab-planner-sync/syncGitLabPlanner.js), mas trocando Graph por OData.
- **Funções novas:**
  - `createPremiumTask(issue, projectId, bucketId)` — `POST /msdyn_projecttasks`
  - `updatePremiumTask(taskId, issue, projectId, bucketId)` — `PATCH /msdyn_projecttasks(<id>)`
  - `syncPremiumIssueComments(taskId, comments)` — `POST /msdyn_projecttaskcomments` (?)
  - `buildPremiumDescription(issue, comments)` — espelho de `buildDescription()` na linha 365 do arquivo atual
- **Reusar:** `gitlabService.js`, `tableStorage.js` (com `saveMapping()` adaptado pra `pmo_plannerprojectid` em vez de `pmo_plannertaskid`).

### 3.2 Adicionar função de roteamento
- Modificar `index.js` pra detectar `planType` (lê de env var `PLANNER_PLAN_TYPE` ou do header do webhook).
- **Heurística inicial:** se `planId === PLANNER_PLAN_ID_PREMIUM` → chama `syncGitLabPlannerPremium`; senão → `syncGitLabPlanner` (Classic).
- **Backward compatibility:** mantém Classic 100% inalterado. Premium é caminho novo.

### 3.3 Atualizar `tableStorage.js`
- Adicionar `saveMappingPremium({ gitLabIssueId, gitLabProjectId, projectId, taskId, bucketId })` que grava:
  - `pmo_gitlabissueid` (já existe)
  - `pmo_gitlabprojectid` (já existe)
  - `pmo_plannerprojectid` (campo NOVO — adicionar à tabela)
  - `pmo_plannerbucketid` (campo NOVO)
  - `pmo_plannerprojecttaskid` (campo NOVO — espelha `pmo_plannertaskid` mas pra Premium)
- **Adicionar campos na entidade** `pmo_mapeamentoplanner` via `POST /pmo_mapeamentoplanner` com `@odata.bind` no schema OU via Admin Center (caminho manual se API recusar).

### 3.4 Variáveis de ambiente novas
| Var | Valor | Onde |
|---|---|---|
| `PLANNER_PLAN_ID_PREMIUM` | `<novo GUID da Fase 1.1>` | `local.settings.json` + Azure |
| `DATAVERSE_URL_PREMIUM` | `https://org41ecace2.crm2.dynamics.com` | mesmo URL (só pra clareza) |

**Verificação:** rodar um POST manual na Function App com payload de teste — vê qual handler foi escolhido pelo roteamento.

---

## Fase 4 — Sincronização inicial

### 4.1 Rodar batch das issues do GitLab filtradas por label "Plano Premium"
- **Script:** `scripts/sync-premium-batch.js` (criar).
- **Lógica:**
  1. `gitlabService.listIssues({ labels: ['Plano Premium'], state: 'all' })` — pega só issues com esse label.
  2. Para cada issue:
     - Lê `pmo_mapeamentoplanner` por `pmo_gitlabissueid`.
     - Se **existe mapping** e Premium: `PATCH /msdyn_projecttasks(<id>)`.
     - Se **não existe**: `POST /msdyn_projecttasks` + `saveMappingPremium()`.
- **Modo dry-run primeiro** (script aceita flag `--dry-run`).

### 4.2 Validar com 5 tasks antes de subir
- Marcar 5 issues específicas do GitLab com label `Plano Premium`.
- Rodar batch.
- Conferir visualmente no Planner UI do Aplicativos PRD.
- Se OK, rodar batch completo.

**Verificação:** `GET /msdyn_projecttasks?$filter=_msdyn_projectid_value eq <new_id>&$count=true` retorna ~35 (esperado).

---

## Fase 5 — Cleanup e handoff

### 5.1 Deletar 71 tasks Classic órfãs
- **Origem:** webhook de 18/09 criou 71 tasks Classic no plano errado (`hIjg2ZZaY0mWB5gpuJFMZmUABFNv`).
- **API:** script que lê `pmo_mapeamentoplanner` com `pmo_plannertaskid IS NOT NULL` e chama `DELETE /planner/tasks/<id>`.
- **Autorização:** Antônio já sinalizou que pode limpar.

### 5.2 Atualizar `local.settings.json`
- Adicionar `PLANNER_PLAN_ID_PREMIUM`.
- Manter `PLANNER_PLAN_ID` apontando pro Classic (para não quebrar nada).
- Adicionar comentário explicando que o código roteia por comparação.

### 5.3 Atualizar documentação
- [`GITLAB_PLANNER_SYNC.md`](GITLAB_PLANNER_SYNC.md): adicionar seção "Premium sync (Project for the Web)".
- [`RETOMADA-pos-reinicio.md`](docs/18.09.26/RETOMADA-pos-reinicio.md): adicionar linha no topo "Migração Premium concluída em DD/MM — ver [novo arquivo]".
- Criar `docs/18.09.26/SYNC-premium-finalizado.md` com: novo GUID do plano, contagem de tasks sincronizadas, decisões tomadas, plano Premium antigo no Default vira órfão (cliente deleta manualmente).

### 5.4 Plano Premium antigo no Default
- **Status:** órfão. Cliente pode deletar manualmente via Planner UI (selecionar plano → Excluir).
- **Não vou deletar sozinho** — operação irreversível fora do meu escopo.

---

## Riscos conhecidos

| Risco | Mitigação |
|---|---|
| Plano Premium novo tem GUID diferente do antigo. Bookmarks do cliente quebram. | Comunicar pro cliente ANTES de começar Fase 4. |
| App registration não tem permissão no Default (`orgcf194dda`). Default ainda tem Plano Premium `4603e73f-…` lá. | Default fica intocado. Webhook não lê nem escreve lá. |
| Webhook duplica tasks se rodar 2x (idempotência). | Reusar `pmo_mapeamentoplanner` como dedupe key (`pmo_gitlabissueid` é unique). |
| Project Operations Dataverse limita `pmo_description` a 2000 chars (já documentado em [`PLAN-sync-gitlab-planner-dataverse.md:197`](docs/18.09.26/PLAN-sync-gitlab-planner-dataverse.md#L197)). | Truncar antes de salvar (mesma lógica do Classic atual). |
| Bucket "Plano Premium" pode ter ordem diferente no GitLab vs Planner. | Ordenar buckets por ordem alfabética na criação. |
| `msdyn_projecttaskcomments` pode não existir (verificar Phase 1). | Se não existir, comentar no description (como Classic). |

---

## Arquivos a modificar

| Arquivo | Mudança |
|---|---|
| `src/functions/gitlab-planner-sync/syncGitLabPlannerPremium.js` | **CRIAR** (espelho Premium) |
| `src/functions/gitlab-planner-sync/index.js` | Adicionar roteamento planType |
| `src/functions/gitlab-planner-sync/tableStorage.js` | Adicionar `saveMappingPremium()` + leitura do novo campo |
| `src/functions/gitlab-planner-sync/healthCheck.js` | Adicionar `dataverse_premium.ok` |
| `src/functions/gitlab-planner-sync/local.settings.json` | Adicionar `PLANNER_PLAN_ID_PREMIUM` |
| `src/functions/gitlab-planner-sync/scripts/sync-premium-batch.js` | **CRIAR** (script de sincronização inicial) |
| `GITLAB_PLANNER_SYNC.md` | Seção "Premium sync" |
| `docs/18.09.26/RETOMADA-pos-reinicio.md` | Adicionar nota de migração concluída |
| `docs/18.09.26/SYNC-premium-finalizado.md` | **CRIAR** (handoff final) |

## Arquivos a NÃO modificar

| Arquivo | Por quê |
|---|---|
| `src/functions/gitlab-planner-sync/syncGitLabPlanner.js` | Lógica Classic continua intacta |
| `src/functions/gitlab-planner-sync/gitlabService.js` | Reusado por ambos os handlers |
| 71 mappings Classic órfãos em `pmo_mapeamentoplanner` | Deletados em massa na Fase 5.1 |

---

## Critérios de sucesso

1. ✅ Plano Premium novo existe no Aplicativos PRD (`msdyn_project`)
2. ✅ Webhook roteia corretamente: Classic → Graph, Premium → OData
3. ✅ Batch inicial cria ~35 tasks no novo plano Premium (mesmo número que o cliente tinha manualmente)
4. ✅ `/api/health` retorna `dataverse_premium.ok: true`
5. ✅ 71 tasks Classic órfãs deletadas
6. ✅ Documentação atualizada com novo GUID e link pro Premium UI
