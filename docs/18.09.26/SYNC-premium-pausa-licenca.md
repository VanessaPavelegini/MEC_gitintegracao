# Premium Sync — Status 18/09/2026 — PAUSADO por licença

> **Ponto onde paramos:** Plano Premium foi criado no Aplicativos PRD, mas o App User (`app-pnld`) não tem licença `Microsoft Project Plan 3/5`, e o Project Operations exige licença pra criar/modificar `msdyn_projecttask` (erro `UserNotLicensed <ModernProject>`).

## ✅ O que JÁ está feito

### Recursos criados no Aplicativos PRD (`org41ecace2`)

| Recurso | ID | Tipo | Status |
|---|---|---|---|
| Plano Premium | `8ebc738c-bcb3-f111-aaab-00224836dcc6` | `msdyn_project` | ✓ Criado |
| Bucket "Backlog" (order=1) | `f3125edd-bcb3-f111-aaab-7ced8db10825` | `msdyn_projectbucket` | ✓ Criado |
| Bucket "Análise" (order=2) | `f5125edd-bcb3-f111-aaab-7ced8db10825` | `msdyn_projectbucket` | ✓ Criado |
| Bucket "Em Desenvolvimento" (order=3) | `f6125edd-bcb3-f111-aaab-7ced8db10825` | `msdyn_projectbucket` | ✓ Criado |
| Bucket "Revisão" (order=4) | `a78d5ee0-bcb3-f111-aaac-7ced8da8d8be` | `msdyn_projectbucket` | ✓ Criado |
| Bucket "Concluído" (order=5) | `628686e0-bcb3-f111-aaac-6045bd3a7abb` | `msdyn_projectbucket` | ✓ Criado |

URL do plano no Planner UI (depois que terminar):
```
https://planner.cloud.microsoft/webui/premiumplan/<plan_id_no_aplicativos_prd>/...
```

### Solução instalada
- **Microsoft Project Service Core** no Aplicativos PRD (em 18/09/2026 ~21h).
- Habilitou: `msdyn_project`, `msdyn_projecttask`, `msdyn_projectbucket`, `msdyn_projectparameters`, `msdyn_workhourtemplates`, `msdyn_businessunit`, etc.
- **NÃO habilitou:** `msdyn_PssCreateV1` etc (já estavam presentes mas exigem licença de usuário).

### Permissões verificadas
- App User `app-pnld` (systemuserid `837e9242-c502-f111-8407-00224836c197`):
  - applicationId = `18fb3c07-66df-40a0-86d6-5d2d84dea60f`
  - accessMode = `4` (Não Interativo)
  - isDisabled = `false`
  - **isLicensed = `false`** ← BLOQUEADOR
  - Roles: Administrador do Sistema
- App Registration no Entra ID:
  - Tenant `b8c25932-5e76-4b2b-9c53-d41745e9c92d`
  - Client `18fb3c07-66df-40a0-86d6-5d2d84dea60f`
  - **Nenhuma licença M365 atribuída** (não tem Microsoft Project Plan 3/5)

### Erro encontrado no smoke test (18/09/2026 22h)
```
POST /msdyn_ExecuteOperationSetV1
→ 400 UserNotLicensed
  User does not have license to use <ModernProject> with <ReadOnly> access
```
A checagem é feita no plugin `Microsoft.Dynamics.ProjectServiceCoreSandbox.Plugins`. Aplica mesmo para System Administrator em modo Non-Interactive.

---

## 🚧 BLOQUEIO ATUAL

O Project Operations **EXIGE licença** pra qualquer operação CRUD em `msdyn_project*`. Não tem como o webhook criar/modificar tasks Premium até que **uma das** condições seja atendida:

### Opção A — Licenciar o App User (RECOMENDADA)
- Acessar https://admin.microsoft.com (precisa Global Admin)
- Ir em **Usuários → Usuários ativos → app-pnld**
- Em **Licenças e aplicativos**, atribuir **Microsoft Project Plan 3** ou **Microsoft Project Plan 5**
- Custo: Project Plan 3 ≈ $30/user/mês, Plan 5 ≈ $55/user/mês (valores USD)
- Depois da licença atribuída, **rodar**:
  ```bash
  # Sincronizar licença com Dataverse (pode demorar até 5 min)
  # Pode também exigir mudar islicensed via Admin Center > Usuários > app-pnld > Status
  ```
- **Confirmar via API:**
  ```
  GET /systemusers(837e9242-c502-f111-8407-00224836c197)?$select=islicensed
  → islicensed: true
  ```

