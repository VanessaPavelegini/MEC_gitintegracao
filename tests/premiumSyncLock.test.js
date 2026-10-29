"use strict";

// Testes do lock de execução (premiumSyncLock.js)
//
// O fake reproduz a API REAL do @azure/storage-blob:
//   upload(body, contentLength, options) — 3 argumentos
//   409 quando o blob já existe e a condição é ifNoneMatch "*"
//   412 quando o etag não confere mais (condição ifMatch)

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const { acquireLock, releaseLock } = require(path.join(__dirname, "..", "src", "functions", "gitlab-planner-sync", "premiumSyncLock"));

function fakeBlobClient(initial = null) {
  const state = { content: initial, etag: initial === null ? null : "etag-1", uploads: 0, deletes: 0 };
  const client = {
    state,
    upload: async (body, contentLength, options = {}) => {
      state.uploads += 1;
      const cond = options.conditions || {};
      if (cond.ifNoneMatch === "*" && state.content !== null) {
        const e = new Error("BlobAlreadyExists");
        e.statusCode = 409;
        throw e;
      }
      if (cond.ifMatch && cond.ifMatch !== state.etag) {
        const e = new Error("ConditionNotMet");
        e.statusCode = 412;
        throw e;
      }
      state.content = body;
      state.etag = `etag-${state.uploads}`;
    },
    downloadToBuffer: async () => {
      if (state.content === null) throw new Error("blob não existe");
      return Buffer.from(state.content, "utf8");
    },
    getProperties: async () => ({ etag: state.etag }),
    delete: async () => {
      state.deletes += 1;
      state.content = null;
      state.etag = null;
    },
  };
  return client;
}

test("acquireLock adquire a trava quando o blob não existe", async () => {
  const blob = fakeBlobClient();
  const res = await acquireLock({ blobClient: blob, owner: "timer", now: 1000 });

  assert.equal(res.acquired, true);
  assert.equal(blob.state.uploads, 1);
  const saved = JSON.parse(blob.state.content);
  assert.equal(saved.owner, "timer");
});

test("acquireLock recusa quando a trava está em uso", async () => {
  const original = JSON.stringify({ owner: "outro", expiresAt: 2000 });
  const blob = fakeBlobClient(original);
  const res = await acquireLock({ blobClient: blob, owner: "timer", now: 1000 });

  assert.equal(res.acquired, false);
  assert.match(res.reason, /outro/);
  assert.equal(blob.state.content, original, "a trava de outro processo não pode ser sobrescrita");
});

test("acquireLock toma a trava quando a anterior expirou", async () => {
  const blob = fakeBlobClient(JSON.stringify({ owner: "morto", expiresAt: 1500 }));
  const res = await acquireLock({ blobClient: blob, owner: "timer", now: 2000 });

  assert.equal(res.acquired, true);
  const saved = JSON.parse(blob.state.content);
  assert.equal(saved.owner, "timer");
});

test("acquireLock não rouba a trava se ela foi renewed entre a leitura e a escrita", async () => {
  const blob = fakeBlobClient(JSON.stringify({ owner: "outro", expiresAt: 1500 }));
  // O dono original renova a trava DEPOIS que o etag foi lido: a escrita
  // com ifMatch tem que falhar (412) porque o etag já não confere.
  const originalGetProperties = blob.getProperties;
  let etagLido = null;
  blob.getProperties = async () => {
    const props = await originalGetProperties();
    etagLido = props.etag;
    // renovação concorrente: o conteúdo e o etag mudam agora
    blob.state.content = JSON.stringify({ owner: "outro", expiresAt: 999999 });
    blob.state.etag = "etag-renovado";
    return props;
  };

  const res = await acquireLock({ blobClient: blob, owner: "timer", now: 2000 });

  assert.ok(etagLido, "o etag precisa ter sido lido para a troca ser condicional");
  assert.equal(res.acquired, false, "não pode roubar a trava de quem a renovou");
  assert.match(res.reason, /renovada|outro/i);
});

test("acquireLock guarda a expiração conforme o TTL", async () => {
  const blob = fakeBlobClient();
  const res = await acquireLock({ blobClient: blob, owner: "timer", ttlMs: 60000, now: 1000 });

  assert.equal(res.expiresAt, 61000);
});

test("releaseLock apaga o blob", async () => {
  const blob = fakeBlobClient(JSON.stringify({ owner: "timer", expiresAt: 9999 }));
  const res = await releaseLock({ blobClient: blob });

  assert.equal(res, true);
  assert.equal(blob.state.content, null);
});

test("releaseLock não falha quando o blob já sumiu", async () => {
  const blob = fakeBlobClient();
  blob.delete = async () => {
    throw new Error("blob não existe");
  };
  const res = await releaseLock({ blobClient: blob });

  assert.equal(res, false, "liberação falhada não pode derrubar o sync");
});

test("acquireLock trata blob corrompido como expirado", async () => {
  const blob = fakeBlobClient("isto não é json {{{");
  const res = await acquireLock({ blobClient: blob, owner: "timer", now: 1000 });

  assert.equal(res.acquired, true);
});
