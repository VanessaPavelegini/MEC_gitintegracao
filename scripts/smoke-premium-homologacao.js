"use strict";

// Smoke test da T0 (identidade): a conta de serviço portaldedemandas@mec.gov.br
// consegue CRIAR uma task no plano Premium de homologação usando o token
// delegado (refresh token do device code flow)?
//
// Faz o ciclo completo de escrita do Planner Premium:
//   msdyn_CreateOperationSetV1 → msdyn_PssCreateV2 → msdyn_ExecuteOperationSetV1
// → confere se a task apareceu → apaga a task de teste → descarta o set.
//
// A task de teste é criada APENAS para provar a escrita; o plano do cliente
// fica como estava.
//
// Uso: node scripts/smoke-premium-homologacao.js [--keep]

const fs = require("fs");
const path = require("path");

// Carrega o local.settings.json no ambiente (mesmo padrão dos outros scripts).
const settings = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "local.settings.json"), "utf8")
);
for (const [k, v] of Object.entries(settings.Values || {})) {
  if (v && process.env[k] === undefined) process.env[k] = v;
}

const { getDataverseDelegatedToken } = require("../src/shared/dataverseServiceAccountAuth");
const premium = require("../src/functions/gitlab-planner-sync/premiumDataverse");

const ORG_URL = process.env.DATAVERSE_URL_PREMIUM || "https://orgcf194dda.crm.dynamics.com";
const PLAN_ID = process.env.PREMIUM_HOMOLOGACAO_PLAN_ID || "c385351a-e450-4d54-87ed-d54c57794f7b";
const BUCKET_ID = process.env.PREMIUM_HOMOLOGACAO_BUCKET_ID || "f704c207-84be-f111-a04d-7c1e520d9f67";
const KEEP = process.argv.includes("--keep");

async function main() {
  console.log(`Org:      ${ORG_URL}`);
  console.log(`Plano:    ${PLAN_ID}`);
  console.log(`Bucket:   ${BUCKET_ID}\n`);

  // 1) Token delegado da conta de serviço
  // PREMIUM_TEST_ACCESS_TOKEN permite validar outra identidade sem refazer o
  // device code flow (ex.: `az account get-access-token --resource <org>`).
  const tokenOverride = process.env.PREMIUM_TEST_ACCESS_TOKEN;
  const token = tokenOverride || (await getDataverseDelegatedToken({ orgUrl: ORG_URL }));
  const upn = (() => {
    try {
      const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64").toString("utf8"));
      return payload.upn || payload.preferred_username || payload.name || "(desconhecida)";
    } catch {
      return "(não decodificável)";
    }
  })();
  console.log(`Token obtido. Identidade: ${upn}\n`);

  const subject = `SMOKE-homologacao-${Date.now()}`;

  // 2) Operation set
  const setId = await premium.createOperationSet({
    projectId: PLAN_ID,
    description: `Smoke test ${subject}`,
    token,
    baseUrl: ORG_URL,
  });
  console.log(`OperationSet criado: ${setId}`);

  let taskId = null;
  try {
    // 3) Enfileira a criação da task
    await premium.queueCreateTasks({
      operationSetId: setId,
      entities: [
        {
          "@odata.type": premium.ENTITY_TYPE,
          msdyn_subject: subject,
          msdyn_description: "Task de smoke test — criada e removida automaticamente.",
          msdyn_start: "2026-10-26",
          msdyn_finish: "2026-11-02",
          msdyn_progress: 0,
          "msdyn_project@odata.bind": `/msdyn_projects(${PLAN_ID})`,
          "msdyn_projectbucket@odata.bind": `/msdyn_projectbuckets(${BUCKET_ID})`,
        },
      ],
      token,
      baseUrl: ORG_URL,
    });
    console.log("Task enfileirada no set.");

    // 4) Executa o set (é aqui que a task é realmente criada)
    await premium.executeOperationSet({ operationSetId: setId, token, baseUrl: ORG_URL });
    console.log("Set executado.");

    // 5) Confere se a task apareceu no plano.
    // O Dataverse replica a task com alguns segundos de atraso depois do execute —
    // sem retry, a verificação dá falso negativo.
    let found = {};
    for (let attempt = 0; attempt < 5; attempt++) {
      found = await premium.findTaskIdsBySubjects({
        projectId: PLAN_ID,
        subjects: [subject],
        token,
        baseUrl: ORG_URL,
      });
      if (found && found[subject]) break;
      await new Promise((r) => setTimeout(r, 1500));
    }
    taskId = found[subject] || null;
    console.log(taskId ? `Task criada: ${taskId}` : "Task NÃO encontrada no plano.");
  } finally {
    // 6) Descarta o set (cota de 10 sets vivos por usuário)
    try {
      await premium.discardOperationSet({ operationSetId: setId, token, baseUrl: ORG_URL });
      console.log("OperationSet descartado.");
    } catch (e) {
      console.log(`Falha ao descartar o set: ${e.message}`);
    }
  }

  // 7) Limpa a task de teste.
  // O DELETE direto é recusado pelo Dataverse — a remoção também vai por
  // operation set (msdyn_PssDeleteV2).
  if (taskId && !KEEP) {
    try {
      const delSetId = await premium.createOperationSet({
        projectId: PLAN_ID,
        description: `Remove task de smoke test ${subject}`,
        token,
        baseUrl: ORG_URL,
      });
      try {
        await premium.queueDeleteTasks({
          operationSetId: delSetId,
          entities: [
            {
              "@odata.type": premium.ENTITY_TYPE,
              msdyn_projecttaskid: taskId,
            },
          ],
          token,
          baseUrl: ORG_URL,
        });
        await premium.executeOperationSet({ operationSetId: delSetId, token, baseUrl: ORG_URL });
        console.log(`Task de teste apagada (${taskId}).`);
      } finally {
        try {
          await premium.discardOperationSet({ operationSetId: delSetId, token, baseUrl: ORG_URL });
        } catch {
          /* best effort */
        }
      }
    } catch (e) {
      console.log(`NÃO consegui apagar a task de teste (${taskId}): ${e.message}`);
      console.log("Apagar no Planner UI ou via Dataverse.");
      process.exitCode = 1;
    }
  } else if (taskId) {
    console.log(`Task mantida para inspeção: ${taskId}`);
  }

  if (!taskId) process.exitCode = 1;
}

main().catch((e) => {
  console.error("\nSmoke test falhou:", e.message || e);
  process.exit(1);
});
