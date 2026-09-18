# PLAN — Sync GitLab ↔ Planner Premium ↔ Dataverse

**Data:** 2026-09-18
**Autor:** Antonio Junior + Claude
**Repositório:** `/Users/antoniojunior/Dev/projetos_spfx/MEC_gitintegracao`
**Function app:** `func-gitintegracao` (Azure Functions Node v4, RG `rg-pnld-app-hmg-mec`)
**Plano Planner:** AutomaçãoTestes (`4603e73f-637a-453a-aedf-51051ac963f9`)
**Projeto GitLab:** `doc-sis/documentacao-novosistec2` (id=510) — `gitlabbuilder.mec.gov.br`
**Tabela Dataverse:** `pmo_mapeamentoplanner` em `https://org41ecace2.crm2.dynamics.com`

---

## Contexto

O plano `local.settings.json` aponta pra `V6eQb5zdBkWHqIzlDh68o2UACro8` ("Automação de Projetos"), que **não é mais o plano em uso**. O plano real é o **AutomaçãoTestes** (`4603e73f-…`), que contém 35 tasks com hierarquia WBS (1, 1.1, 1.2.1.1.1, etc.) e cujas hierarquias correspondem **direto** aos iids das issues do GitLab (ex: issue `#424` ↔ tarefa `1.2.1.2.4 Manter Áreas Tecnológicas`).

Estado anterior (17/09): plano errado zerado (722 tasks deletadas), 100 mappings no Dataverse órfãos apontando pra task IDs inexistentes.

## Objetivo

Sincronização **automática via webhook GitLab** garantindo:

1. Toda issue aberta/atualizada/reaberta no GitLab → **task correspondente no Planner Premium**
2. Verificação de existência antes de criar (sem duplicatas)
3. Atualização ou criação refletida na tabela `pmo_mapeamentoplanner` do Dataverse com **todos** os campos preenchidos para auditoria

---

## Decisões fechadas

| # | Decisão |
|---|---|
| 1 | Trigger = webhook GitLab |
| 2 | Corrigir `PLANNER_PLAN_ID` no `local.settings.json` |
| 3 | Plano de destino = AutomaçãoTestes (`4603e73f-…`), estrutura hierárquica WBS existente |
| 4 | Tasks novas entram como **folhas** sob a estrutura existente; bucket padrão = **Backlog** |
| 5 | `pmo_description` no Dataverse = **Área de texto** (sem limite prático); truncate em **10000 chars** antes do Planner |
| 6 | Issue fechada no GitLab → task no Planner com **% concluída = 100%** |
| 7 | Deletar os 100 mappings antigos (órfãos) e popular do zero |
| 8 | Rotacionar `AZURE_CLIENT_SECRET` antes de começar |
| 9 | Sincronizar **todas** as issues (abertas e fechadas) |

---

## Estrutura do plano

### Fase 0 — Pré-requisitos (bloqueia tudo)

- [ ] **0.1** Rotacionar `AZURE_CLIENT_SECRET` no Azure (app `18fb3c07-66df-40a0-86d6-5d2d84dea60f`) e atualizar `local.settings.json`
- [ ] **0.2** Corrigir `PLANNER_PLAN_ID` no `local.settings.json`:
  - de: `V6eQb5zdBkWHqIzlDh68o2UACro8`
  - para: `4603e73f-637a-453a-aedf-51051ac963f9`
- [ ] **0.3** Validar que `dryRun=true` na function retorna 200 (sem 401)
- [ ] **0.4** Confirmar acesso de leitura/escrita em `pmo_mapeamentoplanner`

### Fase 1 — Limpeza do estado velho

- [ ] **1.1** **Deletar os 100 mappings antigos** (órfãos) via API Dataverse:
  - Listar: `GET /pmo_mapeamentoplanners?$filter=pmo_plannerplanid eq 'V6eQb5zdBkWHqIzlDh68o2UACro8'`
  - DELETE em batch ($batch endpoint, máx 50 por request)
- [ ] **1.2** Validar: `count(pmo_mapeamentoplanner) == 0`
- [ ] **1.3** Decisão sobre as 35 tasks já existentes no Plano Premium: **manter** (todas têm iid válido do GitLab, representam a WBS do projeto)

### Fase 2 — Mudanças no código

#### 2.1 Novo módulo: `dataverseMapeamento.js`

Localização: `src/functions/gitlab-planner-sync/dataverseMapeamento.js`

Exporta:
- `getMappingByGitLabIid(iid)` → `{ pmo_mapeamentoplannerid, pmo_pwataskuid, pmo_gitlab_id, ... }` ou `null`
- `upsertMapping(payload)`:
  - se mapping existe por `pmo_gitlab_id` → PATCH
  - senão → POST

**Payload completo a gravar:**
```js
{
  pmo_gitlab_id: iid,
  pmo_title: issue.title,
  pmo_description: issue.description || '',  // sem truncate (Área de texto)
  pmo_issue_labels: labels.join(','),
  pmo_gitlab_url: issue.web_url,
  pmo_plannerplanid: PLANNER_PLAN_ID,
  pmo_plannerbucketid: bucketId,
  pmo_pwaprouid: planUid,
  pmo_pwataskuid: taskId,
  pmo_projeto_id: projetoLookup,           // se aplicável
  pmo_datacriacao: issue.created_at,        // só data
  pmo_dataultimasincronizacao: now(),
  pmo_statussincronizacao: action,         // 'criado' | 'atualizado' | 'fechado' | 'reaberto'
  pmo_status: statusCode                   // 0 = ativo, 1 = inativo
}
```

#### 2.2 Refatorar `syncGitLabPlanner.js`

