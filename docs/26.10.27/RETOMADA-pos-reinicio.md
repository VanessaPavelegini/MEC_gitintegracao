# Retomada — 27/10/2026 — SYNC PREMIUM DE HOMOLOGAÇÃO (pós-reinício)

> **Ponto exato onde paramos**: o trabalho de código está **commitado e publicado**. O que
> falta é o que depende de você no navegador (adicionar a conta ao projeto) e o deploy da
> Function. Quando voltar, comece lendo este arquivo.

---

## ✅ O que JÁ está feito (não precisa refazer)

| Item | Valor | Onde |
|---|---|---|
| Branch publicada | `feature/premium-homologacao-sync` → `origin` | 22 commits desde `origin/main` |
| Commits desta sessão | `ac0c6d7` fix do operation set · `1baabb2` token store · `ca5fd10` scripts · `881bade` docs · `9083779` chore | branch |
| Testes | **93/93 passando** (`npm test`) | — |
| Sync validado | 588 tasks criadas, 588 mappings no PRD, reexecução idempotente, 0 erros | runner local |
| RBAC do deploy | **destravado** (PIM renovado em 27/10/2026) | [[azure-rbac-functionapp-desbloqueado]] |
| Refresh token | no Blob `service-tokens/premium-dataverse-refresh-token.json` | storage `rgpnldapphmgmeca8a8` |
| Identidade do token | `antoniobjunior@mec.gov.br` (claim `upn` do JWT conferido) | — |
| Plano alvo | `c385351a-e450-4d54-87ed-d54c57794f7b` — "Homologação _NOVO SISTEC 2 - Cópia" | org Default `orgcf194dda` |
| Bucket destino | `f704c207-84be-f111-a04d-7c1e520d9f67` ("Bucket 1") | — |

### A correção principal desta sessão

O Dataverse aplica o operation set **de forma assíncrona**. Apagar o registro do set logo
depois do `msdyn_ExecuteOperationSetV1` **cancelava a criação pendente** — a primeira execução
real gerou 588 tasks "criadas" que nunca existiram no plano.

Agora o fluxo é: execute → **espera as tasks materializarem** (comparando uma impressão
digital da descrição, porque o Planner Premium reescreve o HTML) → só então descarta o set
(o DELETE é o que libera a cota de 10 sets vivos por usuário).

---

## 🚧 O que FALTA (nesta ordem)

### 1. Adicionar a conta `portaldedemandas` ao projeto Premium

Você disse que ia fazer isso. É o que destrava a escrita com a identidade do portal.

- **Grafia certa: `portaldedemandas@mec.gov.br`** (dois `d`). Existe no tenant como
  "Conta de Serviço do Portal de Demandas", com **9 licenças**, e tem `systemuser` na org
  Default (`efc0454c-66a9-ec11-983f-000d3a178dce`, `islicensed=true`).
- ⚠️ **Cuidado:** existe outra conta parecida, `portaldemandas@mec.gov.br` (um `d` só),
  "MEC - Portal de Demandas", com **0 licenças** e **sem** systemuser na org. Não é ela.

Como a escrita é via Dataverse (`msdyn_projecttasks` + operation sets, não Graph Planner),
o que precisa mudar é o **papel de segurança no Dataverse** para `msdyn_project*` — não a
adesão como membro no Planner.

### 2. Se a identidade de escrita voltar a ser a conta do portal

Rode o device code flow autenticando com a conta do portal:

```bash
node scripts/autorizarContaServicoPremium.js
```

O script grava o refresh token no Blob **e** no `.premium-refresh-token.json` (o AAD rotaciona
o token a cada troca, então os dois lados precisam ver o mais recente). Ao final, confira o
claim `upn` do access token: tem que ser `portaldedemandas@mec.gov.br`.

Depois, rode o smoke test antes de qualquer coisa em lote:

```bash
node scripts/smoke-premium-homologacao.js
```

### 3. Publicar a Function e a rota

```bash
func azure functionapp publish func-gitintegracao --javascript
curl "https://func-gitintegracao-febwfvfnbwchbbhb.brazilsouth-01.azurewebsites.net/api/gitlab-planner-premium-homologacao-buckets"
```

A rota que o Power Automate chama é `gitlab-planner-premium-homologacao` (o flow repassa o
cursor até o fim; o sync de ~720 issues não cabe no timeout de 230 s de uma chamada).

---

## ⚠️ Segurança — pendência aberta

O `AZURE_CLIENT_SECRET` do app `app-pnld` estava em **texto claro** no doc
`docs/18.09.26/RETOMADA-pos-reinicio.md` desde 18/09/2026. Isso **travou o push** (secret
scanning do GitHub).

- ✅ **Resolvido:** o valor foi redigido do histórico. O commit com o segredo era a base da
  branch e **nunca tinha sido publicado**, então reescrevi só ele e rebaseei o resto. O `main`
  local (8 commits não publicados) foi apontado para a cadeia limpa. O blob antigo foi
  expurgado do object store. O remote nunca recebeu o segredo.
- 🔴 **Ainda vale rotacionar:** o secret continua **válido no Entra ID** e está no
  `local.settings.json` em disco (que nunca foi versionado — está no `.gitignore`).
  Rotacione `AZURE_CLIENT_SECRET` e atualize o app setting da `func-gitintegracao` + o
  `local.settings.json`.

---

## 📁 Mapa dos arquivos novos

| Arquivo | Para quê |
|---|---|
| `scripts/sync-premium-homologacao-local.js` | roda o mesmo handler da Function na máquina |
| `scripts/conferir-sync-premium-homologacao.js` | confere tasks × mappings |
| `scripts/limpar-lixo-homologacao.js` | apaga tasks de teste e mappings órfãos |
| `scripts/criar-coluna-pmo-gitlab-updatedat.js` | cria `pmo_gitlab_updatedat` no PRD |
| `scripts/smoke-premium-homologacao.js` | teste de fumaça da escrita no plano |
| `scripts/diag-mapeamento-schema.js` | diagnóstico do schema do mapping |
| `scripts/diag-plano-homologacao-default.js` | diagnóstico do plano alvo |
| `docs/26.10.26/RELATORIO-sync-premium-homologacao.md` | o que foi feito, o que falta |
| `docs/26.10.26/RUNBOOK-sync-premium-homologacao.md` | passo a passo operacional |

---

## 💡 Nota de identidade (para não se perder depois)

A escrita no Planner Premium **exige identidade de usuário com licença ModernProject**. O app
user `app-pnld` (client credentials) é bloqueado com `UserNotLicensed`. Até agora a identidade
que escreve é a sua conta, via refresh token delegado guardado no Blob.

Isso é um stopgap: refresh token pessoal dentro da Function App quebra em troca de senha/MFA
e amarra a produção a uma pessoa. O destino certo é uma identidade de serviço licenciada (a
`portaldedemandas` com papel de escrita no Dataverse) — que é exatamente o que o passo 1
destrava.
