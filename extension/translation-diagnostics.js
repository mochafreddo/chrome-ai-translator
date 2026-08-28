(function initTranslationDiagnostics(globalScope) {
  const SCHEMA_VERSION = 3;
  const MAX_RUNS = 20;
  const MAX_PROBLEM_BLOCKS = 100;
  const V2_INDEX_KEY = 'inlineDiagnostics:v2:index';
  const V2_RUN_PREFIX = 'inlineDiagnostics:v2:run:';
  const INDEX_KEY = 'inlineDiagnostics:v3:index';
  const RUN_PREFIX = 'inlineDiagnostics:v3:run:';
  const SECRET_KEY = 'inlineDiagnostics:v2:hmacSecret';
  const CODE_PREFIXES = ['protocol.', 'structure.', 'quality.', 'runtime.'];
  const TIMELINE_STAGES = [
    'initial_validation',
    'repair_validation',
    'runtime_application',
    'local_preflight',
  ];
  const LOCAL_REJECTION_REASONS = [
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

  function nonNegativeCount(value) {
    return Math.max(0, Number(value) || 0);
  }

  function nullableModelRequestAttempts(summary = {}) {
    if (!Object.prototype.hasOwnProperty.call(summary, 'modelRequestAttempts')) return null;
    if (summary.modelRequestAttempts == null) return null;
    if (!Number.isFinite(Number(summary.modelRequestAttempts))) return null;
    return Math.max(0, Number(summary.modelRequestAttempts));
  }

  function projectSummary(summary = {}) {
    return {
      attemptedBlocks: nonNegativeCount(
        summary.attemptedBlocks != null ? summary.attemptedBlocks : summary.requested
      ),
      translatedBlocks: nonNegativeCount(
        summary.translatedBlocks != null ? summary.translatedBlocks : summary.translated
      ),
      translatedWithWarningBlocks: nonNegativeCount(
        summary.translatedWithWarningBlocks != null
          ? summary.translatedWithWarningBlocks
          : summary.translatedWithWarning
      ),
      failedBlocks: nonNegativeCount(
        summary.failedBlocks != null ? summary.failedBlocks : summary.failed
      ),
      changedBlocks: nonNegativeCount(
        summary.changedBlocks != null ? summary.changedBlocks : summary.changed
      ),
      repairAttemptedBlocks: nonNegativeCount(
        summary.repairAttemptedBlocks != null ? summary.repairAttemptedBlocks : summary.repairs
      ),
      modelRequestAttempts: nullableModelRequestAttempts(summary),
    };
  }

  function safeCode(value, fallback = 'runtime.request_failed') {
    const code = String(value || '');
    return CODE_PREFIXES.some((prefix) => code.startsWith(prefix))
      ? code.slice(0, 80)
      : fallback;
  }

  function safeCodes(values) {
    return Array.from(new Set((values || []).map((value) => safeCode(value)))).slice(0, 8);
  }

  function safeEvidence(value = {}) {
    const allowed = {};
    for (const key of [
      'sourceChars', 'outputChars', 'sharedEnglishSequenceLength',
      'sharedEnglishSequenceCount', 'sourceProseWordCount', 'outputLetterCount',
      'outputHangulCount', 'expectedTokenCount', 'returnedTokenCount', 'recordCost',
      'sessionCost', 'limit',
    ]) {
      if (Number.isFinite(value[key])) allowed[key] = Math.max(0, Number(value[key]));
    }
    return allowed;
  }

  function serializeLocalRejection(value) {
    if (!value || typeof value !== 'object') return null;
    const reason = LOCAL_REJECTION_REASONS.includes(value.reason) ? value.reason : '';
    if (!reason) return null;
    const tag = typeof value.tag === 'string' && /^[A-Z][A-Z0-9]{0,31}$/.test(value.tag)
      ? value.tag
      : '';
    return tag ? { reason, tag } : { reason };
  }

  function serializeProblemBlock(block = {}) {
    const terminalDisposition = ['apply', 'apply_with_warning', 'reject', 'changed'].includes(block.terminalDisposition)
      ? block.terminalDisposition
      : 'reject';
    const localRejection = serializeLocalRejection(block.localRejection);
    return {
      diagnosticId: String(block.diagnosticId || '').slice(0, 80),
      parentRunId: String(block.parentRunId || '').slice(0, 80),
      parentDiagnosticId: String(block.parentDiagnosticId || '').slice(0, 80),
      sourceFingerprint: String(block.sourceFingerprint || '').slice(0, 100),
      contractFingerprint: String(block.contractFingerprint || '').slice(0, 100),
      terminalCode:
        terminalDisposition === 'apply' && !block.terminalCode
          ? ''
          : safeCode(block.terminalCode),
      terminalDisposition,
      attemptCount: Math.min(2, Math.max(1, Number(block.attemptCount) || 1)),
      structure: {
        status: ['safe', 'unsafe'].includes(block.structure?.status)
          ? block.structure.status
          : 'unknown',
        codes: safeCodes(block.structure?.codes),
      },
      quality: {
        status: ['complete', 'partial', 'uncertain'].includes(block.quality?.status)
          ? block.quality.status
          : 'uncertain',
        codes: safeCodes(block.quality?.codes),
        evidence: safeEvidence(block.quality?.evidence),
      },
      ...(localRejection ? { localRejection } : {}),
      timeline: (block.timeline || []).slice(0, 2).map((entry) => ({
        stage: TIMELINE_STAGES.includes(entry.stage)
          ? entry.stage
          : 'initial_validation',
        disposition: ['apply', 'apply_with_warning', 'retry', 'reject', 'changed'].includes(entry.disposition)
          ? entry.disposition
          : 'reject',
        codes: safeCodes(entry.codes),
      })),
    };
  }

  function exportDiagnostics(runs = []) {
    return {
      schemaVersion: SCHEMA_VERSION,
      runs: runs.slice(0, MAX_RUNS).map((run) => ({
        schemaVersion: SCHEMA_VERSION,
        runId: String(run.runId || '').slice(0, 80),
        startedAt: String(run.startedAt || ''),
        finishedAt: String(run.finishedAt || ''),
        extensionVersion: String(run.extensionVersion || '').slice(0, 40),
        model: String(run.model || '').slice(0, 80),
        targetLanguageCode: String(run.targetLanguageCode || '').slice(0, 16),
        idempotencyFingerprint: /^hmac-sha256:[A-Za-z0-9_-]{43}$/.test(run.idempotencyFingerprint || '')
          ? run.idempotencyFingerprint
          : '',
        outcome: ['done', 'partial', 'failed', 'changed', 'interrupted'].includes(run.outcome)
          ? run.outcome
          : 'interrupted',
        summary: projectSummary(run.summary),
        blocks: (run.blocks || []).slice(0, MAX_PROBLEM_BLOCKS).map(serializeProblemBlock),
      })),
    };
  }

  function base64Url(bytes) {
    if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64url');
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }

  // Reading the record back is the one thing here that neither signs nor writes: it takes
  // the Chrome it reads through per call, keeps nothing between calls, and so stays on the
  // module rather than moving behind a construction. The options page calls only this.
  async function loadDiagnostics(chromeApi) {
    const stored = await chromeApi.storage.local.get(null);
    const v3Ids = Array.isArray(stored[INDEX_KEY]) ? stored[INDEX_KEY] : [];
    const v2Ids = Array.isArray(stored[V2_INDEX_KEY]) ? stored[V2_INDEX_KEY] : [];
    const seen = new Set();
    const runs = [];
    for (const id of [...v3Ids, ...v2Ids]) {
      if (!id || seen.has(id)) continue;
      const record = stored[`${RUN_PREFIX}${id}`] || stored[`${V2_RUN_PREFIX}${id}`];
      if (!record) continue;
      seen.add(id);
      runs.push(record);
      if (runs.length === MAX_RUNS) break;
    }
    return exportDiagnostics(runs);
  }

  // Everything that signs or writes, with the crypto it signs with handed over.
  //
  // A construction owns the three pieces of long-lived state this half of the module runs
  // on: the installation secret every fingerprint is keyed with, the cache of imported HMAC
  // keys, and the promise chain that serializes writes so two runs never read the same
  // index and write over each other. They were the module's before, which left no caller
  // able to ask for a fresh secret and an empty cache — the position the worker was in
  // before #42 handed it a platform. A second construction is now a second such module,
  // carrying nothing over from the first.
  //
  // Chrome stays a per-call argument. Only the crypto is constructed with, because only the
  // crypto is what a caller has to be able to substitute to see a signing failure.
  function createTranslationDiagnostics(cryptoApi = null) {
    let installSecretPromise = null;
    let storageMutation = Promise.resolve();
    const hmacKeyPromises = new WeakMap();

    function getCrypto() {
      if (!cryptoApi) throw new Error('This diagnostics module was built without crypto');
      return cryptoApi;
    }

    async function fingerprint(secretBytes, value) {
      let keyPromise = hmacKeyPromises.get(secretBytes);
      if (!keyPromise) {
        keyPromise = getCrypto().subtle.importKey(
          'raw', secretBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
        ).catch((error) => {
          if (hmacKeyPromises.get(secretBytes) === keyPromise) hmacKeyPromises.delete(secretBytes);
          throw error;
        });
        hmacKeyPromises.set(secretBytes, keyPromise);
      }
      const key = await keyPromise;
      const signature = await getCrypto().subtle.sign(
        'HMAC', key, new TextEncoder().encode(String(value || ''))
      );
      return `hmac-sha256:${base64Url(new Uint8Array(signature))}`;
    }

    async function fingerprintBlock(chromeApi, sourceTemplate, contract) {
      if (!installSecretPromise) {
        installSecretPromise = (async () => {
          const storage = chromeApi.storage.local;
          const stored = await storage.get([SECRET_KEY]);
          let encoded = stored[SECRET_KEY];
          let decode = null;
          try {
            decode = typeof Buffer !== 'undefined'
              ? new Uint8Array(Buffer.from(String(encoded || ''), 'base64url'))
              : new Uint8Array(Array.from(atob(String(encoded || '').replace(/-/g, '+').replace(/_/g, '/')), (char) => char.charCodeAt(0)));
            if (decode.length !== 32) decode = null;
          } catch { decode = null; }
          if (!decode) {
            decode = getCrypto().getRandomValues(new Uint8Array(32));
            encoded = base64Url(decode);
            await storage.set({ [SECRET_KEY]: encoded });
          }
          return decode;
        })().catch((error) => {
          installSecretPromise = null;
          throw error;
        });
      }
      const decode = await installSecretPromise;
      return {
        sourceFingerprint: await fingerprint(decode, String(sourceTemplate || '')),
        contractFingerprint: await fingerprint(decode, JSON.stringify(contract || {})),
      };
    }

    function serializeStorageMutation(work, fallback) {
      const operation = storageMutation.catch(() => {}).then(work).catch(() => fallback);
      storageMutation = operation;
      return operation;
    }

    function validIdempotencyFingerprint(value) {
      return /^hmac-sha256:[A-Za-z0-9_-]{43}$/.test(value || '');
    }

    function getRunWrite(stored, run) {
      const runId = String(run.runId || '');
      const previousV3 = Array.isArray(stored[INDEX_KEY]) ? stored[INDEX_KEY] : [];
      const previousV2 = Array.isArray(stored[V2_INDEX_KEY]) ? stored[V2_INDEX_KEY] : [];
      const v3Uncapped = [runId, ...previousV3.filter((id) => id !== runId)];
      const v2Uncapped = previousV2.slice();
      const kept = [];
      const seen = new Set();
      for (const id of [...v3Uncapped, ...v2Uncapped]) {
        if (!id || seen.has(id)) continue;
        seen.add(id);
        kept.push(id);
        if (kept.length === MAX_RUNS) break;
      }
      const keptSet = new Set(kept);
      const v3Ids = v3Uncapped.filter((id) => keptSet.has(id));
      const v2Ids = v2Uncapped.filter((id) => keptSet.has(id));
      const removal = Object.keys(stored).filter((key) =>
        key === 'inlineTranslationLogs' ||
        key.startsWith('inlineTranslationLogs:') ||
        (key.startsWith(RUN_PREFIX) && !keptSet.has(key.slice(RUN_PREFIX.length))) ||
        (key.startsWith(V2_RUN_PREFIX) && !keptSet.has(key.slice(V2_RUN_PREFIX.length)))
      );
      return {
        v3Ids,
        v2Ids,
        touchV2Index: Array.isArray(stored[V2_INDEX_KEY]) || v2Ids.length > 0,
        removal,
        runId,
        runKey: `${RUN_PREFIX}${runId}`,
        sanitized: exportDiagnostics([run]).runs[0],
      };
    }

    async function writeRun(storage, write) {
      const values = {
        [INDEX_KEY]: write.v3Ids,
        [write.runKey]: write.sanitized,
      };
      if (write.touchV2Index) values[V2_INDEX_KEY] = write.v2Ids;
      await storage.set(values);
      if (write.removal.length && storage.remove) await storage.remove(write.removal);
    }

    async function persistRun(chromeApi, run) {
      return serializeStorageMutation(async () => {
        const storage = chromeApi.storage.local;
        const stored = await storage.get(null);
        await writeRun(storage, getRunWrite(stored, run));
        return { persisted: true };
      }, { persisted: false });
    }

    async function persistRunIdempotent(chromeApi, run) {
      return serializeStorageMutation(async () => {
        const storage = chromeApi.storage.local;
        const stored = await storage.get(null);
        const write = getRunWrite(stored, run);
        const existingRecords = [
          stored[write.runKey],
          stored[`${V2_RUN_PREFIX}${write.runId}`],
        ].filter(Boolean);
        const existingFingerprints = existingRecords
          .map((record) => record.idempotencyFingerprint)
          .filter((value) => validIdempotencyFingerprint(value));
        if (existingFingerprints.some((value) => value !== run.idempotencyFingerprint)) {
          return { persisted: false, conflict: true };
        }
        await writeRun(storage, write);
        return {
          persisted: true,
          duplicate: existingFingerprints.includes(run.idempotencyFingerprint),
        };
      }, { persisted: false });
    }

    async function discardRun(chromeApi, runId) {
      const operation = storageMutation.catch(() => {}).then(async () => {
        const storage = chromeApi.storage.local;
        const stored = await storage.get([INDEX_KEY, V2_INDEX_KEY]);
        const normalizedRunId = String(runId || '');
        const v3Ids = (Array.isArray(stored[INDEX_KEY]) ? stored[INDEX_KEY] : [])
          .filter((id) => id !== normalizedRunId);
        const v2Ids = (Array.isArray(stored[V2_INDEX_KEY]) ? stored[V2_INDEX_KEY] : [])
          .filter((id) => id !== normalizedRunId);
        const values = { [INDEX_KEY]: v3Ids };
        if (Array.isArray(stored[V2_INDEX_KEY])) values[V2_INDEX_KEY] = v2Ids;
        await storage.set(values);
        if (storage.remove) {
          await storage.remove([`${RUN_PREFIX}${normalizedRunId}`, `${V2_RUN_PREFIX}${normalizedRunId}`]);
        }
        return { discarded: true };
      }).catch(() => ({ discarded: false }));
      storageMutation = operation;
      return operation;
    }

    return {
      discardRun,
      fingerprint,
      fingerprintBlock,
      persistRun,
      persistRunIdempotent,
    };
  }

  const api = {
    SCHEMA_VERSION,
    createTranslationDiagnostics,
    exportDiagnostics,
    loadDiagnostics,
    serializeProblemBlock,
  };
  globalScope.ChromeAiTranslatorDiagnostics = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
