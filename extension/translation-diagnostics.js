(function initTranslationDiagnostics(globalScope) {
  const SCHEMA_VERSION = 2;
  const MAX_RUNS = 20;
  const MAX_PROBLEM_BLOCKS = 100;
  const INDEX_KEY = 'inlineDiagnostics:v2:index';
  const RUN_PREFIX = 'inlineDiagnostics:v2:run:';
  const SECRET_KEY = 'inlineDiagnostics:v2:hmacSecret';
  const CODE_PREFIXES = ['protocol.', 'structure.', 'quality.', 'runtime.'];

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

  function serializeProblemBlock(block = {}) {
    const terminalDisposition = ['apply', 'apply_with_warning', 'reject', 'changed'].includes(block.terminalDisposition)
      ? block.terminalDisposition
      : 'reject';
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
      timeline: (block.timeline || []).slice(0, 2).map((entry) => ({
        stage: ['initial_validation', 'repair_validation', 'runtime_application'].includes(entry.stage)
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
        summary: {
          requested: Math.max(0, Number(run.summary?.requested) || 0),
          translated: Math.max(0, Number(run.summary?.translated) || 0),
          translatedWithWarning: Math.max(0, Number(run.summary?.translatedWithWarning) || 0),
          failed: Math.max(0, Number(run.summary?.failed) || 0),
          changed: Math.max(0, Number(run.summary?.changed) || 0),
          repairs: Math.max(0, Number(run.summary?.repairs) || 0),
        },
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
    const ids = Array.isArray(stored[INDEX_KEY]) ? stored[INDEX_KEY] : [];
    return exportDiagnostics(ids.map((id) => stored[`${RUN_PREFIX}${id}`]).filter(Boolean));
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

    function getRunWrite(stored, run) {
      const runId = String(run.runId || '');
      const previousIds = Array.isArray(stored[INDEX_KEY]) ? stored[INDEX_KEY] : [];
      const ids = [runId, ...previousIds.filter((id) => id !== runId)].slice(0, MAX_RUNS);
      const removal = Object.keys(stored).filter((key) =>
        key === 'inlineTranslationLogs' ||
        key.startsWith('inlineTranslationLogs:') ||
        (key.startsWith(RUN_PREFIX) && !ids.includes(key.slice(RUN_PREFIX.length)))
      );
      return {
        ids,
        removal,
        runId,
        runKey: `${RUN_PREFIX}${runId}`,
        sanitized: exportDiagnostics([run]).runs[0],
      };
    }

    async function writeRun(storage, write) {
      await storage.set({ [INDEX_KEY]: write.ids, [write.runKey]: write.sanitized });
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
        const existing = stored[write.runKey];
        const validExistingFingerprint = /^hmac-sha256:[A-Za-z0-9_-]{43}$/.test(
          existing?.idempotencyFingerprint || ''
        );
        if (existing && validExistingFingerprint && existing.idempotencyFingerprint !== run.idempotencyFingerprint) {
          return { persisted: false, conflict: true };
        }
        await writeRun(storage, write);
        return { persisted: true, duplicate: Boolean(existing && validExistingFingerprint) };
      }, { persisted: false });
    }

    async function discardRun(chromeApi, runId) {
      const operation = storageMutation.catch(() => {}).then(async () => {
        const storage = chromeApi.storage.local;
        const stored = await storage.get([INDEX_KEY]);
        const normalizedRunId = String(runId || '');
        const ids = Array.isArray(stored[INDEX_KEY])
          ? stored[INDEX_KEY].filter((id) => id !== normalizedRunId)
          : [];
        await storage.set({ [INDEX_KEY]: ids });
        if (storage.remove) await storage.remove(`${RUN_PREFIX}${normalizedRunId}`);
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
