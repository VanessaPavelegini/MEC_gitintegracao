# Retomada — 29/10/2026 — sync GitLab → Planner Premium (pós-reinício)

> **Ponto exato onde paramos**: a detecção de mudanças **está publicada e
> verificada em produção**. O timer da Function App roda de 30 em 30 minutos e
> a varredura incremental está funcionando. Não há nada de código pendente.
>
> Quando voltar, comece lendo este arquivo. Ele vale mais que o chat.

---

## ✅ O que já está feito (não precisa refazer)

| Item | Valor | Onde |
|---|---|---|
| Branch | `feature/premium-homologacao-sync` | 2 commits à frente do remote (ver §4) |
| Identidade de escrita | **`portaldedemandas@mec.gov.br`** (conta de serviço) | [[premium-identidade-escrita]] |
| Plano alvo | **`c0ecce95-1107-4343-8c05-bcf7c9a291f8`** | org Default `orgcf194dda` |
| Bucket | **`be10a1da-0bd2-f111-84dc-7c1e520d9dbb`** ("Bucket 1", único) | — |
| Mapeamento | 588 tasks × 588 mappings no PRD, **0 divergências** | `pmo_mapeamentoplanner` |
| Detecção de mudanças | **publicada e verificada** | commit `0c60567` |
| Timer | `*/30 * * * *`, janela 60 min | `app.timer` |
| Testes | **138/138 passando** (`npm test`) | — |
| Deploy | `func azure functionapp publish func-gitintegracao --javascript` | funciona mesmo com `az` vencido |

### Verificações feitas em produção (29/10/2026)

| Verificação | Resultado |
|---|---|
| Schedule do timer | `*/30 * * * *` registrado no app |
| Disparo real | `Last=2026-10-29T13:00:00Z` — no horário; detectou a #762 (GitLab 12:49) e atualizou a task às 13:00:09 |
| Idempotência | 2º sync imediato: 0 criadas, 0 atualizadas, 21 iguais |
| Trava | syncs simultâneos: um 200, outro **409** `trava em uso por sync` |
| Sync real | 1 atualizada, 0 erros |
| Ganho | 811 → 107 issues (87% menos), 12,5 s → 2,5 s |

---

## 🧭 Como o fluxo funciona agora

**O usuário mexe na issue no GitLab → o Planner Premium reflete sozinho.**

Não precisa de Power Automate para isso. A Function App tem um **timer interno**
que dispara a cada 30 min:

1. O timer chama a varredura incremental.
2. A varredura pergunta ao GitLab só o que mudou na janela (`updated_after`,
   default 1440 min).
3. O diff por issue compara o `updated_at` do GitLab com o `pmo_gitlab_updatedat`
   gravado no mapping (org PRD).
4. O que mudou é reescrito no plano (via operation set).
5. A trava (`premium-sync-lock.json` no container `service-tokens`) garante que
   só um sync roda por vez.

**As rotas:**

| Rota | Para quê |
|---|---|
| `POST /api/gitlab-planner-premium-changes` | varredura incremental (param `lookbackMinutes`) |
| `POST /api/gitlab-planner-premium-timer` | dispara o sync do timer na hora |
| `POST /api/gitlab-planner-premium-homologacao` | sync completo, por cursor (carga inicial) |
| `GET /api/gitlab-planner-premium-homologacao-buckets` | confere plano/bucket vigentes |

Detalhamento completo em
[`../26.10.26/DETECCAO-mudancas-gitlab-premium.md`](../26.10.26/DETECCAO-mudancas-gitlab-premium.md).

---

## 🚧 O que ainda pode pedir atenção

### 1. Rotação do refresh token (a pendência recorrente)

O AAD **rotaciona** o refresh token a cada troca. O token novo precisa ser
gravado no Blob — senão o próximo cold start falha.

O limite do conditional access do tenant é de **22 h** (79200 s). Quando
estourar, aparece `AADSTS70043` e a rota responde **500** em qualquer chamada
que não seja dry run.