Função `handleWebhook(req)`:

```
parse webhook → { action, issue }

switch (action):
  case 'open':
  case 'reopen':
  case 'update':
    mapping = getMappingByGitLabIid(iid)
    if mapping?.pmo_pwataskuid:
      → updatePlannerTask(mapping.pmo_pwataskuid, issue)
      → upsertMapping({...payload, pmo_statussincronizacao: action})
    else:
      task = createPlannerTask(issue)               // bucket padrão = Backlog
      → upsertMapping({...payload, pmo_pwataskuid: task.id})

  case 'close':
    mapping = getMappingByGitLabIid(iid)
    if mapping?.pmo_pwataskuid:
      → updatePlannerTask(mapping.pmo_pwataskuid, issue, { percentComplete: 100 })
      → upsertMapping({...payload, pmo_statussincronizacao: 'fechado'})
    else:
      log warning: "issue fechada sem task no Planner"
```

#### 2.3 Funções do Planner (`plannerClient.js` ou refatorar existente)

- `createPlannerTask(issue, bucketId)`:
  - title = `[#${issue.iid}] ${issue.title}`
  - description = `issue.description.substring(0, 10000)`
  - bucket = bucket padrão se não existir mapping
- `updatePlannerTask(taskId, issue, opts = {})`:
  - se `opts.percentComplete !== undefined` → setar; senão derivar de `issue.state` (closed=100, opened=0)
  - description truncada igual

#### 2.4 Mudança de schema no Dataverse

**Você precisa fazer no Portal Maker (Power Apps):**
- Abrir tabela `pmo_mapeamentoplanner` → campo `pmo_description` → **Alterar tipo de dados** → **Área de texto**
- Publicar

(No código, enquanto não publicar, manter truncate em 4000 chars como fallback.)

#### 2.5 Corrigir bug menor conhecido

Em [syncGitLabPlanner.js:763](src/functions/gitlab-planner-sync/syncGitLabPlanner.js#L763) `handleBulkSync` setta `results.total = issues.length` dentro do loop de paginação — calcular fora.

### Fase 3 — Migração inicial

Script one-shot: `scripts/migrar-planner-existente.js`

Para cada uma das 35 tasks em `docs/18.09.26/planner_tasks.json`:
- Resolver `pwataskuid` real via Graph API (filtrar tasks do plano onde `percentComplete`/`title`/hierarquia bate — **ou** mais simples: dump completo das tasks do plano + correlação por hierarquia)
- Criar registro no `pmo_mapeamentoplanner` com `pmo_statussincronizacao='migrado'`

**Validação:**
- `count(pmo_mapeamentoplanner) == 35`
- Cada mapping tem `pmo_pwataskuid` apontando pra task viva no Planner

### Fase 4 — Operacional

#### 4.1 Webhook GitLab
- Confirmar configuração existente (segundo `local.settings.json`, já tem `GITLAB_WEBHOOK_SECRET`)
- Eventos: **Issue events** (open / update / close / reopen)

#### 4.2 Validação ponta-a-ponta
- Criar issue de teste no GitLab → task aparece no Planner, mapping no Dataverse
- Atualizar issue → task atualiza, mapping tem `pmo_dataultimasincronizacao = hoje`
- Fechar issue → task fica 100% concluída

#### 4.3 Observabilidade
Cada execução loga JSON estruturado:
```json
{ "iid": N, "action": "open|update|close|reopen", "mapping_found": bool, "task_action": "created|updated|none", "dataverse_action": "created|updated|none", "latency_ms": N, "errors": [] }
```
Erros vão pro Application Insights.

### Fase 5 — Saneamento (opcional, pós-operação estável)

- [ ] **5.1** Backfill das 728 issues do GitLab sem task no Planner:
  - Usar endpoint `?bulk=true&limit=N` existente (throttle 400ms)
  - Rodar em batidas de 100, monitorar
- [ ] **5.2** Validação final: `dryRun=true` deve retornar `in_sync == 763, would_create: 0, would_update: 0`

---

## Critérios de sucesso

1. Webhook GitLab → Planner funcional sem intervenção manual
2. Zero duplicatas no Planner (verificação por `pmo_pwataskuid`)
3. Dataverse `pmo_mapeamentoplanner` mantém 100% das tasks existentes + novas com todos os campos preenchidos
4. Logs estruturados disponíveis no Application Insights
5. `dryRun=true` consistente após cada mudança

## Riscos

- **R1:** App registration `18fb3c07-…` sem permissão `Planner.ReadWrite.All` ou `Dataverse.*` → resolver antes da Fase 2
- **R2:** Dataverse limita `pmo_description` em 2000 chars se campo não for alterado → perda de conteúdo; **mitigação:** confirmar mudança do tipo na Fase 2.4 antes de prosseguir
- **R3:** GitLab `listIssues` retorna por `updated_at` desc → bulk limitado pode pular issues pouco editadas; **mitigação:** paginação completa ou ordenação por `iid` no bulk
- **R4:** Concorrência no webhook (2 updates simultâneos na mesma issue) → `etag` mismatch no Planner; **mitigação:** retry com backoff na PATCH

## Pendências abertas (decisões minhas que precisam do seu OK)

- **(D1)** Rotação do `AZURE_CLIENT_SECRET`: você faz agora ou depois? Bloqueia Fase 0.3+.
- **(D2)** Manter as 35 tasks existentes (proposta) ou deletar pra recomeçar do zero? — **proposta: manter**, vou seguir com isso a menos que você diga o contrário.
- **(D3)** Mudança de tipo do `pmo_description` no Portal Maker: **Área de texto** (sem limite) — confirmar pra eu listar como Fase 2.4.
