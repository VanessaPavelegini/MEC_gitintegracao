# Retomada — 18/09/2026 — MIGRAÇÃO PARA PLANNER CLÁSSICO

> **Ponto exato onde paramos**: você está prestes a reiniciar o laptop. Tudo já está persistido em disco + Azure. Quando voltar, comece lendo este arquivo.

---

## ✅ O que JÁ está feito (não precisa refazer)

| Item | Valor | Onde |
|---|---|---|
| `PLANNER_PLAN_ID` | `4603e73f-637a-453a-aedf-51051ac963f9` (incorreto, vai dar erro) | `local.settings.json` + Azure prod |
| `AZURE_CLIENT_SECRET` | `(valor omitido — ver Key Vault / variável de ambiente)` (novo, limpo) | `local.settings.json` + Azure prod |
| `AZURE_TENANT_ID` | `b8c25932-5e76-4b2b-9c53-d41745e9c92d` | já estava OK |
| `AZURE_CLIENT_ID` | `18fb3c07-66df-40a0-86d6-5d2d84dea60f` | já estava OK |
| Function App | `func-gitintegracao` em `rg-pnld-app-hmg-mec` | já estava OK |
| Restart da function | Aplicado após mudança de secret | já feito |
| Dataverse access | ✅ Funcionando (100 mappings órfãos) | OK |
| GitLab access | ✅ Funcionando | OK |
| XLSX do Premium | Salvo em `docs/18.09.26/AutomaçãoTestes.xlsx` | OK |

---

## 🚧 PROBLEMA QUE NÃO FOI RESOLVIDO

**`4603e73f-637a-453a-aedf-51051ac963f9` (passado pelo cliente) é um projeto do PLANNER PREMIUM (Project for the Web)**, não do Planner clássico. Backends diferentes.

- A função `syncGitLabPlanner.js` foi feita pra **Planner clássico**
- POST `/planner/tasks` com `planId=4603e73f-...` retorna **400 - identifier invalid**
- GET `/planner/plans/{4603e73f-...}` retorna **404**
- A função NÃO enxerga esse plano via Graph API
- Ontem: 722 tasks foram criadas no plano ERRADO `V6eQb5zdBk…` e depois deletadas
- Hoje: **0 tasks no plano Premium certo** + 100 mappings órfãos no Dataverse

### Cliente precisa decidir entre:
- **(A)** Continuar com Planner **clássico** (eu recomendo — já tem código funcionando)
- **(B)** Reescrever integração pra **Project for the Web** (Dataverse `msdyn_*`, ~2-3 dias)

### Decisão AGORA (que você vai ler quando voltar):
**Você perguntou se dá pra recriar a mesma estrutura do Premium no Clássico.** Resposta: **SIM**, com adaptações:
- Estrutura hierárquica (1.1.1) → vira prefixo no título (Planner flat)
- Dependências entre tasks → não existem no clássico (descartar)
- Campos custom (TIME, Estágio HU, KANBAN, Sprint, Goal, TESTE BI) → guardar como prefixo na descrição

---

## 🎯 PRÓXIMOS PASSOS (quando você voltar)

### Passo 1 — Criar plano clássico novo manualmente (5min)
Você vai abrir `https://tasks.office.com` no navegador, clicar "+ Novo plano", dar o nome (ex: `AutomaçãoTestes Clássico`), e me passar o `planId` da URL (formato UUID).

### Passo 2 — Eu atualizo settings
Vou trocar `4603e73f-...` pelo planId novo no `local.settings.json` + Azure + restart.

### Passo 3 — Importar as 35 tasks do XLSX
Vou ler o `docs/18.09.26/AutomaçãoTestes.xlsx` e criar as tasks no plano clássico via POST `/planner/tasks`. Pode ser em **dry-run primeiro** (só loga o que vai criar, sem chamar API).

### Passo 4 — Resetar os 100 mappings órfãos no Dataverse
Independente do plano, os 100 mappings que apontam pro `V6eQb5zdBk…` (errado) devem ser deletados.

### Passo 5 — Validar /api/health
`curl https://func-gitintegracao-febwfvfnbwchbbhb.brazilsouth-01.azurewebsites.net/api/health` → deve mostrar `planner.ok = true`.

### Passo 6 — Reativar sync
Webhook do GitLab → Planner clássico → Dataverse mapping funcionando.

---

## 📂 Arquivos importantes pra retomar

| Arquivo | Conteúdo |
|---|---|
| `docs/18.09.26/AutomaçãoTestes.xlsx` | Export do plano Premium (35 tasks hierárquicas) |
| `docs/18.09.26/discrepancias_gitlab_vs_planner_premium.csv` | Comparação GitLab vs Premium feita ontem |
| `docs/18.09.26/resumo_discrepancias.md` | Resumo executivo das discrepâncias |
| `docs/18.09.26/PLAN-sync-gitlab-planner-dataverse.md` | Plano de execução atualizado |
| `local.settings.json` | Settings locais (commit seguro) |
| `src/functions/gitlab-planner-sync/syncGitLabPlanner.js` | Código da function atual (Planner clássico) |

---

## 🧪 Comandos rápidos pra validar pós-reiniciar

```bash
# 1. Login Azure
az login

# 2. Confirmar settings
az functionapp config appsettings list \
  --name func-gitintegracao \
  --resource-group rg-pnld-app-hmg-mec \
  --query "[?name=='PLANNER_PLAN_ID' || name=='AZURE_CLIENT_SECRET'].[name,value]" \
  --output tsv

# 3. Testar função
curl https://func-gitintegracao-febwfvfnbwchbbhb.brazilsouth-01.azurewebsites.net/api/health | python3 -m json.tool
```

---

## 💬 Mensagem que ficou pendente

Você estava em dúvida sobre recriar a estrutura no clássico. Quando voltar:

1. **Decide** se quer **criar plano clássico novo** (e me passa o ID) ou **deletar tudo e voltar pro antigo** `V6eQb5zdBk…` (mas esse também não é o que o cliente pediu)
2. **Confirma com cliente** se a integração pode ser via clássico (recomendação minha: SIM, mesma estrutura final, bem mais barato de manter)

---

**Última atualização**: 18/09/2026 16:50 BRT (antes do seu restart)
**Sessão atual**: cancelada — pode fechar o Claude Code sem perda
