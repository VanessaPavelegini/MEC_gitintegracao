# Plano — painel do gestor (SPFx) e o token que vence

> **03–04/11/2026.** O painel SPFx continua só planejado; nada foi implementado.
> O token foi reautorizado em 04/11 e a sincronização manual recuperou as
> alterações acumuladas. A preocupação recorrente permanece: o token volta a
> vencer por causa do conditional access.
> Dois assuntos: (1) um web part SPFx para um gestor acompanhar e controlar o
> sync GitLab → Planner Premium, e (2) a conta de serviço cujo token vence
> todo dia, que é a preocupação principal.

---

## 0. Estado verificado em 04/11/2026

| Item | Situação |
|---|---|
| Timer `syncGitLabPlannerPremiumTimer` | **rodando** — agenda `*/30 * * * *`; verificado no status do Storage |
| Token da conta de serviço | **reautorizado em 04/11** — `node scripts/autorizarContaServicoPremium.js` confirmou o login e salvou o refresh token no Blob e local; access token conferido como `portaldedemandas@mec.gov.br` |
| Sincronização manual | **recuperada sem erros** — uma execução atualizou 1 issue; depois a janela de 7 dias criou 1 e atualizou 60, `errors: []` |
| Application Insights | o app aponta para `func-gitintegracao202609141657`; em 03/11 não aparecia telemetria na consulta do portal |
| Painel SPFx | continua **não implementado**, apenas planejado neste documento |

### Onde o agendamento "mora" (não é crontab)

Function App não tem `cron` do Linux. No SSH do worker aparecem:

| Processo | Quem fez | Papel |
|---|---|---|
| `Microsoft.Azure.WebJobs.Script.WebHost` (.NET, PID 39) | Microsoft | runtime do Azure Functions: agenda o timer, recebe HTTP, chaves, escala |
| `node .../nodejsWorker.js` (PID 96) | Microsoft | ponte que carrega e executa o código JS do projeto, chamada pelo host via gRPC |

O host é .NET para qualquer linguagem; o código do projeto continua todo em
Node. O controle de "quando rodou" fica no Storage `AzureWebJobsStorage`
(`rgpnldapphmgmec82e9`), blob
`azure-webjobs-hosts/timers/func-gitintegracao/Host.Functions.syncGitLabPlannerPremiumTimer/status`.

Logs de execução no worker (se o log em arquivo estiver ligado):

```bash
ls -lt /home/LogFiles/Application/Functions/Host/ | head
tail -50 "$(ls -t /home/LogFiles/Application/Functions/Host/*.log | head -1)" | grep -i syncGitLabPlannerPremiumTimer
```

---

## 1. A conta com o token vencendo (prioridade)

**Causa:** política de Acesso Condicional do tenant com *sign-in frequency* de
22 h (79200 s). A regra conta a partir do **último login com senha/MFA**, não
da última renovação — o sync troca o token a cada 30 min e ele morre 22 h
depois do login mesmo assim.

| Caminho | Resolve? | Por quê |
|---|---|---|
| Excluir a conta de serviço da regra de frequência de entrada | **Sim** | o token passa a durar enquanto for usado; caminho padrão para contas de serviço |
| Usar o app `app-pnld` (sem usuário) | Não | Planner Premium exige usuário licenciado; nenhum app do tenant tem licença (testado em 27/10) |
| Mover a escrita para o Power Automate | Não | a conexão do flow é token da mesma conta e cai na mesma regra |
| Login automático com usuário e senha | Não | a conta tem MFA; senha em código é pior que o problema |

**Recomendação:** pedir ao time de identidade (o mesmo da REQ676377) uma
exceção na frequência de entrada só para a `portaldedemandas@mec.gov.br`, com
controles de compensação: restrita ao aplicativo Dynamics CRM/Dataverse,
limitada a locais nomeados (rede MEC + IPs de saída da Function App),
mantendo MFA no login inicial.

Texto para o chamado:

