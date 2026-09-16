"use strict";

const axios = require("axios");

// ─── Configurações ─────────────────────────────────────────────────────────────

const GITLAB_URL = process.env.GITLAB_URL || "https://gitlabbuilder.mec.gov.br";
const GITLAB_TOKEN = process.env.GITLAB_TOKEN;
const GITLAB_USER_AGENT = process.env.GITLAB_USER_AGENT || "MECGitIntegration";
const GITLAB_PROJECT_ID = process.env.GITLAB_PROJECT_ID || "doc-sis/documentacao-novosistec2";
const GITLAB_BOARD_ID = process.env.GITLAB_BOARD_ID || "92";

// ─── Cliente HTTP ───────────────────────────────────────────────────────────────

function getGitLabClient() {
  if (!GITLAB_TOKEN) {
    throw new Error("GITLAB_TOKEN não configurado nas settings da Function App");
  }

  return axios.create({
    baseURL: `${GITLAB_URL}/api/v4`,
    headers: {
      "PRIVATE-TOKEN": GITLAB_TOKEN,
      "User-Agent": GITLAB_USER_AGENT,
      "Content-Type": "application/json",
    },
    timeout: 15000,
  });
}

// ─── Projetos ─────────────────────────────────────────────────────────────────

/**
 * Obtém o ID numérico do projeto a partir do path
 * @param {string} projectPath - Path do projeto (ex: "doc-sis/documentacao-novosistec2")
 * @returns {Promise<number>} - ID numérico do projeto
 */
async function getProjectId(projectPath) {
  const client = getGitLabClient();
  const path = projectPath || GITLAB_PROJECT_ID;
  const response = await client.get(`/projects/${encodeURIComponent(path)}`);
  return response.data.id;
}

// ─── Issues ───────────────────────────────────────────────────────────────────

/**
 * Obtém detalhes de uma issue pelo IID
 * @param {string|number} iid - Issue IID do GitLab
 * @param {string} projectPath - Path do projeto (opcional)
 * @returns {Promise<object>} - Dados da issue
 */
async function getIssue(iid, projectPath) {
  const client = getGitLabClient();
  const projectId = await getProjectId(projectPath);
  try {
    const response = await client.get(`/projects/${projectId}/issues/${iid}`);
    return response.data;
  } catch (err) {
    const url = `${GITLAB_URL}/api/v4/projects/${projectId}/issues/${iid}`;
    console.error(`[gitlabService] getIssue FAILED: ${err.message} | URL=${url} | status=${err.response?.status} body=${JSON.stringify(err.response?.data)}`);
    throw err;
  }
}

/**
 * Lista issues abertas do projeto
 * @param {object} filters - Filtros { labels, assignee, state }
 * @returns {Promise<Array>} - Lista de issues
 */
async function listIssues(filters = {}) {
  const client = getGitLabClient();
  const projectId = await getProjectId();

  const params = {
    state: filters.state || "opened",
    per_page: 100,
  };

  if (filters.labels) {
    params.labels = Array.isArray(filters.labels) ? filters.labels.join(",") : filters.labels;
  }

  if (filters.assignee) {
    params.assignee_username = filters.assignee;
  }

  const response = await client.get(`/projects/${projectId}/issues`, { params });
  return response.data;
}

// ─── Boards ───────────────────────────────────────────────────────────────────

/**
 * Obtém as listas (buckets) de um board
 * @param {string} projectPath - Path do projeto (opcional)
 * @param {string} boardId - ID do board (opcional)
 * @returns {Promise<Array>} - Lista de listas do board
 */
async function getBoardLists(projectPath, boardId) {
  const client = getGitLabClient();
  const projectId = await getProjectId(projectPath);
  const board = boardId || GITLAB_BOARD_ID;

  const response = await client.get(`/projects/${projectId}/boards/${board}/lists`);
  return response.data;
}

/**
 * Obtém todos os boards do projeto
 * @returns {Promise<Array>} - Lista de boards
 */
async function getBoards() {
  const client = getGitLabClient();
  const projectId = await getProjectId();
  const response = await client.get(`/projects/${projectId}/boards`);
  return response.data;
}

// ─── Labels ───────────────────────────────────────────────────────────────────

/**
 * Lista labels do projeto
 * @returns {Promise<Array>} - Lista de labels
 */
async function getProjectLabels() {
  const client = getGitLabClient();
  const projectId = await getProjectId();

  const response = await client.get(`/projects/${projectId}/labels`, {
    params: { per_page: 100 },
  });

  return response.data;
}

// ─── Utilitários de Mapeamento ────────────────────────────────────────────────

/**
 * Normaliza uma label para comparação
 * @param {string} label
 * @returns {string}
 */
function normalizeLabel(label) {
  return (label || "").toLowerCase().trim()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s-]/g, "");
}

/**
 * Extrai a label de status das labels da issue
 * @param {string[]} labels - Array de labels da issue
 * @returns {string|null} - Label de status ou null
 */
function extractStatusLabel(labels) {
  if (!labels || !Array.isArray(labels) || labels.length === 0) {
    return null;
  }

  // Labels de status conhecidas
  const statusPatterns = [
    "to do", "to-do", "a fazer", "backlog",
    "in progress", "em progresso", "em andamento", "em desenvolvimento",
    "in review", "em revisao", "review", "em revição",
    "em analise", "analise", "analise ",
    "pronto", "done", "concluido", "concluida", "completed",
    "blocked", "bloqueado", "impedido",
  ];

  for (const label of labels) {
    const normalized = normalizeLabel(label);
    for (const pattern of statusPatterns) {
      if (normalized === pattern || normalized.includes(pattern)) {
        return label; // Retorna a label original (case-sensitive)
      }
    }
  }

  return null;
}

/**
 * Mapeia label do GitLab para nome do bucket do Planner
 * @param {string} label - Label do GitLab
 * @returns {string} - Nome do bucket
 */
function mapLabelToBucket(label) {
  if (!label) return "Backlog";

  const normalized = normalizeLabel(label);

  const mapping = {
    // Backlog
    "to do": "Backlog",
    "to-do": "Backlog",
    "a fazer": "Backlog",
    "backlog": "Backlog",

    // Análise
    "em analise": "Análise",
    "analise": "Análise",
    "análise": "Análise",

    // Em Desenvolvimento
    "in progress": "Em Desenvolvimento",
    "em progresso": "Em Desenvolvimento",
    "em andamento": "Em Desenvolvimento",
    "em desenvolvimento": "Em Desenvolvimento",
    "desenvolvimento": "Em Desenvolvimento",
    "coding": "Em Desenvolvimento",

    // Revisão
    "in review": "Revisão",
    "em revisao": "Revisão",
    "review": "Revisão",
    "pr": "Revisão",
    "qa": "Revisão",

    // Pronto / Concluído
    "pronto": "Pronto",
    "ready": "Pronto",
    "done": "Pronto",
    "concluido": "Pronto",
    "concluida": "Pronto",
    "completed": "Pronto",

    // Bloqueado
    "blocked": "Bloqueado",
    "bloqueado": "Bloqueado",
    "impedido": "Bloqueado",
  };

  return mapping[normalized] || "Backlog";
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  getGitLabClient,
  getProjectId,
  getIssue,
  listIssues,
  getBoardLists,
  getBoards,
  getProjectLabels,
  extractStatusLabel,
  mapLabelToBucket,
  normalizeLabel,
  GITLAB_PROJECT_ID,
  GITLAB_BOARD_ID,
  GITLAB_URL,
};
