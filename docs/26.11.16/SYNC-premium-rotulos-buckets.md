# Sync GitLab → Planner Premium: rótulos, buckets e plano-alvo (16/11/2026)

## Plano-alvo

| Item | Valor |
|---|---|
| Plano | `b7c07b90-9ddc-4af3-8190-d52ca9281ab1` ("NOVO SISTEC 2 - Cópia") |
| Bucket padrão | `42f96e1e-95df-f111-84dc-7c1e520d9550` ("Bucket 1") |
| Org | Default `orgcf194dda` |

O plano antigo, `c0ecce95`, não recebe mais escrita. No Function App, `PREMIUM_HOMOLOGACAO_PLAN_ID` e `PREMIUM_HOMOLOGACAO_BUCKET_ID` ainda precisam apontar para o plano novo.

## Rótulos (`premiumLabelMap.js`)

O plano tem 25 vagas fixas de rótulo, e as vagas foram renomeadas via `msdyn_PssUpdateV2` em `msdyn_projectlabel`. O GitLab tem cerca de 150 rótulos, que o `mapGitlabLabels` traduz para essas 25 vagas:

- **Fluxo:** Backlog, HU em elaboração, HU homologada, Em desenvolvimento, Desenvolvida, Concluída, Em teste, Aprovada no teste, Com defeito, Em homologação, Homologada, Impedimento.
- **Módulos:** Instituição, Cursos, Matrícula, Oferta, CNCT.
- **Times:** CEFET, Time CHILLI, Time PEPPER.
- **Outros:** Apontamentos, Revisão SETEC, Mantis, Release 1, Em produção.

Regras de tradução:
- As variações de um rótulo são unificadas, por exemplo EM HOMOLOGAÇÃO e Entrega em homologação viram "Em homologação".
- Um rótulo terminado em `- CEFET` vira o status correspondente e também o rótulo CEFET.
- SPRINT nn e PP - nn não têm vaga colorida. Eles aparecem só na lista "Rótulos do GitLab" das Notas da tarefa.
- A gravação é feita por Operation Set, com um rótulo por chamada `msdyn_PssCreateV2` e sem id. É a única via que deixa o rótulo visível na UI.

## Buckets por etapa

`bucketForLabels` escolhe o bucket pela etapa mais avançada entre os rótulos da issue. A ordem de prioridade é:

1. Em produção
2. Concluído (Concluída / Homologada)
3. Impedimento
4. Em homologação (Em homologação / Aprovada no teste)
5. Em teste (Em teste / Com defeito / Desenvolvida)
6. Em desenvolvimento
7. Backlog, quando nenhuma das anteriores se aplica

Uma particularidade do Project: um update completo da tarefa (assunto, datas, descrição e bucket) **não move o bucket**, e a resposta não acusa falha. Só um update que contém apenas `msdyn_projectbucket@odata.bind` move a tarefa.

**Pendente:**
- O sync normal ainda não envia esse update separado. Por isso, mudar o rótulo de uma tarefa que já existe não a move de coluna.
- O Timer e o Runner ainda não passam `bucketsByName`. Hoje só o script manual passa.

## Sync manual

```bash
IIDS=793 node scripts/sync-premium-manual.js        # uma issue
IIDS=793,800 node scripts/sync-premium-manual.js    # várias
node scripts/sync-premium-manual.js                 # todas as abertas
node scripts/sync-premium-manual.js Apontamentos    # só as com esse rótulo
```

As variáveis `NOLABELS=1` (pula os rótulos coloridos) e `FORCE=1` (regrava mesmo sem mudança) podem ser combinadas com qualquer um dos comandos acima.

Se aparecer `AADSTS70043`, o token venceu: rode `node scripts/autorizarContaServicoPremium.js` e repita o comando.
