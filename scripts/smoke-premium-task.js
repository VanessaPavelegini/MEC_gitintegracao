"use strict";
// Smoke test: criar 1 task Premium via POST direto em msdyn_projecttasks
// e apagar em seguida. Não grava dado real.
//
// Uso: node scripts/smoke-premium-task.js

const fs = require("fs");
const path = require("path");

const settings = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "local.settings.json"), "utf8")
);
for (const [k, v] of Object.entries(settings.Values || {})) {
  if (v && process.env[k] === undefined) process.env[k] = v;
}

const { getDataverseClient } = require("../src/functions/gitlab-planner-sync/tableStorage");

const PROJ = "8ebc738c-bcb3-f111-aaab-00224836dcc6";

(async () => {
  const c = await getDataverseClient();

  const b = await c.get("/msdyn_projectbuckets", {
    params: { $select: "msdyn_projectbucketid,msdyn_name,msdyn_project", $top: 20 },
  });
  const bucket = b.data.value.find((x) => x.msdyn_project === PROJ) || b.data.value[0];
  console.log(`bucket: ${bucket.msdyn_name} (${bucket.msdyn_projectbucketid})`);

  const body = {
    "msdyn_project@odata.bind": `/msdyn_projects(${PROJ})`,
    "msdyn_projectbucket@odata.bind": `/msdyn_projectbuckets(${bucket.msdyn_projectbucketid})`,
    msdyn_subject: `SMOKE-premium-${Date.now()}`,
  };
  console.log("body enviado:", JSON.stringify(body));

  let taskId;
  try {
    const r = await c.post("/msdyn_projecttasks", { data: body });
    console.log(`\nPOST DIRETO status=${r.status}`);
    taskId = r.data?.msdyn_projecttaskid;
    console.log(`task criada: ${taskId}`);
    console.log(`subject lido de volta: ${r.data?.msdyn_subject}`);
  } catch (e) {
    console.log(`\nPOST DIRETO ERRO status=${e.response?.status}`);
    console.log((e.response?.data?.error?.message || e.message).slice(0, 600));
  }

  if (taskId) {
    try {
      const d = await c.delete(`/msdyn_projecttasks(${taskId})`);
      console.log(`\nDELETE (cleanup) status=${d.status}`);
    } catch (e) {
      console.log(`\nDELETE ERRO ${e.response?.status} — apagar manualmente: ${taskId}`);
    }
  }
})();
