"use strict";

// Lock de execução exclusiva para o sync do Planner Premium.
//
// Motivo: o sync NÃO é idempotente no momento da criação. Duas execuções
// simultâneas podem ver a mesma issue sem mapping e criar DUAS tasks (o
// mapping só é gravado depois que a task materializa). Com o timer de 30 min
// rodando sozinho isso era raro; com o timer + execução manual, a janela
// de colisão deixa de ser hipotética.
//
// A trava é um blob de nome fixo. Criar o blob é atômico (o Armazenamento
// responde 409 se já existe), então o primeiro a criar ganha.
//
// Quando a trava já existe e EXPIROU (o processo morreu no meio), a tomada
// usa compare-and-swap por etag: se o dono original renovou a trava entre a
// leitura e a escrita, o etag não confere mais e a escrita é recusada
// (412). Sem isso, dois processos expirados poderiam trocar a trava um do
// outro ao mesmo tempo.
//
// O blob carrega o instante de expiração — se o processo morrer, a trava
// expira sozinha e a próxima execução assume.

const DEFAULT_TTL_MS = 10 * 60 * 1000; // 10 min

/**
 * @param {object} args
 * @param {object} args.blobClient  { upload, downloadToBuffer, getProperties, delete }
 * @param {string} args.owner       quem está tentando travar (para diagnóstico)
 * @param {number} [args.ttlMs]
 * @param {number} [args.now]       timestamp atual (injetável em teste)
 * @returns {Promise<{acquired: boolean, reason?: string, expiresAt?: number}>}
 */
async function acquireLock({ blobClient, owner = "desconhecido", ttlMs = DEFAULT_TTL_MS, now = Date.now() }) {
  const expiresAt = now + ttlMs;
  const payload = JSON.stringify({ owner, acquiredAt: new Date(now).toISOString(), expiresAt });

  // 1) Tenta criar do zero. Se já existe, o Armazenamento responde 409.
  try {
    await uploadBlob(blobClient, payload, { conditions: { ifNoneMatch: "*" } });
    return { acquired: true, expiresAt };
  } catch (e) {
    if (!isAlreadyExists(e)) throw e;
  }

  // 2) Já existe. Lê o conteúdo e o etag para saber se expirou.
  let current = null;
  let etag = null;
  try {
    const buffer = await blobClient.downloadToBuffer();
    current = JSON.parse(buffer.toString("utf8"));
  } catch {
    // Blob ilegível (corrompido): trata como expirado.
    current = null;
  }
  try {
    const props = await blobClient.getProperties();
    etag = props?.etag || null;
  } catch {
    etag = null;
  }

  if (current && typeof current.expiresAt === "number" && current.expiresAt > now) {
    return {
      acquired: false,
      reason: `trava em uso por ${current.owner || "outro processo"} (expira em ${new Date(current.expiresAt).toISOString()})`,
      expiresAt: current.expiresAt,
    };
  }

  // 3) Trava expirada: toma com compare-and-swap por etag. Se o dono
  // original renovou a trava no meio do caminho, o etag não confere e a
  // escrita é recusada — não roubamos a trava de quem está ativo.
  try {
    await uploadBlob(blobClient, payload, etag ? { conditions: { ifMatch: etag } } : { overwrite: true });
    return { acquired: true, expiresAt };
  } catch (e) {
    if (isAlreadyExists(e)) {
      return { acquired: false, reason: "outro processo tomou a trava" };
    }
    if (isPreconditionFailed(e)) {
      return { acquired: false, reason: "a trava foi renovada por outro processo no meio da troca" };
    }
    throw e;
  }
}

/**
 * Libera a trava. Falha de liberação não pode derrubar o sync — a TTL
 * cobre o caso de o processo morrer antes de liberar.
 */
async function releaseLock({ blobClient }) {
  try {
    await blobClient.delete();
    return true;
  } catch {
    return false;
  }
}

/**
 * upload do SDK do Armazenamento: (body, contentLength, options).
 */
async function uploadBlob(blobClient, body, options) {
  const length = Buffer.byteLength(body);
  return blobClient.upload(body, length, options);
}

function isAlreadyExists(e) {
  const code = e?.statusCode ?? e?.code ?? e?.details?.errorCode;
  return code === 409 || code === "BlobAlreadyExists" || code === "ResourceExists";
}

function isPreconditionFailed(e) {
  const code = e?.statusCode ?? e?.code ?? e?.details?.errorCode;
  return code === 412 || code === "ConditionNotMet";
}

module.exports = { acquireLock, releaseLock, DEFAULT_TTL_MS };
