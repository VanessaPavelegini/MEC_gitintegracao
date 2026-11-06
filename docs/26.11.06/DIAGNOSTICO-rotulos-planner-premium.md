# Diagnóstico: rótulos do GitLab não aparecem no Planner Premium

**Data:** 06/11/2026 · **Plano:** `c0ecce95-1107-4343-8c05-bcf7c9a291f8` (org `orgcf194dda`)
**Status:** causa raiz identificada. Correção ainda **não** implementada.

## Resumo

O sync grava a associação de rótulo, reporta sucesso, e o rótulo **não aparece
no cartão do Planner**. Não é falha de escrita: é que a via de escrita usada
cria um registro que a interface do Planner não enxerga.

## O fato que decide

A interface do Planner filtra as associações de rótulo pelo campo
`_msdyn_pfwcreatedby_value` ("Project for the Web"). Registro com o campo
populado aparece; registro com o campo nulo **não aparece** — mesmo sendo
team-owned e legível pela API.

Medido na task #226 (`ea651273-d774-4733-8dd4-5e8a9713452d`), 05/11/2026:

| registro | rótulo | `_msdyn_pfwcreatedby_value` | aparece na UI |
|---|---|---|---|
| `cfcaee6c` | SPRINT 5 | **populado** | **sim** |
| `849366c7` | SPRINT 18 | null | não |
| `f8e0f3a9` | SPRINT 20 | null | não |
| `0f9d391b` | SPRINT 23 | null | não |
| `63e46036` | (5f8497d9) | null | não |

O único registro com `pfw` populado é o único que a UI mostra.

## Qual tabela a interface lê

A interface lê de **`msdyn_projecttasktolabels`** (a entidade de associação),
não da tabela M2M `msdyn_msdyn_projectlabel_msdyn_projecttaskset`.

- `msdyn_projecttasktolabels` → 3.481 associações em 2.916 tasks (fonte da UI).
- `msdyn_msdyn_projectlabel_msdyn_projecttaskset` → **1 registro** no sistema
  inteiro. A navegação `msdyn_projecttasks(id)/msdyn_msdyn_projectlabel_msdyn_projecttask`
  devolve só esse.

Um diff anterior do trabalho migrou a leitura para a tabela M2M. **Esse diff foi
descartado** — a M2M não é a tabela que a UI consulta.

## Vias de escrita: o que funciona e o que não

| Via | Resultado |
|---|---|
| `POST /msdyn_projecttasktolabels` | 404 `Resource not found for the segment` — Create direto bloqueado |
| `POST /msdyn_projecttasks({id})/msdyn_projecttask_projecttasktolabel` (navegação) | **Grava**, mas o registro nasce com `pfw` nulo → **invisível na UI** |
| `POST /msdyn_projecttasks({id})/msdyn_msdyn_projectlabel_msdyn_projecttask/$ref` (M2M) | Grava na M2M, que a UI não lê |
| **`msdyn_CreateOperationSetV1` → `msdyn_PssCreateV2` → `msdyn_ExecuteOperationSetV1`** | **Grava com `pfw` populado e team-owned → visível na UI** |

A via Operation Set é a que funciona. O payload:

```js
{
  "@odata.type": "Microsoft.Dynamics.CRM.msdyn_projecttasktolabel",
  msdyn_name: "SPRINT 24",
  "msdyn_ProjectLabelId@odata.bind": `/msdyn_projectlabels(${labelId})`,
  "msdyn_ProjectTaskId@odata.bind": `/msdyn_projecttasks(${taskId})`,
}
```

Validado com SPRINT 24 e SPRINT 25: criados via operation set e **confirmados
na interface** do Planner.

## Remoção: bloqueada em quase tudo

| Via | Resultado |
|---|---|
| `DELETE /msdyn_projecttasktolabels({id})` | `0x80040265` — "Cannot directly perform Delete operation" |
| `DELETE` na coleção de navegação | `405` — "Operation not supported on msdyn_projectlabel" |
| `DELETE /msdyn_msdyn_projectlabel_msdyn_projecttaskset({id})` | `0x80040800` — "Delete method does not support entities of type ..." |
| `msdyn_PssDeleteV2` | funciona **só** em registros com `pfw` populado; nos demais, `E_INVALIDENTITYUID` |

Ou seja: registro criado via navegação **não é removível por nenhuma API** —
resta a remoção pela interface do Project. Por isso o sync hoje só **adiciona**
rótulos e reporta em `stale` os que sobraram (a lógica está correta e deve
continuar assim).

## Resíduo deixado pelos testes

Os testes das últimas horas deixaram associações órfãs (criadas via navegação,
`pfw` nulo, indeletáveis por API): 18 tasks com associação duplicada e 3.450
registros legados com nome nulo. Limpeza manual na interface do Project.

## Correção a implementar

1. `listTaskLabelAssociations` / `listTaskLabelAssociationsForTasks` voltam a ler
   de `msdyn_projecttasktolabels` (a entidade de associação), selecionando
   `_msdyn_projectlabelid_value` e `_msdyn_projecttaskid_value`.
2. `synchronizeTaskLabels` passa a criar a associação por **operation set**
   (`msdyn_PssCreateV2`), não mais pela coleção de navegação.
3. A remoção de rótulo stale continua sendo só relatório — o delete por
   `msdyn_PssDeleteV2` só alcança registros com `pfw` populado, o que não é
   garantido para o存量 herdado.

Risco a considerar na implementação: a cota é de **10 operation sets vivos por
usuário**. Criar um set por task estoura a cota; o batch de rótulos tem de
usar um set por lote (ou reaproveitar o set das tasks).

## Como isto foi diagnosticado

Scripts descartáveis em `/tmp/diag*.js` (não versionados), contra a org
`orgcf194dda.crm.dynamics.com`, usando o token de `dataverseServiceAccountAuth`.
