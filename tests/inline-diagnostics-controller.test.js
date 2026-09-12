const assert = require('node:assert/strict');
const protocol = require('../extension/inline-diagnostics-protocol.js');
const controller = require('../extension/inline-diagnostics-controller.js');

const storageDiagnostics = require('../extension/translation-diagnostics.js');

function createPlatform(faults = {}) {
  const local = {};
  const session = {};
  function storage(values, name) {
    return {
      async get() { return structuredClone(values); },
      async set(patch) {
        faults.beforeSet?.(name, patch);
        Object.assign(values, structuredClone(patch));
      },
      async remove(keys) {
        faults.beforeRemove?.(name, keys);
        for (const key of keys) delete values[key];
      },
    };
  }
  const chrome = {
    storage: { local: storage(local, 'local'), session: storage(session, 'session') },
    runtime: { getManifest: () => ({ version: 'test' }) },
  };
  return { chrome, crypto: globalThis.crypto };
}

const context = { tabId: 7, operationId: 12 };
const record = { id: 'b1', template: 'private source prose', atoms: [], contract: {} };
const result = {
  id: 'b1', disposition: 'apply', template: '번역', attemptCount: 1,
  terminalCode: '', messageKey: '',
  diagnostic: { structure: { status: 'safe' }, quality: { status: 'pass' }, timeline: [] },
};

async function beginModel(diagnostics) {
  const run = diagnostics.beginTranslation(context);
  run.describe({ records: [record] });
  run.describe({ model: 'test-model', targetLanguageCode: 'ko' });
  await run.preflight();
  run.modelAttempt();
  return run;
}

async function persistLocal(platform, entries) {
  const diagnostics = controller.createInlineDiagnostics(platform);
  const report = diagnostics.prepareLocal({
    ...context, diagnosticBatchId: '11111111-1111-4111-8111-111111111111', diagnostics: entries,
  });
  assert.ok(report);
  assert.deepEqual(await report.persist({ model: 'test-model', targetLanguageCode: 'ko' }), { ok: true });
  return (await storageDiagnostics.loadDiagnostics(platform.chrome)).runs[0];
}

