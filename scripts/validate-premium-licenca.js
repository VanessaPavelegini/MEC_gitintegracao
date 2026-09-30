"use strict";
// Validação rápida da licença do App User 'app-pnld' no Aplicativos PRD,
// e confirmação de que o Plano Premium (msdyn_project 8ebc738c-...) e os
// 5 buckets criados em 18/09/2026 continuam no Dataverse.
//
// Uso: node scripts/validate-premium-licenca.js
//
// Saída esperada ANTES da licença:
//   user.islicensed: false
//   msdyn_projects('8ebc738c-...'):   msdyn_subject="AutomaçãoTestes" (existe)
// Saída esperada DEPOIS da licença propagada (Entra→Dataverse):
//   user.islicensed: true
//   msdyn_PssCreateV1 (via PATCH em task dummy) deveria voltar 204

const fs = require("fs");
const path = require("path");

const settingsPath = path.join(__dirname, "..", "local.settings.json");
const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
for (const [k, v] of Object.entries(settings.Values || {})) {
  if (v && process.env[k] === undefined) process.env[k] = v;
}

const { getDataverseClient } = require("../src/functions/gitlab-planner-sync/tableStorage");

const APP_USER_ID = "837e9242-c502-f111-8407-00224836c197";
const PREMIUM_PLAN_ID = "8ebc738c-bcb3-f111-aaab-00224836dcc6";

function linha(label, value) {
  console.log(`  ${label.padEnd(34)} ${value}`);
}

(async () => {
  try {
    const client = await getDataverseClient();
    const base = client.defaults.baseURL;
    console.log(`\n[validate] baseURL=${base}\n`);

    // 1. Estado do App User (chechagem direta do isLicensed)
    console.log("[validate] 1) App User 'app-pnld'");
    try {
      const r = await client.get(`/systemusers(${APP_USER_ID})`, {
        params: { $select: "fullname,islicensed,isdisabled,accessmode,applicationid" },
      });
      const u = r.data;
      linha("fullname",       u.fullname);
      linha("applicationId",  u.applicationid);
      linha("accessMode",     `${u.accessmode} (4 = Não Interativo)`);
      linha("isDisabled",     u.isdisabled);
      linha("isLicensed",     u.islicensed);
      if (u.islicensed) {
        console.log("  >> SINAL POSITIVO: App User TEM licença. Pode destravar PssCreateV1/PssUpdateV1.");
      } else {
        console.log("  >> isLicensed=false confirmado. Webhook Premium continua bloqueado.");
        console.log("     Próximo passo humano: admin.microsoft.com → Usuários → app-pnld → Licenças → atribuir Project Plan 3 (~$30/mês).");
      }
    } catch (e) {
      console.log(`  ERRO: ${e.message}`);
      if (e.response?.data) console.log(`  body=${JSON.stringify(e.response.data)}`);
    }

    // 2. Plano Premium 8ebc738c-... ainda existe?
    console.log("\n[validate] 2) Plano Premium existente (msdyn_project)");
    try {
      const r = await client.get(`/msdyn_projects(${PREMIUM_PLAN_ID})`, {
        params: { $select: "msdyn_projectid,msdyn_subject,msdyn_projectstatus,msdyn_projectmode,modifiedon" },
      });
      const p = r.data;
      linha("msdyn_projectid",   p.msdyn_projectid);
      linha("msdyn_subject",     p.msdyn_subject);
      linha("msdyn_projectmode", p.msdyn_projectmode);
      linha("msdyn_projectstatus", p.msdyn_projectstatus);
      linha("modifiedon",        p.modifiedon);
    } catch (e) {
      console.log(`  ERRO: ${e.message}  (status=${e.response?.status})`);
      if (e.response?.status === 404) {
        console.log("  >> Plano foi apagado. Precisaremos recriar no Aplicativos PRD.");
      }
    }

    // 3. Bucket count no plano (esperado 5 se tudo segue igual)
    console.log("\n[validate] 3) Buckets no plano Premium");
    try {
      const r = await client.get("/msdyn_projectbuckets", {
        params: {
          $filter: `_msdyn_project_value eq ${PREMIUM_PLAN_ID}`,
          $top: 50,
          $select: "msdyn_projectbucketid,msdyn_name,msdyn_order",
        },
      });
      const buckets = r.data.value || [];
      linha("count", buckets.length);
      for (const b of buckets.sort((a, b) => (a.msdyn_order || 0) - (b.msdyn_order || 0))) {
        linha(`  order=${b.msdyn_order}`, `${b.msdyn_projectbucketid} | ${b.msdyn_name}`);
      }
    } catch (e) {
      console.log(`  ERRO: ${e.message}`);
    }

    // 4. Smoke test LEVE: tentar listar 1 task. Se 'islicensed=false', leitura talvez passe mas escrita não.
    console.log("\n[validate] 4) Smoke read (msdyn_projecttasks?$top=1)");
    try {
      const r = await client.get("/msdyn_projecttasks", {
        params: {
          $filter: `_msdyn_project_value eq ${PREMIUM_PLAN_ID}`,
          $top: 1,
          $select: "msdyn_projecttaskid",
        },
      });
      linha("status", r.status);
      linha("count", (r.data.value || []).length);
    } catch (e) {
      console.log(`  ERRO: ${e.message}`);
      if (e.response?.data) console.log(`  body=${JSON.stringify(e.response.data)}`);
    }

    console.log("\n[validate] concluído.\n");
  } catch (e) {
    console.error("ERRO fatal:", e.message);
    console.error(e.stack);
    process.exit(1);
  }
})();