### Opção B — Usar um user humano com licença
- O webhook deixa de usar client_credentials e passa a usar **delegated** com credenciais suas.
- **Mudança significativa de arquitetura**: o webhook vira "user-impersonation", precisa OAuth refresh do user.
- Funciona, mas perde a característica de "automação sem humano".

### Opção C — Power Automate como ponte
- Webhook → dispara Power Automate (que usa licença do user que criou o flow) → grava no Dataverse.
- Mais complexo, mas evita licenciar o App User.
- Limite: 10000 execuções/mês no plano Pro.

---

## 📋 PRÓXIMOS PASSOS (quando houver licença)

### 1. Validar licença funcionando (5 min)
```bash
node scripts/premium-smoke-test.js
# Esperado: cria SMOKE-TEST task via PssCreateV1 + ExecuteOperationSet
# Se passar: tarefa aparece no Planner UI do plano 4603e73f-...
```

### 2. Criar a primeira task real (10 min)
- Pegar uma issue do GitLab de teste
- Rodar a função de sync com `planType=premium`
- Validar visualmente

### 3. Adicionar campos novos em `pmo_mapeamentoplanner` (1h)
- `pmo_plannerprojectid` (Lookup → `msdyn_project`)
- `pmo_plannerbucketid` (Lookup → `msdyn_projectbucket`)
- `pmo_plannerprojecttaskid` (Lookup → `msdyn_projecttask`)
- Ou armazenar como string pra evitar Lookups

### 4. Criar `src/functions/gitlab-planner-sync/syncGitLabPlannerPremium.js` (3h)
- Espelho do `syncGitLabPlanner.js` mas:
  - Usa OData Dataverse em vez de Graph API
  - Labels mapeiam pra buckets via `msdyn_projectbucketid` (gravado no startup)
  - Cria task via `msdyn_CreateOperationSetV1` + `msdyn_PssCreateV1` + `msdyn_ExecuteOperationSetV1`
  - Update via `msdyn_PssUpdateV1`
  - Grava mapeamento em `pmo_mapeamentoplanner`

### 5. Adicionar roteamento em `index.js` (1h)
- Detectar `planType` (via query param ou header)
- Roteia pra `syncGitLabPlannerPremium` ou `syncGitLabPlanner` (Classic)

### 6. Atualizar `healthCheck.js` (15min)
- Adicionar bloco `dataverse_premium.ok` que valida `GET /msdyn_projects?$top=1`

### 7. Batch inicial das 35 tasks do Premium no Default (2h)
- Script que lê issues do GitLab filtradas por label específico
- Cria tasks no novo plano Aplicativos PRD
- Salva mappings

### 8. Cleanup das 71 tasks Classic órfãs (30 min)
- API que deleta tasks Classic criadas em 18/09/2026

### 9. Atualizar docs (30 min)
- `GITLAB_PLANNER_SYNC.md`: seção "Premium sync"
- `RETOMADA-pos-reinicio.md`: nota de migração
- Apagar/criar `docs/18.09.26/SYNC-premium-finalizado.md`

---

## 📂 Arquivos importantes pra retomar

| Arquivo | Conteúdo |
|---|---|
| `docs/18.09.26/SYNC-premium-planejamento.md` | Plano original |
| `docs/18.09.26/SYNC-premium-pausa-licenca.md` | **ESTE ARQUIVO** — estado atual |
| `/tmp/premium_buckets.json` | IDs dos 5 buckets criados |
| `local.settings.json` | `DATAVERSE_URL` aponta pro Aplicativos PRD (não trocar) |
| `src/functions/gitlab-planner-sync/syncGitLabPlanner.js` | Handler Classic (intacto) |
| `src/functions/gitlab-planner-sync/tableStorage.js` | Dataverse client (precisa estender com `saveMappingPremium`) |
| `src/functions/gitlab-planner-sync/healthCheck.js` | Health check (precisa adicionar `dataverse_premium`) |

---

## 🔗 Memória persistente

Estado gravado em:
- `/Users/antoniojunior/.claude/projects/-Users-antoniojunior-Dev-projetos-spfx-MEC-gitintegracao/memory/me-orgs-dataverse.md`
- `/Users/antoniojunior/.claude/projects/-Users-antoniojunior-Dev-projetos-spfx-MEC-gitintegracao/memory/me-plano-premium-estado.md`
- `/Users/antoniojunior/.claude/projects/-Users-antoniojunior-Dev-projetos-spfx-MEC-gitintegracao/memory/me-mapeamento-tabelas.md`