Remediação (precisa de navegador + MFA):

```bash
node scripts/autorizarContaServicoPremium.js
```

> A conta `antoniojunior@mec.gov.br` também serve, mas é conta de pessoa e
> expira mais rápido. Prefira a `portaldedemandas@mec.gov.br`.

### 2. Rotação do secret do app (segurança)

O `AZURE_CLIENT_SECRET` do app `app-pnld` já foi **redigido do histórico do
git** (o push do secret de 18/09 foi barrado), mas o valor continua **válido no
Entra ID** e está no `local.settings.json` em disco. Vale rotacionar e
atualizar o app setting da `func-gitintegracao`.

### 3. O plano antigo `c385351a`

Ainda existe e ainda recebe escrita. O sync real de 588 tasks foi para o plano
**novo** (`c0ecce95`). Os docs `PLAN` e `RELATORIO` de 26/10 ainda citam o
plano antigo (são registros históricos daquele dia); o `RUNBOOK` e o `PA-FLOW`
já foram corrigidos em 29/10/2026.

---

## 📁 Mapa dos arquivos

| Arquivo | Para quê |
|---|---|
| `src/functions/gitlab-planner-sync/premiumChangeDetector.js` | janela + diff por issue |
| `src/functions/gitlab-planner-sync/premiumSyncRunner.js` | percorre as páginas até o fim |
| `src/functions/gitlab-planner-sync/premiumChangesHandler.js` | rota incremental (com trava) |
| `src/functions/gitlab-planner-sync/premiumSyncLock.js` | trava de execução |
| `src/functions/gitlab-planner-sync/syncGitLabPlannerPremiumChanges.js` | rota HTTP da detecção |
| `src/functions/gitlab-planner-sync/syncGitLabPlannerPremiumTimer.js` | timer + rota de disparo manual |
| `src/shared/dataverseServiceAccountAuth.js` | token delegado da conta de serviço (Blob) |
| `scripts/autorizarContaServicoPremium.js` | device code flow → grava o token no Blob |
| `scripts/autorizar-conta-teste-premium.js` | device code flow de **teste** (não toca na produção) |
| `scripts/verificar-acesso-escrita-premium.js` | teste de escrita sem tocar no token de produção |
| `scripts/smoke-premium-homologacao-corrigido.js` | smoke test (espera materializar antes de descartar o set) |
| `docs/26.10.26/DETECCAO-mudancas-gitlab-premium.md` | como a detecção funciona |
| `docs/26.10.26/RUNBOOK-sync-premium-homologacao.md` | passo a passo operacional |
| `docs/26.10.26/PA-FLOW-sync-gitlab-planner-premium-homologacao.md` | blueprint do Power Automate |

---

## 💡 Armadilhas conhecidas

| Armadilha | Detalhe |
|---|---|
| `FUNCTION_KEY` truncada | a chave tem 56 caracteres; cortando, a rota responde 401 (indistinguível de 404) |
| `az` vencido | `AADSTS70043`; o `func azure functionapp publish` funciona mesmo assim |
| Subscription GUID | o real é `7def3c16-d18b-40d5-9aa4-ce0f1ec495b7`; o nome `ccmecapppnld13383hom` é inválido para a API ARM |
| Dois storages | `AzureWebJobsStorage` = `rgpnldapphmgmec82e9` (timers); `AZURE_STORAGE_CONNECTION_STRING` = `rgpnldapphmgmeca8a8` (token e trava) |
| Grafia da conta | `portaldedemandas` (dois `d`, com licença) ≠ `portaldemandas` (um `d`, 0 licenças) |
| API do blob SDK | `upload(body, contentLength, options)` — **3 argumentos**; a forma de 2 não existe |
| `msdyn_progress` | é razão 0..1 (1 = 100%), não 0..100 |
| Rota nova | depois do publish, ~2 min de 404 até o sync de triggers |
