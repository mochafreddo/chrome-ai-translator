const assert = require('node:assert/strict');
const diagnostics = require('../extension/translation-diagnostics.js');

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
        quality: { status: 'uncertain', codes: [], evidence: { sourceChars: 10 } },
        source: 'source prose', template: 'translated prose',
        url: 'https://example.com/private', apiKey: 'sk-test-secret',
      });
      const json = JSON.stringify(block);
      for (const secret of ['source prose', 'translated prose', 'https://example.com', 'sk-test']) {
        assert.equal(json.includes(secret), false);
      }
      assert.equal(block.terminalCode, 'structure.token_missing');
    },
  },
  {
    name: 'creates installation-scoped stable HMAC fingerprints',
    async fn() {
      const a = new Uint8Array(32).fill(1);
      const b = new Uint8Array(32).fill(2);
      assert.equal(await diagnostics.fingerprint(a, 'same'), await diagnostics.fingerprint(a, 'same'));
      assert.notEqual(await diagnostics.fingerprint(a, 'same'), await diagnostics.fingerprint(b, 'same'));
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
        'inlineDiagnostics:v2:index': ['provisional', 'kept'],
        'inlineDiagnostics:v2:run:provisional': { outcome: 'interrupted' },
        'inlineDiagnostics:v2:run:kept': { outcome: 'done' },
      };
      const chromeApi = { storage: { local: {
        async get() { return { 'inlineDiagnostics:v2:index': stored['inlineDiagnostics:v2:index'] }; },
        async set(values) { Object.assign(stored, values); },
        async remove(key) { delete stored[key]; },
      } } };

      assert.deepEqual(await diagnostics.discardRun(chromeApi, 'provisional'), { discarded: true });
      assert.deepEqual(stored['inlineDiagnostics:v2:index'], ['kept']);
      assert.equal(stored['inlineDiagnostics:v2:run:provisional'], undefined);
    },
  },
  {
    name: 'repairs idempotent run indexes and replaces corrupt records',
    async fn() {
      const fingerprint = `hmac-sha256:${'A'.repeat(43)}`;
      const runKey = 'inlineDiagnostics:v2:run:local-test';
      const stored = {
        'inlineDiagnostics:v2:index': [],
        [runKey]: {
          runId: 'wrong-run',
          idempotencyFingerprint: fingerprint,
          outcome: 'interrupted',
          summary: { failed: 999 },
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

      assert.deepEqual(await diagnostics.persistRunIdempotent(chromeApi, run), {
        persisted: true,
        duplicate: true,
      });
      assert.deepEqual(stored['inlineDiagnostics:v2:index'], ['local-test']);
      assert.equal(stored[runKey].runId, 'local-test');
      assert.equal(stored[runKey].outcome, 'failed');
      assert.equal(stored[runKey].summary.failed, 1);

      stored[runKey] = { runId: 'local-test', idempotencyFingerprint: 'corrupt', outcome: 'interrupted' };
      assert.deepEqual(await diagnostics.persistRunIdempotent(chromeApi, run), {
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
      assert.equal(exported.summary.changed, 2);
      assert.equal(exported.summary.failed, 0);
    },
  },
];
