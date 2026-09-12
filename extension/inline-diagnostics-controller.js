(function initInlineDiagnosticsController(globalScope) {
  const protocol = globalScope.ChromeAiTranslatorInlineDiagnosticsProtocol ||
    (typeof module !== 'undefined' && module.exports ? require('./inline-diagnostics-protocol.js') : null);
  const storageDiagnostics = globalScope.ChromeAiTranslatorDiagnostics ||
    (typeof module !== 'undefined' && module.exports ? require('./translation-diagnostics.js') : null);

  const INLINE_RUNTIME_CORRELATION_TTL_MS = 5 * 60 * 1000;
  const INLINE_RUNTIME_CORRELATION_LIMIT = 1000;
  const INLINE_RUNTIME_CORRELATION_STORAGE_KEY = 'inlineRuntimeCorrelations:v1';

  function normalizeInlineRuntimeCorrelationEntries(value) {
    const normalized = Object.create(null);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return normalized;
    for (const [token, entry] of Object.entries(value)) {
      const runId = typeof entry?.runId === 'string' ? entry.runId : '';
      if (
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(token) ||
        !entry || typeof entry !== 'object' || Array.isArray(entry) ||
        !Number.isFinite(entry.expiresAt) || entry.expiresAt <= 0 ||
        !/^run-\d+-[a-z0-9]{1,12}$/.test(runId) ||
        typeof entry.diagnosticId !== 'string' || !entry.diagnosticId.startsWith(`${runId}/`) ||
        !/^hmac-sha256:[A-Za-z0-9_-]{43}$/.test(entry.sourceFingerprint) ||
        !/^hmac-sha256:[A-Za-z0-9_-]{43}$/.test(entry.contractFingerprint) ||
        !/^[A-Za-z0-9._:/-]{1,80}$/.test(entry.model) ||
        !(entry.targetLanguageCode === '' || /^[a-z]{2,16}$/i.test(entry.targetLanguageCode)) ||
        !/^[0-9A-Za-z.-]{0,40}$/.test(entry.extensionVersion) ||
        !(entry.tabId === null || Number.isInteger(entry.tabId)) ||
        !(entry.operationId === null || Number.isInteger(entry.operationId))
      ) continue;
      normalized[token] = entry;
    }
    return normalized;
  }
  function createBlockCountSummary({
    attemptedBlocks = 0,
    translatedBlocks = 0,
    translatedWithWarningBlocks = 0,
    failedBlocks = 0,
    changedBlocks = 0,
    repairAttemptedBlocks = 0,
    modelRequestAttempts = null,
  } = {}) {
    return {
      attemptedBlocks,
      translatedBlocks,
      translatedWithWarningBlocks,
      failedBlocks,
      changedBlocks,
      repairAttemptedBlocks,
      modelRequestAttempts,
    };
  }

  function summarizeBlockBatchResults(results, modelRequestAttempts) {
    return createBlockCountSummary({
      attemptedBlocks: results.length,
      translatedBlocks: results.filter((result) => result.disposition === 'apply').length,
      translatedWithWarningBlocks: results.filter(
        (result) => result.disposition === 'apply_with_warning'
      ).length,
      failedBlocks: results.filter((result) => result.disposition === 'reject').length,
      changedBlocks: 0,
      repairAttemptedBlocks: results.filter((result) => result.attemptCount === 2).length,
      modelRequestAttempts,
    });
  }

  function normalizeLocalDiagnostics(entries) {
    const allowedCodes = new Set(protocol.localCodes);
    const diagnostics = [];
    let payloadCost = 0;
    const boundedString = (value, max = 200) => String(value || '').slice(0, max);
    const copyString = (target, source, key, max) => {
      if (Object.hasOwn(source, key)) target[key] = boundedString(source[key], max);
    };

    for (const entry of (Array.isArray(entries) ? entries : []).slice(0, protocol.limits.maxRecords)) {
      if (!allowedCodes.has(entry?.code)) continue;
      const template = typeof entry.template === 'string' ? entry.template : '';
      let contract = null;
      let contractJson = '';
      if (entry.contract && typeof entry.contract === 'object' && !Array.isArray(entry.contract)) {
        try {
          contract = {};
          if (Object.hasOwn(entry.contract, 'codecVersion')) contract.codecVersion = Number(entry.contract.codecVersion) || 0;
          copyString(contract, entry.contract, 'namespace', 100);
          if (Object.hasOwn(entry.contract, 'entries')) {
            contract.entries = (Array.isArray(entry.contract.entries) ? entry.contract.entries : [])
              .slice(0, protocol.limits.maxRecords)
              .map((item) => {
                const copied = {};
                for (const [key, max] of [
                  ['id', 200], ['kind', 40], ['tagName', 40], ['parentId', 200],
                  ['openToken', 200], ['closeToken', 200], ['token', 200], ['atomKind', 80],
                ]) copyString(copied, item || {}, key, max);
                if (Object.hasOwn(item || {}, 'preserveText')) copied.preserveText = item.preserveText === true;
                return copied;
              });
          }
          if (Object.hasOwn(entry.contract, 'maxOutputChars')) contract.maxOutputChars = Math.max(0, Number(entry.contract.maxOutputChars) || 0);
          if (Object.hasOwn(entry.contract, 'requiresText')) contract.requiresText = entry.contract.requiresText === true;
          if (Object.hasOwn(entry.contract, 'literalTokens')) {
            contract.literalTokens = (Array.isArray(entry.contract.literalTokens) ? entry.contract.literalTokens : [])
              .slice(0, protocol.limits.maxRecords)
              .map((item) => ({ value: boundedString(item?.value), count: Math.max(0, Number(item?.count) || 0) }));
          }
          contractJson = JSON.stringify(contract);
          if (contractJson.length > protocol.limits.maxRecordCost) {
            contract = null;
            contractJson = '';
          }
        } catch {
          contract = null;
          contractJson = '';
        }
      }
      if (template.length > protocol.limits.maxRecordCost) continue;
      const entryCost = template.length + contractJson.length;
      if (entryCost > protocol.limits.maxRecordCost || payloadCost + entryCost > protocol.limits.maxSessionCost) continue;
      payloadCost += entryCost;
      const evidence = {};
      for (const key of ['recordCost', 'sessionCost', 'limit']) {
        if (Number.isFinite(entry.evidence?.[key])) evidence[key] = Math.max(0, Number(entry.evidence[key]));
      }
      const localRejection = protocol.serializeLocalRejection?.(entry.localRejection);
      diagnostics.push({
        code: entry.code,
        ...(template && contract ? { template, contract } : {}),
        evidence,
        ...(localRejection ? { localRejection } : {}),
      });
    }
    return diagnostics;
  }

  // Storage, correlation ownership and failure recovery belong to this construction.
  // Callers report translation facts; they never pass credentials or model execution here.
  function createInlineDiagnostics({ chrome = null, crypto = null } = {}) {
    const translationDiagnostics = storageDiagnostics.createTranslationDiagnostics(crypto);
    const inlineRuntimeCorrelations = new Map();
    let inlineRuntimeCorrelationMutation = Promise.resolve();

    function getChrome() {
      if (!chrome) throw new Error('This worker was built without chrome');
      return chrome;
    }

    async function mutateInlineRuntimeCorrelations(mutator) {
      const operation = inlineRuntimeCorrelationMutation.catch(() => {}).then(async () => {
        // The namespace is asked for rather than required: a worker whose platform carries no
        // session storage keeps its correlations in the map below and still honours a token for
        // as long as it lives. Only surviving its own restart needs the storage. `chrome`
        // itself is required, because every caller that gets this far already has one.
        const session = getChrome().storage?.session;
        const storedValue = session
          ? (await session.get([INLINE_RUNTIME_CORRELATION_STORAGE_KEY]))[INLINE_RUNTIME_CORRELATION_STORAGE_KEY] || {}
          : Object.fromEntries(inlineRuntimeCorrelations);
        const stored = normalizeInlineRuntimeCorrelationEntries(storedValue);
        const result = await mutator(stored);
        if (session) await session.set({ [INLINE_RUNTIME_CORRELATION_STORAGE_KEY]: stored });
        else {
          inlineRuntimeCorrelations.clear();
          for (const [token, entry] of Object.entries(stored)) inlineRuntimeCorrelations.set(token, entry);
        }
        return result;
      });
      inlineRuntimeCorrelationMutation = operation;
      return operation;
    }

    async function issueInlineRuntimeCorrelations(items, context = {}) {
      return mutateInlineRuntimeCorrelations((entries) => {
        const now = Date.now();
        for (const [token, entry] of Object.entries(entries)) {
          if (entry.expiresAt <= now) delete entries[token];
        }
        if (Object.keys(entries).length + items.length > INLINE_RUNTIME_CORRELATION_LIMIT) {
          throw new Error('Inline runtime correlation capacity exceeded');
        }
        const issued = new Map();
        for (const { id, metadata } of items) {
          const token = protocol.createUuidV4(crypto);
          entries[token] = {
            ...metadata,
            tabId: Number.isInteger(context.tabId) ? context.tabId : null,
            operationId: context.operationId ?? null,
            expiresAt: now + INLINE_RUNTIME_CORRELATION_TTL_MS,
          };
          issued.set(id, token);
        }
        return issued;
      });
    }

    // Create before normalization so failures retain only facts the caller has learned.
    // Describe accepted records/model, preflight once, count at each request, then complete
    // or fail once. The caller keeps its try/catch and the original translation error.
    function beginTranslation(correlationContext) {
      const startedAtMs = Date.now();
      const runId = `run-${startedAtMs}-${Math.random().toString(36).slice(2, 8)}`;
      let normalized = [];
      let model = '';
      let targetLanguageCode = '';
      let modelRequestAttempts = 0;

      function describe(metadata) {
        if (Object.hasOwn(metadata, 'records')) normalized = metadata.records;
        if (Object.hasOwn(metadata, 'model')) model = metadata.model;
        if (Object.hasOwn(metadata, 'targetLanguageCode')) targetLanguageCode = metadata.targetLanguageCode;
      }

      async function preflight() {
        await translationDiagnostics.persistRun(chrome, {
          runId,
          startedAt: new Date(startedAtMs).toISOString(),
          model,
          targetLanguageCode,
          outcome: 'interrupted',
          summary: createBlockCountSummary({
            attemptedBlocks: normalized.length,
            modelRequestAttempts: null,
          }),
          blocks: [],
        });
      }

      // Keep this synchronous and at the caller's existing request-counting position.
      function modelAttempt() {
        modelRequestAttempts += 1;
      }

      async function complete(results) {
        let diagnosticsPersisted = true;
        const finalOutcome = results.some((result) => result.disposition === 'reject')
          ? 'failed'
          : results.some((result) => result.disposition === 'apply_with_warning')
            ? 'partial'
            : 'done';
        const finalSummary = summarizeBlockBatchResults(results, modelRequestAttempts);
        async function persistCompactFinal() {
          const persistence = await translationDiagnostics.persistRun(chrome, {
            runId,
            startedAt: new Date(startedAtMs).toISOString(),
            finishedAt: new Date().toISOString(),
            extensionVersion: chrome.runtime?.getManifest?.().version || '',
            model,
            targetLanguageCode,
            outcome: finalOutcome,
            summary: finalSummary,
            blocks: [],
          });
          if (!persistence.persisted) await translationDiagnostics.discardRun(chrome, runId);
          return persistence;
        }
        const correlationsById = new Map();
        const normalizedById = new Map(normalized.map((record) => [record.id, record]));
        try {
          const correlationEntries = await Promise.all(results.map(async (result) => {
            const record = normalizedById.get(result.id);
            const fingerprints = await translationDiagnostics.fingerprintBlock(
              chrome,
              record?.template,
              record?.contract
            );
            return [result.id, {
              runId,
              diagnosticId: `${runId}/${result.id}`,
              ...fingerprints,
              extensionVersion: chrome.runtime?.getManifest?.().version || '',
              model,
              targetLanguageCode,
            }];
          }));
          for (const [id, correlation] of correlationEntries) correlationsById.set(id, correlation);
          const problemResults = results.filter(
            (result) => result.attemptCount === 2 || result.disposition !== 'apply'
          );
          const diagnosticBlocks = problemResults.map((result) => {
            const correlation = correlationsById.get(result.id) || {};
            return {
              diagnosticId: correlation.diagnosticId,
              sourceFingerprint: correlation.sourceFingerprint,
              contractFingerprint: correlation.contractFingerprint,
              terminalCode: result.terminalCode,
              terminalDisposition: result.disposition,
              attemptCount: result.attemptCount,
              structure: result.diagnostic.structure,
              quality: result.diagnostic.quality,
              timeline: result.diagnostic.timeline,
            };
          });
          const persistence = await translationDiagnostics.persistRun(chrome, {
            runId,
            startedAt: new Date(startedAtMs).toISOString(),
            finishedAt: new Date().toISOString(),
            extensionVersion: chrome.runtime?.getManifest?.().version || '',
            model,
            targetLanguageCode,
            outcome: finalOutcome,
            summary: finalSummary,
            blocks: diagnosticBlocks,
          });
          // A compact write cannot restore detailed diagnostics or authorize a token.
          diagnosticsPersisted = persistence.persisted;
          if (!persistence.persisted) await persistCompactFinal();
        } catch {
          // Diagnostics must never change an otherwise valid translation result.
          await persistCompactFinal();
          diagnosticsPersisted = false;
        }
        let issuedTokens = new Map();
        if (diagnosticsPersisted) {
          try {
            issuedTokens = await issueInlineRuntimeCorrelations(
              results
                .filter((result) => correlationsById.has(result.id))
                .map((result) => ({ id: result.id, metadata: correlationsById.get(result.id) })),
              correlationContext
            );
          } catch {
            diagnosticsPersisted = false;
          }
        }
        return results.map(({ diagnostic, ...result }) => ({
          ...result,
          ...(issuedTokens.has(result.id)
            ? { correlationToken: issuedTokens.get(result.id) }
            : {}),
          ...(!diagnosticsPersisted ? { diagnosticsUnavailable: true } : {}),
        }));
      }

      async function fail(error) {
        await translationDiagnostics.persistRun(chrome, {
          runId,
          startedAt: new Date(startedAtMs).toISOString(),
          finishedAt: new Date().toISOString(),
          model,
          outcome: 'failed',
          summary: createBlockCountSummary({
            attemptedBlocks: normalized.length,
            failedBlocks: normalized.length,
            modelRequestAttempts,
          }),
          blocks: [{
            diagnosticId: `${runId}/request`,
            terminalCode: error?.code || 'runtime.request_failed',
            terminalDisposition: 'reject',
            attemptCount: 1,
            timeline: [{
              stage: 'initial_validation',
              disposition: 'reject',
              codes: [error?.code || 'runtime.request_failed'],
            }],
          }],
        });
      }

      return { describe, preflight, modelAttempt, complete, fail };
    }

    function prepareLocal({ tabId: senderTabId, operationId, diagnosticBatchId, diagnostics: entries }) {
      diagnosticBatchId = String(diagnosticBatchId || '');
      if (!protocol.uuidV4Pattern.test(diagnosticBatchId) ||
          !Number.isInteger(senderTabId) || !Number.isInteger(operationId)) return null;
      const diagnostics = normalizeLocalDiagnostics(entries);
      if (!diagnostics.length) return null;

      async function persist({ model, targetLanguageCode }) {
        const startedAt = Date.now();
        const runId = `local-${senderTabId}-${operationId}-${diagnosticBatchId}`.slice(0, 80);
        const extensionVersion = chrome.runtime?.getManifest?.().version || '';
        const idempotencyFingerprint = (await translationDiagnostics.fingerprintBlock(
          chrome,
          JSON.stringify({
            diagnostics,
            model,
            targetLanguageCode,
            extensionVersion,
          }),
          {}
        )).sourceFingerprint;
        const blocks = await Promise.all(diagnostics.slice(0, 100).map(async (entry, index) => {
          let fingerprints = {};
          if (typeof entry.template === 'string' && entry.contract) {
            try {
              fingerprints = await translationDiagnostics.fingerprintBlock(
                chrome,
                entry.template,
                entry.contract
              );
            } catch {}
          }
          return {
            diagnosticId: `${runId}/${index}`,
            ...fingerprints,
            terminalCode: entry.code,
            terminalDisposition: 'reject',
            attemptCount: 1,
            quality: { status: 'uncertain', codes: [], evidence: entry.evidence || {} },
            ...(entry.localRejection ? { localRejection: entry.localRejection } : {}),
            timeline: [{
              stage: 'local_preflight',
              disposition: 'reject',
              codes: [entry.code],
            }],
          };
        }));
        const persistence = await translationDiagnostics.persistRunIdempotent(chrome, {
          runId,
          startedAt: new Date(startedAt).toISOString(),
          finishedAt: new Date().toISOString(),
          extensionVersion,
          model,
          targetLanguageCode,
          idempotencyFingerprint,
          outcome: 'failed',
          summary: {
            attemptedBlocks: diagnostics.length,
            failedBlocks: diagnostics.length,
            modelRequestAttempts: 0,
          },
          blocks,
        });
        return { ok: persistence.persisted };
      }
      return { persist };
    }

    async function consumeInlineRuntimeCorrelations(outcomes, releaseTokens, context = {}) {
      return mutateInlineRuntimeCorrelations((entries) => {
        const now = Date.now();
        const resolved = [];
        const tokens = new Set();
        const validated = [];
        const requested = [
          ...outcomes.map((outcome) => ({ token: outcome?.correlationToken, outcome })),
          ...releaseTokens.map((token) => ({ token, outcome: null })),
        ];
        for (const item of requested) {
          const token = String(item.token || '');
          const entry = Object.hasOwn(entries, token) ? entries[token] : null;
          if (
            !token || tokens.has(token) || !entry || entry.expiresAt <= now || entry.reservedAt ||
            entry.tabId !== (Number.isInteger(context.tabId) ? context.tabId : null) ||
            entry.operationId !== (context.operationId ?? null)
          ) return null;
          tokens.add(token);
          validated.push({ token, outcome: item.outcome, entry });
        }
        if (validated.some(({ entry }) => entry.runId !== validated[0].entry.runId)) return null;
        for (const item of validated) {
          if (item.outcome) {
            item.entry.reservedAt = now;
            resolved.push(item);
          } else delete entries[item.token];
        }
        return resolved;
      });
    }

    async function finalizeInlineRuntimeCorrelations(resolved, persisted) {
      return mutateInlineRuntimeCorrelations((entries) => {
        for (const { token } of resolved) {
          if (persisted) delete entries[token];
          else if (entries[token]) delete entries[token].reservedAt;
        }
      });
    }

    // Runtime record identity tolerates missing crypto; signing and token issuance do not.
    function createRuntimeDiagnosticId(startedAt) {
      const suffix = typeof crypto?.randomUUID === 'function'
        ? crypto.randomUUID()
        : Math.random().toString(36).slice(2, 12);
      return `runtime-${startedAt}-${suffix}`;
    }

    async function recordRuntime(message) {
      const outcomes = Array.isArray(message.outcomes)
        ? message.outcomes.slice(0, protocol.limits.maxRecords)
        : [];
      const releaseTokens = Array.isArray(message.releaseTokens)
        ? message.releaseTokens.slice(0, protocol.limits.maxRecords)
        : [];
      const startedAt = Date.now();
      const runtimeRunId = createRuntimeDiagnosticId(startedAt);
      const changedCount = outcomes.filter(
        (outcome) => outcome?.code === 'runtime.page_changed'
      ).length;
      const failedCount = outcomes.length - changedCount;
      const resolvedOutcomes = await consumeInlineRuntimeCorrelations(outcomes, releaseTokens, {
        tabId: message.tabId,
        operationId: message.operationId ?? null,
      });
      if (!resolvedOutcomes) {
        return { ok: false };
      }
      if (!resolvedOutcomes.length) {
        return { ok: true };
      }
      const firstEntry = resolvedOutcomes[0].entry;
      const persistence = await translationDiagnostics.persistRun(getChrome(), {
        runId: runtimeRunId,
        startedAt: new Date(startedAt).toISOString(),
        finishedAt: new Date().toISOString(),
        extensionVersion: firstEntry.extensionVersion,
        model: firstEntry.model,
        targetLanguageCode: firstEntry.targetLanguageCode,
        outcome: failedCount > 0 ? 'failed' : 'changed',
        summary: createBlockCountSummary({
          attemptedBlocks: outcomes.length,
          failedBlocks: failedCount,
          changedBlocks: changedCount,
          modelRequestAttempts: null,
        }),
        blocks: resolvedOutcomes.map(({ outcome, entry }, index) => ({
          diagnosticId: `${runtimeRunId}/${index}`,
          parentRunId: entry.runId,
          parentDiagnosticId: entry.diagnosticId,
          sourceFingerprint: entry.sourceFingerprint,
          contractFingerprint: entry.contractFingerprint,
          terminalCode: outcome?.code,
          terminalDisposition: outcome?.code === 'runtime.page_changed' ? 'changed' : 'reject',
          attemptCount: 1,
          timeline: [{
            stage: 'runtime_application',
            disposition: outcome?.code === 'runtime.page_changed' ? 'changed' : 'reject',
            codes: [outcome?.code],
          }],
        })),
      });
      await finalizeInlineRuntimeCorrelations(resolvedOutcomes, persistence.persisted);
      return { ok: persistence.persisted };
    }

    return { beginTranslation, prepareLocal, recordRuntime };
  }

  const controller = { createInlineDiagnostics };
  globalScope.ChromeAiTranslatorInlineDiagnosticsController = controller;
  if (typeof module !== 'undefined' && module.exports) module.exports = controller;
})(typeof globalThis !== 'undefined' ? globalThis : this);
