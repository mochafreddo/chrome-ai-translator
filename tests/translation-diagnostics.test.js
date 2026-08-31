const assert = require('node:assert/strict');
const diagnostics = require('../extension/translation-diagnostics.js');

// A signing, writing diagnostics module built with the platform's own crypto. Built per
// check rather than once for the file, because the installation secret, the imported-key
// cache and the write chain belong to a construction: a check that wants a fresh secret and
// an empty cache asks for one here instead of reaching into the module for them.
function createDiagnostics(cryptoApi = globalThis.crypto) {
  return diagnostics.createTranslationDiagnostics(cryptoApi);
}

function createMemoryChrome(stored = {}) {
  const ops = [];
  return {
    stored,
    ops,
    chromeApi: {
      storage: {
        local: {
          async get() { return { ...stored }; },
          async set(values) {
            ops.push({ op: 'set', keys: Object.keys(values).sort() });
            Object.assign(stored, values);
          },
          async remove(keys) {
            const list = Array.isArray(keys) ? keys : [keys];
            ops.push({ op: 'remove', keys: [...list].sort() });
            for (const key of list) delete stored[key];
          },
        },
      },
    },
  };
}

exports.name = 'translation diagnostics';
exports.tests = [
  {
    name: 'allowlists problem fields and removes sensitive values',
    fn() {
      const block = diagnostics.serializeProblemBlock({
        diagnosticId: 'd1',
        terminalCode: 'structure.token_missing',
        terminalDisposition: 'reject',
        attemptCount: 2,
        structure: { status: 'unsafe', codes: ['structure.token_missing'] },
        quality: {
          status: 'uncertain',
          codes: [],
          evidence: {
            sourceChars: 10,
            sourceProseWordCount: 4,
            outputLetterCount: 24,
            outputHangulCount: 0,
            translatedText: 'translated evidence sentinel',
          },
        },
        source: 'source prose', template: 'translated prose',
        url: 'https://example.com/private', apiKey: 'sk-test-secret',
      });
      const json = JSON.stringify(block);
      for (const secret of ['source prose', 'translated prose', 'https://example.com', 'sk-test']) {
        assert.equal(json.includes(secret), false);
      }
      assert.equal(block.terminalCode, 'structure.token_missing');
      assert.equal(block.quality.evidence.sourceProseWordCount, 4);
      assert.equal(block.quality.evidence.outputLetterCount, 24);
      assert.equal(block.quality.evidence.outputHangulCount, 0);
      assert.equal('translatedText' in block.quality.evidence, false);
    },
  },
  {
    name: 'creates installation-scoped stable HMAC fingerprints',
    async fn() {
      const signing = createDiagnostics();
      const a = new Uint8Array(32).fill(1);
      const b = new Uint8Array(32).fill(2);
      assert.equal(await signing.fingerprint(a, 'same'), await signing.fingerprint(a, 'same'));
      assert.notEqual(await signing.fingerprint(a, 'same'), await signing.fingerprint(b, 'same'));
    },
  },
  {
    // A failed import must not poison the key cache: the second call has to try again rather
    // than await the rejection the first one left behind. The crypto that fails once is
    // handed over rather than patched onto the global one, so nothing outside this check
    // sees it and nothing has to be put back afterwards.
    name: 'retries a transient HMAC key import failure',
    async fn() {
      let calls = 0;
      const signing = createDiagnostics({
        subtle: {
          importKey(...args) {
            calls += 1;
            if (calls === 1) return Promise.reject(new Error('transient'));
            return globalThis.crypto.subtle.importKey(...args);
          },
          sign: (...args) => globalThis.crypto.subtle.sign(...args),
        },
      });
      const secret = new Uint8Array(32).fill(9);

      await assert.rejects(signing.fingerprint(secret, 'value'), /transient/);
      assert.match(await signing.fingerprint(secret, 'value'), /^hmac-sha256:/);
      assert.equal(calls, 2);
    },
  },
  {
    // Two constructions share nothing. The first imports a key for the secret Chrome kept
    // and caches it; the second is built with a crypto that cannot import one at all and
    // has to fail on its own account, which it only does if the cache and the secret went
    // with the construction rather than staying on the module.
    name: 'gives each construction its own installation secret and key cache',
    async fn() {
      const stored = {};
      const chromeApi = { storage: { local: {
        async get() { return { ...stored }; },
        async set(values) { Object.assign(stored, values); },
      } } };

      const signed = await createDiagnostics().fingerprintBlock(chromeApi, 'template', {});
      assert.match(signed.sourceFingerprint, /^hmac-sha256:/);

      const second = createDiagnostics({
        getRandomValues: (bytes) => globalThis.crypto.getRandomValues(bytes),
        subtle: {
          importKey: () => Promise.reject(new Error('no key for this construction')),
          sign: (...args) => globalThis.crypto.subtle.sign(...args),
        },
      });
      await assert.rejects(
        second.fingerprintBlock(chromeApi, 'template', {}),
        /no key for this construction/
      );
    },
  },
  {
    // The contract, stated the way the worker's platform states it: a construction handed no
    // crypto says which piece it was built without rather than failing on an undefined
    // property several frames further in.
    name: 'says what a construction with no crypto was built without',
    async fn() {
      const chromeApi = { storage: { local: {
        async get() { return {}; },
        async set() {},
      } } };

      await assert.rejects(
        createDiagnostics(null).fingerprintBlock(chromeApi, 'template', {}),
        /built without crypto/
      );
    },
  },
  {
    name: 'bounds runs and problem blocks',
    fn() {
      const runs = Array.from({ length: 21 }, (_, index) => ({
        runId: `r${index}`,
        blocks: Array.from({ length: 101 }, (_, block) => ({
          diagnosticId: `d${block}`,
          terminalCode: 'quality.english_residue',
          terminalDisposition: 'apply_with_warning',
          attemptCount: 2,
        })),
      }));
      const exported = diagnostics.exportDiagnostics(runs);
      assert.equal(exported.runs.length, 20);
      assert.equal(exported.runs[0].blocks.length, 100);
    },
  },
  {
    name: 'preserves successful repair and changed dispositions',
    fn() {
      const repaired = diagnostics.serializeProblemBlock({
        diagnosticId: 'repaired',
        terminalCode: null,
        terminalDisposition: 'apply',
        attemptCount: 2,
        structure: { status: 'safe', codes: [] },
        quality: { status: 'complete', codes: [], evidence: {} },
        timeline: [
          { stage: 'initial_validation', disposition: 'retry', codes: ['quality.english_residue'] },
          { stage: 'repair_validation', disposition: 'apply', codes: [] },
        ],
      });
      const changed = diagnostics.serializeProblemBlock({
        diagnosticId: 'changed',
        terminalCode: 'runtime.page_changed',
        terminalDisposition: 'changed',
        timeline: [{ stage: 'runtime_application', disposition: 'changed', codes: ['runtime.page_changed'] }],
      });
      assert.equal(repaired.terminalDisposition, 'apply');
      assert.equal(repaired.terminalCode, '');
      assert.equal(repaired.timeline[1].disposition, 'apply');
      assert.equal(changed.timeline[0].disposition, 'changed');
    },
  },
  {
    name: 'keeps a local preflight timeline stage',
    fn() {
      const block = diagnostics.serializeProblemBlock({
        diagnosticId: 'local',
        terminalCode: 'runtime.unsupported_block',
        terminalDisposition: 'reject',
        timeline: [{
          stage: 'local_preflight',
          disposition: 'reject',
          codes: ['runtime.unsupported_block'],
        }],
      });
      assert.equal(block.timeline[0].stage, 'local_preflight');
    },
  },
  {
    name: 'allowlists local rejection reason and tag and drops the rest',
    fn() {
      const kept = diagnostics.serializeProblemBlock({
        diagnosticId: 'd1',
        terminalDisposition: 'reject',
        localRejection: {
          reason: 'unsupported_descendant',
          tag: 'SUMMARY',
          source: 'page prose',
          selector: 'div.article > p',
        },
      });
      assert.deepEqual(kept.localRejection, { reason: 'unsupported_descendant', tag: 'SUMMARY' });
      assert.equal(JSON.stringify(kept).includes('page prose'), false);

      const dropped = diagnostics.serializeProblemBlock({
        diagnosticId: 'd2',
        localRejection: {
          reason: 'forged_reason',
          tag: 'MY-WIDGET',
          path: '/html/body/p',
        },
      });
      assert.equal('localRejection' in dropped, false);
    },
  },
  {
    name: 'exports every local rejection reason and omits unsafe tags',
    fn() {
      const reasons = [
        'invalid_root',
        'hidden_content',
        'editable_content',
        'interactive_content',
        'custom_element',
        'nested_semantic_block',
        'unsupported_descendant',
        'structure_limit_exceeded',
        'empty_content',
      ];
      const exported = diagnostics.exportDiagnostics([{
        runId: 'local-reasons',
        blocks: reasons.map((reason) => ({
          diagnosticId: reason,
          terminalCode: 'runtime.unsupported_block',
          terminalDisposition: 'reject',
          localRejection: {
            reason,
            tag: reason === 'custom_element' ? 'MY-WIDGET' : 'P',
            source: 'page prose',
            extra: true,
          },
        })),
      }]).runs[0];
      assert.deepEqual(
        exported.blocks.map((block) => block.localRejection),
        reasons.map((reason) => (
          reason === 'custom_element' ? { reason } : { reason, tag: 'P' }
        ))
      );
      assert.equal(JSON.stringify(exported).includes('page prose'), false);
      assert.equal(JSON.stringify(exported).includes('MY-WIDGET'), false);

      const malformed = diagnostics.serializeProblemBlock({
        localRejection: { reason: 'hidden_content', tag: 'p' },
      });
      assert.deepEqual(malformed.localRejection, { reason: 'hidden_content' });
    },
  },
  {
    name: 'stamps the schema version on an export with no runs',
    fn() {
      // The options page hands the export straight to the clipboard and to a file, so an
      // empty export still has to say which schema a reader is looking at.
      assert.equal(diagnostics.exportDiagnostics([]).schemaVersion, 3);
    },
  },
  {
    name: 'names every summary count by unit and leaves unknown model attempts null',
    fn() {
      const exported = diagnostics.exportDiagnostics([{
        runId: 'v3-run',
        outcome: 'done',
        summary: {
          attemptedBlocks: 4,
          translatedBlocks: 1,
          translatedWithWarningBlocks: 1,
          failedBlocks: 1,
          changedBlocks: 1,
          repairAttemptedBlocks: 2,
          modelRequestAttempts: 3,
        },
      }]).runs[0];
      assert.equal(exported.schemaVersion, 3);
      assert.equal(exported.summary.attemptedBlocks, 4);
      assert.equal(exported.summary.translatedBlocks, 1);
      assert.equal(exported.summary.translatedWithWarningBlocks, 1);
      assert.equal(exported.summary.failedBlocks, 1);
      assert.equal(exported.summary.changedBlocks, 1);
      assert.equal(exported.summary.repairAttemptedBlocks, 2);
      assert.equal(exported.summary.modelRequestAttempts, 3);
      assert.equal('requested' in exported.summary, false);
      assert.equal('repairs' in exported.summary, false);
      assert.equal(
        diagnostics.exportDiagnostics([{
          runId: 'local-only',
          summary: { attemptedBlocks: 1, failedBlocks: 1, modelRequestAttempts: 0 },
        }]).runs[0].summary.modelRequestAttempts,
        0
      );
      assert.equal(
        diagnostics.exportDiagnostics([{
          runId: 'interrupted',
          summary: { attemptedBlocks: 1, modelRequestAttempts: null },
        }]).runs[0].summary.modelRequestAttempts,
        null
      );
    },
  },
  {
    name: 'projects a schema-2 summary into the v3 export shape',
    fn() {
      const exported = diagnostics.exportDiagnostics([{
        schemaVersion: 2,
        runId: 'legacy',
        outcome: 'partial',
        summary: {
          requested: 3,
          translated: 1,
          translatedWithWarning: 1,
          failed: 1,
          changed: 0,
          repairs: 1,
        },
      }]).runs[0];
      assert.equal(exported.schemaVersion, 3);
      assert.equal(exported.summary.attemptedBlocks, 3);
      assert.equal(exported.summary.translatedBlocks, 1);
      assert.equal(exported.summary.translatedWithWarningBlocks, 1);
      assert.equal(exported.summary.failedBlocks, 1);
      assert.equal(exported.summary.changedBlocks, 0);
      assert.equal(exported.summary.repairAttemptedBlocks, 1);
      assert.equal(exported.summary.modelRequestAttempts, null);
    },
  },
  {
    name: 'exports canonical newest-first run order',
    fn() {
      const exported = diagnostics.exportDiagnostics([
        { runId: 'newest', outcome: 'done' },
        { runId: 'older', outcome: 'done' },
      ]);
      assert.deepEqual(exported.runs.map((run) => run.runId), ['newest', 'older']);
    },
  },
  {
    name: 'discards a provisional run from its record and index',
    async fn() {
      const stored = {
        'inlineDiagnostics:v3:index': ['provisional', 'kept'],
        'inlineDiagnostics:v3:run:provisional': { outcome: 'interrupted' },
        'inlineDiagnostics:v3:run:kept': { outcome: 'done' },
      };
      const chromeApi = { storage: { local: {
        async get() { return { ...stored }; },
        async set(values) { Object.assign(stored, values); },
        async remove(key) {
          for (const item of Array.isArray(key) ? key : [key]) delete stored[item];
        },
      } } };

      assert.deepEqual(await createDiagnostics().discardRun(chromeApi, 'provisional'), { discarded: true });
      assert.deepEqual(stored['inlineDiagnostics:v3:index'], ['kept']);
      assert.equal(stored['inlineDiagnostics:v3:run:provisional'], undefined);
    },
  },
  {
    name: 'repairs idempotent run indexes and replaces corrupt records',
    async fn() {
      const fingerprint = `hmac-sha256:${'A'.repeat(43)}`;
      const runKey = 'inlineDiagnostics:v3:run:local-test';
      const stored = {
        'inlineDiagnostics:v3:index': [],
        [runKey]: {
          runId: 'wrong-run',
          idempotencyFingerprint: fingerprint,
          outcome: 'interrupted',
          summary: { failedBlocks: 999 },
        },
      };
      const chromeApi = { storage: { local: {
        async get() { return { ...stored }; },
        async set(values) { Object.assign(stored, values); },
        async remove(keys) {
          for (const key of Array.isArray(keys) ? keys : [keys]) delete stored[key];
        },
      } } };
      const run = {
        runId: 'local-test',
        idempotencyFingerprint: fingerprint,
        outcome: 'failed',
        summary: { requested: 1, failed: 1 },
        blocks: [],
      };
      const writing = createDiagnostics();

      assert.deepEqual(await writing.persistRunIdempotent(chromeApi, run), {
        persisted: true,
        duplicate: true,
      });
      assert.deepEqual(stored['inlineDiagnostics:v3:index'], ['local-test']);
      assert.equal(stored[runKey].runId, 'local-test');
      assert.equal(stored[runKey].outcome, 'failed');
      assert.equal(stored[runKey].summary.failedBlocks, 1);
      assert.equal(stored[runKey].summary.attemptedBlocks, 1);
      assert.equal(stored[runKey].summary.modelRequestAttempts, null);

      stored[runKey] = { runId: 'local-test', idempotencyFingerprint: 'corrupt', outcome: 'interrupted' };
      assert.deepEqual(await writing.persistRunIdempotent(chromeApi, run), {
        persisted: true,
        duplicate: false,
      });
      assert.equal(stored[runKey].idempotencyFingerprint, fingerprint);
      assert.equal(stored[runKey].outcome, 'failed');
    },
  },
  {
    name: 'preserves changed-only run outcome and summary',
    fn() {
      const exported = diagnostics.exportDiagnostics([{
        runId: 'changed-run',
        outcome: 'changed',
        summary: { requested: 2, changed: 2, failed: 0 },
      }]).runs[0];
      assert.equal(exported.outcome, 'changed');
      assert.equal(exported.summary.changedBlocks, 2);
      assert.equal(exported.summary.failedBlocks, 0);
    },
  },
  {
    name: 'loads schema-2 history through the v3 export shape',
    async fn() {
      const stored = {
        'inlineDiagnostics:v2:index': ['legacy'],
        'inlineDiagnostics:v2:run:legacy': {
          runId: 'legacy',
          startedAt: '2026-08-01T00:00:00.000Z',
          outcome: 'failed',
          summary: { requested: 2, translated: 0, failed: 2, repairs: 0 },
        },
      };
      const payload = await diagnostics.loadDiagnostics(createMemoryChrome(stored).chromeApi);
      assert.equal(payload.schemaVersion, 3);
      assert.equal(payload.runs.length, 1);
      assert.equal(payload.runs[0].runId, 'legacy');
      assert.equal(payload.runs[0].summary.attemptedBlocks, 2);
      assert.equal(payload.runs[0].summary.failedBlocks, 2);
      assert.equal(payload.runs[0].summary.modelRequestAttempts, null);
    },
  },
  {
    name: 'merges mixed history newest first and prefers v3 for a duplicate run id',
    async fn() {
      const stored = {
        'inlineDiagnostics:v2:index': ['older', 'shared'],
        'inlineDiagnostics:v2:run:older': {
          runId: 'older',
          startedAt: '2026-08-01T00:00:00.000Z',
          outcome: 'done',
          summary: { requested: 1, translated: 1 },
        },
        'inlineDiagnostics:v2:run:shared': {
          runId: 'shared',
          startedAt: '2026-08-02T00:00:00.000Z',
          outcome: 'failed',
          summary: { requested: 1, failed: 1 },
        },
        'inlineDiagnostics:v3:index': ['newest', 'shared'],
        'inlineDiagnostics:v3:run:newest': {
          runId: 'newest',
          startedAt: '2026-08-03T00:00:00.000Z',
          outcome: 'done',
          summary: { attemptedBlocks: 1, translatedBlocks: 1, modelRequestAttempts: 1 },
        },
        'inlineDiagnostics:v3:run:shared': {
          runId: 'shared',
          startedAt: '2026-08-02T00:00:00.000Z',
          outcome: 'done',
          summary: { attemptedBlocks: 1, translatedBlocks: 1, modelRequestAttempts: 1 },
        },
      };
      const payload = await diagnostics.loadDiagnostics(createMemoryChrome(stored).chromeApi);
      assert.deepEqual(payload.runs.map((run) => run.runId), ['newest', 'shared', 'older']);
      assert.equal(payload.runs[1].outcome, 'done');
      assert.equal(payload.runs[1].summary.modelRequestAttempts, 1);
    },
  },
  {
    name: 'caps mixed history at twenty unique runs',
    async fn() {
      const stored = { 'inlineDiagnostics:v3:index': [], 'inlineDiagnostics:v2:index': [] };
      for (let index = 0; index < 12; index += 1) {
        const id = `v3-${index}`;
        stored['inlineDiagnostics:v3:index'].push(id);
        stored[`inlineDiagnostics:v3:run:${id}`] = { runId: id, outcome: 'done' };
      }
      for (let index = 0; index < 12; index += 1) {
        const id = `v2-${index}`;
        stored['inlineDiagnostics:v2:index'].push(id);
        stored[`inlineDiagnostics:v2:run:${id}`] = { runId: id, outcome: 'done' };
      }
      const payload = await diagnostics.loadDiagnostics(createMemoryChrome(stored).chromeApi);
      assert.equal(payload.runs.length, 20);
      assert.deepEqual(payload.runs.map((run) => run.runId), [
        ...Array.from({ length: 12 }, (_, index) => `v3-${index}`),
        ...Array.from({ length: 8 }, (_, index) => `v2-${index}`),
      ]);
    },
  },
  {
    name: 'writes only v3 records and keeps the installation HMAC key where it was',
    async fn() {
      const memory = createMemoryChrome({
        'inlineDiagnostics:v2:hmacSecret': 'keep-this-secret-record',
      });
      await createDiagnostics().persistRun(memory.chromeApi, {
        runId: 'fresh',
        outcome: 'done',
        summary: { requested: 1, translated: 1 },
      });
      assert.equal(memory.stored['inlineDiagnostics:v2:hmacSecret'], 'keep-this-secret-record');
      assert.equal(memory.stored['inlineDiagnostics:v3:hmacSecret'], undefined);
      assert.deepEqual(memory.stored['inlineDiagnostics:v3:index'], ['fresh']);
      assert.equal(memory.stored['inlineDiagnostics:v2:index'], undefined);
      assert.equal(memory.stored['inlineDiagnostics:v3:run:fresh'].schemaVersion, 3);
      assert.equal(memory.stored['inlineDiagnostics:v2:run:fresh'], undefined);
    },
  },
  {
    name: 'evicts globally after writing retained indexes and records',
    async fn() {
      const stored = {
        'inlineDiagnostics:v2:index': Array.from({ length: 20 }, (_, index) => `old-${index}`),
      };
      for (let index = 0; index < 20; index += 1) {
        stored[`inlineDiagnostics:v2:run:old-${index}`] = { runId: `old-${index}`, outcome: 'done' };
      }
      const memory = createMemoryChrome(stored);
      await createDiagnostics().persistRun(memory.chromeApi, {
        runId: 'fresh',
        outcome: 'done',
        summary: { attemptedBlocks: 1, translatedBlocks: 1, modelRequestAttempts: 1 },
      });
      assert.equal(memory.ops[0].op, 'set');
      assert.deepEqual(memory.ops[0].keys, [
        'inlineDiagnostics:v2:index',
        'inlineDiagnostics:v3:index',
        'inlineDiagnostics:v3:run:fresh',
      ]);
      assert.equal(memory.ops[1].op, 'remove');
      assert.deepEqual(memory.ops[1].keys, ['inlineDiagnostics:v2:run:old-19']);
      assert.equal(memory.stored['inlineDiagnostics:v3:run:fresh'].runId, 'fresh');
      assert.equal(memory.stored['inlineDiagnostics:v2:run:old-19'], undefined);
      assert.equal(memory.stored['inlineDiagnostics:v2:index'].includes('old-19'), false);
      assert.equal(memory.stored['inlineDiagnostics:v2:index'].length, 19);
    },
  },
  {
    name: 'does not remove evicted records when the retained write fails',
    async fn() {
      const stored = {
        'inlineDiagnostics:v2:index': [
          ...Array.from({ length: 19 }, (_, index) => `keep-${index}`),
          'drop',
        ],
      };
      for (const id of stored['inlineDiagnostics:v2:index']) {
        stored[`inlineDiagnostics:v2:run:${id}`] = { runId: id, outcome: 'done' };
      }
      let removed = false;
      const chromeApi = { storage: { local: {
        async get() { return { ...stored }; },
        async set() { throw new Error('quota'); },
        async remove() { removed = true; },
      } } };
      assert.deepEqual(await createDiagnostics().persistRun(chromeApi, {
        runId: 'fresh',
        outcome: 'done',
      }), { persisted: false });
      assert.equal(removed, false);
      assert.ok(stored['inlineDiagnostics:v2:run:drop']);
    },
  },
  {
    name: 'treats a matching v2 fingerprint as a duplicate represented in v3',
    async fn() {
      const fingerprint = `hmac-sha256:${'B'.repeat(43)}`;
      const memory = createMemoryChrome({
        'inlineDiagnostics:v2:index': ['local-test'],
        'inlineDiagnostics:v2:run:local-test': {
          runId: 'local-test',
          idempotencyFingerprint: fingerprint,
          outcome: 'failed',
          summary: { requested: 1, failed: 1 },
        },
      });
      const result = await createDiagnostics().persistRunIdempotent(memory.chromeApi, {
        runId: 'local-test',
        idempotencyFingerprint: fingerprint,
        outcome: 'failed',
        summary: { requested: 1, failed: 1 },
      });
      assert.deepEqual(result, { persisted: true, duplicate: true });
      assert.equal(memory.stored['inlineDiagnostics:v3:run:local-test'].summary.failedBlocks, 1);
      assert.equal(memory.stored['inlineDiagnostics:v2:run:local-test'].runId, 'local-test');
    },
  },
  {
    name: 'conflicts when the same run id already exists with a different fingerprint',
    async fn() {
      const memory = createMemoryChrome({
        'inlineDiagnostics:v2:index': ['local-test'],
        'inlineDiagnostics:v2:run:local-test': {
          runId: 'local-test',
          idempotencyFingerprint: `hmac-sha256:${'C'.repeat(43)}`,
          outcome: 'failed',
          summary: { requested: 1, failed: 1 },
        },
      });
      const result = await createDiagnostics().persistRunIdempotent(memory.chromeApi, {
        runId: 'local-test',
        idempotencyFingerprint: `hmac-sha256:${'D'.repeat(43)}`,
        outcome: 'failed',
        summary: { requested: 1, failed: 1 },
      });
      assert.deepEqual(result, { persisted: false, conflict: true });
      assert.equal(memory.stored['inlineDiagnostics:v3:run:local-test'], undefined);
      assert.equal(
        memory.stored['inlineDiagnostics:v2:run:local-test'].idempotencyFingerprint,
        `hmac-sha256:${'C'.repeat(43)}`
      );
    },
  },
];