```
Solicito exceção na política de Acesso Condicional que define frequência de
entrada (sign-in frequency de 22 h) para a conta de serviço
portaldedemandas@mec.gov.br.

Motivo: a conta é usada por uma integração automática (Azure Function
func-gitintegracao) que grava no Planner Premium a cada 30 minutos. O
Planner Premium não aceita aplicativo sem usuário licenciado, então a
integração depende do token delegado dessa conta. Com a frequência de 22 h,
o token expira diariamente (erro AADSTS70043) e a integração para até
alguém refazer o login manualmente.

Controles sugeridos: exceção restrita ao aplicativo Dynamics CRM/Dataverse,
limitada a locais nomeados da rede MEC e aos IPs de saída da Function App,
mantendo MFA no login inicial.
```

**Enquanto a exceção não sai:** o risco maior é a falha silenciosa (29/10 →
03/11 parado sem ninguém saber). Mitigação: a função avisa por e-mail/Teams
quando o token vence, para quem tem a senha refazer
`node scripts/autorizarContaServicoPremium.js`.

---

## 2. Painel do gestor (SPFx) — é possível

### Por que não dá para ler/editar direto o que existe hoje

| O que o gestor quer | Onde está hoje | Problema |
|---|---|---|
| Ver o agendamento | no código, a partir do app setting `PREMIUM_TIMER_INTERVAL_MINUTES` | só via Azure Resource Manager, com papel de administrador |
| Ver execuções e erros | em lugar nenhum útil | App Insights sem telemetria; Storage só tem Last/Next |
| Mudar o horário | app setting da Function App | exige Contributor no Azure e reinicia o app |

Dar Contributor ao gestor resolveria, mas ele poderia apagar a função. Não recomendado.

### Proposta: três peças

1. **Lista "Agendamentos de sync" (SharePoint)** — editável só pelo grupo de
   gestores: Ativo, Intervalo/horários permitidos, Janela de busca, Plano alvo.
   A função passa a ter um timer fixo de **5 min** que funciona como relógio:
   a cada batida lê a lista e decide se é hora de rodar. Mudança vale na
   próxima batida, sem deploy, sem reinício, sem acesso ao Azure.
2. **Lista "Histórico de execuções"** — uma linha por execução: início, fim,
   origem (agendada/manual), criadas/atualizadas/ignoradas, status
   (sucesso/falha/pulado por trava), erros por issue (número + mensagem).
3. **Web part SPFx com três abas:**
   - **Agendamento:** mostra e edita a lista 1.
   - **Histórico:** lista execuções com filtro por status e detalhe de erros.
   - **Saúde:** último sucesso, token válido ou vencido, botão "Rodar agora".

O SPFx lê e grava as listas direto no SharePoint (sem autenticação extra);
só o botão "Rodar agora" chama a Function.

### Decisões e aprovações necessárias

1. **Permissão do `app-pnld` no SharePoint** — escrever no site via Graph com
   `Sites.Selected` (só aquele site). Precisa de aprovação de admin do tenant.
   Não foi conferido o que o app tem hoje.
2. **Botão "Rodar agora"** — a chave de função não pode ir para o navegador.
   Proteger a rota com Entra ID e chamar com `AadHttpClient`; exige aprovação
   da API no centro de administração do SharePoint. Pode ficar para depois.
3. **Quem é gestor** — grupo do SharePoint basta para as listas; grupo do
   Entra se o botão existir.
4. **Site das listas** — `AutomacoesdeProcessos` (já configurado em
   `SP_SITE_ID`) ou um site do Portal de Demandas.

### O que o painel não resolve

O painel **avisa** que o token venceu, mas não renova (exige login com MFA da
própria conta). Só a exceção da seção 1 tira essa responsabilidade de uma pessoa.

### Ordem sugerida

1. Pedir a exceção de Acesso Condicional (seção 1) — em paralelo a tudo.
2. Criar as duas listas e pedir `Sites.Selected` para o `app-pnld`.
3. Function lê a configuração e grava o histórico (testável sem tela).
4. Web part com as abas Histórico e Agendamento.
5. Botão "Rodar agora" após a aprovação da API.
