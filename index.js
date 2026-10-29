"use strict";

// Entry point - carrega todas as Azure Functions do diretório src
require("./src/functions/gitlab-planner-sync/syncGitLabPlanner");
require("./src/functions/gitlab-planner-sync/syncGitLabPlannerPremium");
require("./src/functions/gitlab-planner-sync/healthCheck");
require("./src/functions/gitlab-planner-sync/syncGitLabPlannerPremiumHomologacao");
require("./src/functions/gitlab-planner-sync/syncGitLabPlannerPremiumChanges");
require("./src/functions/gitlab-planner-sync/syncGitLabPlannerPremiumTimer");