module.exports = {
  name: 'inline diagnostics controller',
  tests: [
    {
      name: 'records interrupted and completed model work through one run',
      async fn() {
        const platform = createPlatform();
        const diagnostics = controller.createInlineDiagnostics(platform);
        const run = await beginModel(diagnostics);
        const interrupted = (await storageDiagnostics.loadDiagnostics(platform.chrome)).runs[0];
        assert.equal(interrupted.outcome, 'interrupted');
        assert.equal(interrupted.summary.modelRequestAttempts, null);
        const [translated] = await run.complete([result]);
        assert.equal(translated.template, '번역');
        assert.equal(translated.attemptCount, 1);
        assert.equal('diagnostic' in translated, false);
        assert.match(translated.correlationToken, protocol.uuidV4Pattern);
        const payload = await storageDiagnostics.loadDiagnostics(platform.chrome);
        assert.equal(payload.runs.length, 1);
        assert.equal(payload.runs[0].outcome, 'done');
        assert.equal(payload.runs[0].summary.modelRequestAttempts, 1);
        assert.equal(payload.runs[0].summary.translatedBlocks, 1);
        assert.equal(JSON.stringify(payload).includes(record.template), false);
      },
    },
    {
      name: 'records local rejections and refuses replay with changed evidence',
      async fn() {
        const platform = createPlatform();
        const diagnostics = controller.createInlineDiagnostics(platform);
        const message = {
          ...context, diagnosticBatchId: '11111111-1111-4111-8111-111111111111',
          diagnostics: [{ code: 'runtime.session_too_large', evidence: { sessionCost: 150000 } }],
        };
        assert.equal(diagnostics.prepareLocal({ ...message, tabId: null }), null);
        assert.deepEqual(await diagnostics.prepareLocal(message).persist({ model: 'test-model', targetLanguageCode: 'ko' }), { ok: true });
        assert.deepEqual(await diagnostics.prepareLocal(message).persist({ model: 'test-model', targetLanguageCode: 'ko' }), { ok: true });
        const changed = { ...message, diagnostics: [{ code: 'runtime.block_too_large' }] };
        assert.deepEqual(await diagnostics.prepareLocal(changed).persist({ model: 'test-model', targetLanguageCode: 'ko' }), { ok: false });
        const payload = await storageDiagnostics.loadDiagnostics(platform.chrome);
        assert.equal(payload.runs.length, 1);
        assert.equal(payload.runs[0].blocks[0].terminalCode, 'runtime.session_too_large');
        assert.equal(payload.runs[0].blocks[0].timeline[0].stage, 'local_preflight');
        assert.equal(payload.runs[0].summary.modelRequestAttempts, 0);
      },
    },
    {
      name: 'releases a runtime reservation after failed storage and rejects a persisted replay',
      async fn() {
        let rejectRuntime = true;
        const platform = createPlatform({ beforeSet(name, patch) {
          if (name === 'local' && rejectRuntime && Object.keys(patch).some(key => key.startsWith('inlineDiagnostics:v3:run:runtime-'))) {
            throw new Error('runtime storage unavailable');
          }
        } });
        const diagnostics = controller.createInlineDiagnostics(platform);
        const run = await beginModel(diagnostics);
        const [translated] = await run.complete([result]);
        const report = { ...context, outcomes: [{ code: 'runtime.apply_failed', correlationToken: translated.correlationToken }] };
        assert.deepEqual(await diagnostics.recordRuntime(report), { ok: false });
        rejectRuntime = false;
        assert.deepEqual(await diagnostics.recordRuntime(report), { ok: true });
        assert.deepEqual(await diagnostics.recordRuntime(report), { ok: false });
        const payload = await storageDiagnostics.loadDiagnostics(platform.chrome);
        assert.equal(payload.runs.length, 2);
        assert.equal(payload.runs[0].blocks[0].terminalCode, 'runtime.apply_failed');
        assert.equal(payload.runs[0].summary.modelRequestAttempts, null);
      },
    },
    ...[
      { name: 'compact final survives detailed failure', failCompact: false, failDiscard: false, outcome: 'done' },
      { name: 'discard removes a failed compact final', failCompact: true, failDiscard: false, outcome: null },
      { name: 'failed discard can leave the interrupted record', failCompact: true, failDiscard: true, outcome: 'interrupted' },
    ].map(({ name, failCompact, failDiscard, outcome }) => ({
      name,
      async fn() {
        const platform = createPlatform({ beforeSet(name, patch) {
          if (name !== 'local') return;
          const saved = Object.values(patch).find(value => value?.schemaVersion === 3);
          if (saved?.outcome === 'done' && (saved.blocks.length || failCompact)) {
            throw new Error('final write failed');
          }
          if (failDiscard && Array.isArray(patch['inlineDiagnostics:v3:index']) && !saved) {
            throw new Error('discard failed');
          }
        } });
        const diagnostics = controller.createInlineDiagnostics(platform);
        const run = await beginModel(diagnostics);
        run.modelAttempt();
        const [translated] = await run.complete([{ ...result, attemptCount: 2 }]);
        assert.equal(translated.template, '번역');
        assert.equal(translated.disposition, 'apply');
        assert.equal(translated.attemptCount, 2);
        assert.equal(translated.diagnosticsUnavailable, true);
        assert.equal('correlationToken' in translated, false);
        const payload = await storageDiagnostics.loadDiagnostics(platform.chrome);
        assert.equal(payload.runs.length, outcome ? 1 : 0);
        if (outcome) {
          assert.equal(payload.runs[0].outcome, outcome);
          assert.equal(payload.runs[0].blocks.length, 0);
          assert.equal(payload.runs[0].summary.modelRequestAttempts, outcome === 'done' ? 2 : null);
        }
      },
    })),
    {
      name: 'a failed preflight does not prevent a detailed final',
      async fn() {
        const platform = createPlatform({ beforeSet(name, patch) {
          if (name === 'local' && Object.values(patch).some(value => value?.outcome === 'interrupted')) {
            throw new Error('preflight unavailable');
          }
        } });
        const run = await beginModel(controller.createInlineDiagnostics(platform));
        const [translated] = await run.complete([result]);
        assert.equal('diagnosticsUnavailable' in translated, false);
        assert.match(translated.correlationToken, protocol.uuidV4Pattern);
        assert.equal((await storageDiagnostics.loadDiagnostics(platform.chrome)).runs[0].outcome, 'done');
      },
    },
    {
      name: 'a retained runtime write with failed cleanup still releases the reservation',
      async fn() {
        let rejectCleanup = false;
        const platform = createPlatform({ beforeRemove() {
          if (rejectCleanup) throw new Error('eviction unavailable');
        } });
        const diagnostics = controller.createInlineDiagnostics(platform);
        const run = await beginModel(diagnostics);
        const [translated] = await run.complete([result]);
        // This legacy key is one the existing writer must remove after committing a run.
        await platform.chrome.storage.local.set({ inlineTranslationLogs: [] });
        rejectCleanup = true;
        const report = { ...context, outcomes: [{ code: 'runtime.apply_failed', correlationToken: translated.correlationToken }] };
        assert.deepEqual(await diagnostics.recordRuntime(report), { ok: false });
        assert.equal((await storageDiagnostics.loadDiagnostics(platform.chrome)).runs[0].outcome, 'failed');
        rejectCleanup = false;
        assert.deepEqual(await diagnostics.recordRuntime(report), { ok: true });
        assert.deepEqual(await diagnostics.recordRuntime(report), { ok: false });
      },
    },
    {
      name: 'a runtime finalization failure rejects without undoing the stored record',
      async fn() {
        let sessionWrites = 0;
        let watchSession = false;
        const platform = createPlatform({ beforeSet(name) {
          if (name === 'session' && watchSession && ++sessionWrites === 2) {
            throw new Error('finalization failed');
          }
        } });
        const diagnostics = controller.createInlineDiagnostics(platform);
        const run = await beginModel(diagnostics);
        const [translated] = await run.complete([result]);
        watchSession = true;
        const report = { ...context, outcomes: [{ code: 'runtime.apply_failed', correlationToken: translated.correlationToken }] };
        await assert.rejects(diagnostics.recordRuntime(report), /finalization failed/);
        assert.equal((await storageDiagnostics.loadDiagnostics(platform.chrome)).runs[0].outcome, 'failed');
        assert.deepEqual(await diagnostics.recordRuntime(report), { ok: false });
      },
    },
    {
      name: 'records only known model facts on early and attempted-request failures',
      async fn() {
        for (const phase of ['normalize', 'settings', 'key', 'request']) {
          const platform = createPlatform();
          const run = controller.createInlineDiagnostics(platform).beginTranslation(context);
          if (phase !== 'normalize') run.describe({ records: [record] });
          if (['key', 'request'].includes(phase)) run.describe({ model: 'test-model', targetLanguageCode: 'ko' });
          if (phase === 'request') { await run.preflight(); run.modelAttempt(); }
          await run.fail(new Error('private failure text'));
          const payload = await storageDiagnostics.loadDiagnostics(platform.chrome);
          const saved = payload.runs[0];
          assert.equal(saved.summary.attemptedBlocks, phase === 'normalize' ? 0 : 1);
          assert.equal(saved.summary.modelRequestAttempts, phase === 'request' ? 1 : 0);
          assert.equal(saved.model, ['key', 'request'].includes(phase) ? 'test-model' : '');
          assert.equal(saved.targetLanguageCode, '');
          assert.equal(JSON.stringify(payload).includes('private failure text'), false);
        }
      },
    },
    {
      name: 'keeps runtime reports distinct within one millisecond',
      async fn() {
        const platform = createPlatform();
        const diagnostics = controller.createInlineDiagnostics(platform);
        const run = diagnostics.beginTranslation(context);
        run.describe({ records: [record, { ...record, id: 'b2' }], model: 'test-model', targetLanguageCode: 'ko' });
        await run.preflight();
        run.modelAttempt();
        const translated = await run.complete([result, { ...result, id: 'b2' }]);
        const originalNow = Date.now;
        const fixed = Date.now();
        try {
          Date.now = () => fixed;
          for (const item of translated) {
            assert.deepEqual(await diagnostics.recordRuntime({ ...context, outcomes: [{ code: 'runtime.apply_failed', correlationToken: item.correlationToken }] }), { ok: true });
          }
        } finally { Date.now = originalNow; }
        const payload = await storageDiagnostics.loadDiagnostics(platform.chrome);
        const reports = payload.runs.filter(value => value.runId.startsWith(`runtime-${fixed}-`));
        assert.equal(reports.length, 2);
        assert.notEqual(reports[0].runId, reports[1].runId);
      },
    },
    {
      name: 'creates protocol-valid correlation identifiers',
      fn() {
        assert.match(protocol.createUuidV4(globalThis.crypto), protocol.uuidV4Pattern);

        // The path a crypto without `randomUUID` takes — what an older browser hands the
        // content script — has to mint a token the same pattern accepts.
        assert.match(
          protocol.createUuidV4({
            getRandomValues: (bytes) => globalThis.crypto.getRandomValues(bytes),
          }),
          protocol.uuidV4Pattern
        );

        // And a caller with no crypto to mint from is told so rather than handed something
        // the pattern would refuse on the way back in.
        assert.throws(() => protocol.createUuidV4(), /needs the crypto/);
      },
    },
    {
      name: 'bounds local input before fingerprinting and excludes private fields',
      async fn() {
        const platform = createPlatform();
        const saved = await persistLocal(platform, [{
          code: 'runtime.block_too_large', template: 'source',
          contract: { codecVersion: 1, namespace: 'n'.repeat(150), privateField: 'secret' },
          evidence: { recordCost: 13, raw: 'secret' },
        }, { code: 'runtime.untrusted_code', template: 'ignored' }]);
        assert.equal(saved.summary.attemptedBlocks, 1);
        const expected = await storageDiagnostics.createTranslationDiagnostics(platform.crypto)
          .fingerprintBlock(platform.chrome, 'source', { codecVersion: 1, namespace: 'n'.repeat(100) });
        assert.equal(saved.blocks[0].contractFingerprint, expected.contractFingerprint);
        assert.deepEqual(saved.blocks[0].quality.evidence, { recordCost: 13 });
        assert.equal(JSON.stringify(saved).includes('secret'), false);
      },
    },
    {
      name: 'allowlists local rejection metadata and drops forged fields',
      async fn() {
        const platform = createPlatform();
        const saved = await persistLocal(platform, protocol.localRejectionReasons.map(reason => ({
          code: 'runtime.unsupported_block',
          localRejection: { reason, tag: reason === 'custom_element' ? 'MY-WIDGET' : 'P', source: 'private prose', selector: 'div > p' },
        })));
        assert.deepEqual(saved.blocks.map(block => block.localRejection), protocol.localRejectionReasons.map(reason =>
          reason === 'custom_element' ? { reason } : { reason, tag: 'P' }));
        assert.equal(JSON.stringify(saved).includes('private prose'), false);
        assert.equal(JSON.stringify(saved).includes('MY-WIDGET'), false);
        const dropped = await persistLocal(createPlatform(), [
          { code: 'runtime.unsupported_block', localRejection: { reason: 'forged_reason', tag: 'P' } },
          { code: 'runtime.unsupported_block', localRejection: { reason: 'hidden_content', tag: 'p' } },
          { code: 'runtime.unsupported_block', localRejection: { reason: 'hidden_content', tag: 'P'.repeat(40) } },
        ]);
        assert.equal('localRejection' in dropped.blocks[0], false);
        assert.deepEqual(dropped.blocks[1].localRejection, { reason: 'hidden_content' });
        assert.deepEqual(dropped.blocks[2].localRejection, { reason: 'hidden_content' });
      },
    },
    {
      name: 'rejects invalid local input before recording anything',
      async fn() {
        const diagnostics = controller.createInlineDiagnostics();
        for (const entries of [[], [{ code: 'runtime.untrusted_code' }], [{
          code: 'runtime.block_too_large', template: 'x'.repeat(12001), contract: {},
        }]]) {
          assert.equal(diagnostics.prepareLocal({
            ...context, diagnosticBatchId: '11111111-1111-4111-8111-111111111111', diagnostics: entries,
          }), null);
        }
      },
    },
    {
      name: 'caps local record count and payload cost independently of saved detail count',
      async fn() {
        const counted = await persistLocal(createPlatform(), Array.from({ length: 501 }, () => ({ code: 'runtime.block_too_large' })));
        assert.equal(counted.summary.attemptedBlocks, 500);
        assert.equal(counted.blocks.length, 100);
        const bounded = await persistLocal(createPlatform(), Array.from({ length: 6 }, () => ({
          code: 'runtime.block_too_large', template: 'x'.repeat(11998), contract: {},
        })));
        assert.equal(bounded.summary.attemptedBlocks, 5);
      },
    },
    {
      name: 'handles cyclic and malformed local contracts without fingerprinting incomplete source context',
      async fn() {
        const cyclic = {};
        cyclic.entries = [cyclic];
        const malformed = {};
        Object.defineProperty(malformed, 'entries', { get() { throw new Error('malformed'); } });
        const saved = await persistLocal(createPlatform(), [
          { code: 'runtime.unsupported_block', template: 'source', contract: cyclic },
          { code: 'runtime.block_too_large', template: 'unsafe', contract: malformed },
          { code: 'runtime.session_too_large', template: 'source only' },
        ]);
        assert.equal(saved.summary.attemptedBlocks, 3);
        assert.match(saved.blocks[0].sourceFingerprint, /^hmac-sha256:/);
        assert.equal(saved.blocks[1].sourceFingerprint, '');
        assert.equal(saved.blocks[2].sourceFingerprint, '');
      },
    },
  ],
};
