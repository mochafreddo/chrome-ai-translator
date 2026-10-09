// The Inline Translation Session: one page visit, and what outlives each Inline Translation
// Operation within it. The Session Budget, the translation cache buckets, the Semantic Blocks
// the visit translated, the Inline Translation status and the operation id all live here, so
// no operation hands any of them to the next. So does every Semantic Block state change:
// admitting a block, taking a batch, settling it, page-change retries, stop and restore.
//
// The session is kept on the page's persistent inline state, so injecting the content scripts
// again continues it. It never messages the worker: what has to be sent is in what `settle`
// returns or in the operation's local-diagnostic outbox, and sending it is the content
// script's job.
(function initInlineTranslationSession(globalScope) {
  const inlineBlockCodec =
    globalScope.ChromeAiTranslatorInlineBlock ||
    (typeof module !== 'undefined' && module.exports
      ? require('./inline-block.js')
      : null);
  const inlineDiagnosticsProtocol =
    globalScope.ChromeAiTranslatorInlineDiagnosticsProtocol ||
    (typeof module !== 'undefined' && module.exports
      ? require('./inline-diagnostics-protocol.js')
      : null);
  const { DEFAULT_MODEL } =
    globalScope.ChromeAiTranslatorDefaultModel ||
    (typeof module !== 'undefined' && module.exports
      ? require('./default-model.js')
      : {});

  const INLINE_MAX_RECORDS = 500;
  const INLINE_BLOCK_BATCH_MAX_CHARS = 12000;
  // The only copy of the session cap. The worker enforces the batch and record caps and
  // has no session of its own to measure against. See ADR-0003. Its unit is record cost, not
  // characters, and it is charged in actual cost rather than the reserved cost the request-size
  // caps use — see ADR-0007 for why the two costs stay apart.
  const INLINE_BLOCK_SESSION_MAX_RECORD_COST = 150000;
  const INLINE_VIEWPORT_MAX_IN_FLIGHT = 2;

  const SETTINGS_DEFAULTS = Object.freeze({
    targetLanguage: 'Korean',
    tone: 'technical',
    model: DEFAULT_MODEL,
    reasoningEffort: 'none',
  });

  function createSettingsSnapshot(settings = {}) {
    const safe = settings || {};
    return {
      targetLanguage: String(safe.targetLanguage || SETTINGS_DEFAULTS.targetLanguage),
      tone: String(safe.tone || SETTINGS_DEFAULTS.tone),
      model: String(safe.model || SETTINGS_DEFAULTS.model),
      reasoningEffort: String(safe.reasoningEffort || SETTINGS_DEFAULTS.reasoningEffort),
    };
  }

  function getSettingsSignature(settings = {}) {
    return JSON.stringify(createSettingsSnapshot(settings));
  }

  function isTranslatedState(state) {
    return state === 'translated' || state === 'translated_with_warning';
  }

  const { getRecordCost, getReservedRecordCost } = inlineBlockCodec;

  // One Inline Translation Operation's Semantic Blocks: its queue, its records, and the outbox
  // of local diagnostics the content script's send-and-retry loop reads. `session` is the page
  // visit whose Session Budget its batches are charged to, never the operation's own.
  function createOperation(
    operationId,
    translationCache = null,
    translationSettings = null,
    session
  ) {
    const settingsSnapshot = translationSettings
      ? createSettingsSnapshot(translationSettings)
      : null;
    return {
      operationId,
      session,
      byBlock: new WeakMap(),
      records: [],
      queue: [],
      inFlight: 0,
      nextBlockId: 0,
      localDiagnostics: [],
      translationByOriginal: translationCache instanceof Map ? translationCache : new Map(),
      stopped: false,
      translationSettingsSignature: settingsSnapshot
        ? getSettingsSignature(settingsSnapshot)
        : null,
    };
  }

  function queueLocalDiagnostic(operation, record, code, evidence = {}, localRejection = null) {
    if (!operation?.localDiagnostics) return;
    const sanitizedRejection = inlineDiagnosticsProtocol.serializeLocalRejection(localRejection);
    operation.localDiagnostics.push({
      code,
      ...(typeof record?.template === 'string' ? { template: record.template } : {}),
      ...(record?.contract ? { contract: record.contract } : {}),
      evidence,
      ...(sanitizedRejection ? { localRejection: sanitizedRejection } : {}),
    });
  }

  function hasSettingsSignatureMismatch(operation, record) {
    const operationSignature = operation?.translationSettingsSignature || '';
    const recordSignature = record?.translationSettingsSignature || '';
    if (!operationSignature && !recordSignature) return false;
    return operationSignature !== recordSignature;
  }

  function stampRecordSettings(operation, record) {
    if (operation?.translationSettingsSignature && record) {
      record.translationSettingsSignature = operation.translationSettingsSignature;
    }
    return record;
  }

  // The id carries the operation that minted it, so a record minted here cannot collide with
  // one carried over from a stopped operation — those keep the ids of an earlier operation,
  // and every operation is built for an id that was incremented first. `findRecordById`
  // resolves `retryOf` by scanning `operation.records` for the first match, so a duplicate id
  // there silently resolves a retry to the wrong record. Nothing else reads this format: the
  // worker's `normalizeVisibleBlockBatchRecords` asks only for a non-empty string unique within
  // the batch, and the one place an id outlives the page is the `runId/<id>` diagnosticId,
  // which storage checks by its `runId/` prefix alone and never parses back into a block id.
  function createRecord(operation, blockElement, values = {}) {
    const record = {
      id: `b${Number(operation.operationId) || 0}-${operation.nextBlockId + 1}`,
      blockElement,
      state: 'original',
      operationId: operation.operationId,
      pageChangeRetryCount: 0,
      repair: null,
      ...values,
    };
    operation.nextBlockId += 1;
    stampRecordSettings(operation, record);
    operation.byBlock.set(blockElement, record);
    operation.records.push(record);
    return record;
  }

  function createQueuedRecordFromSerialized(operation, blockElement, serialized, options = {}) {
    return createRecord(operation, blockElement, {
      template: serialized.template,
      atoms: serialized.atoms,
      contract: serialized.contract,
      snapshot: serialized.snapshot,
      cacheKey: `block:${serialized.cacheKey}`,
      pageChangeRetryCount: Number(options.pageChangeRetryCount) || 0,
      retryOf: options.retryOf || null,
      repair: options.repair || null,
      state: 'queued',
    });
  }

  function cacheTranslation(operation, record) {
    if (
      !operation?.translationByOriginal ||
      !isTranslatedState(record?.state) ||
      !record.cacheKey ||
      typeof record.translatedTemplate !== 'string' ||
      hasSettingsSignatureMismatch(operation, record)
    ) {
      return false;
    }
    operation.translationByOriginal.set(record.cacheKey, {
      codecVersion: inlineBlockCodec.CODEC_VERSION,
      translatedTemplate: record.translatedTemplate,
      state: record.state,
      code: record.code || null,
      attemptCount: Math.min(2, Math.max(1, Number(record.attemptCount) || 1)),
    });
    return true;
  }

  function applyCachedTranslation(operation, record) {
    const cached = operation?.translationByOriginal?.get(record?.cacheKey);
    if (
      cached?.codecVersion !== inlineBlockCodec.CODEC_VERSION ||
      typeof cached?.translatedTemplate !== 'string'
    ) {
      return false;
    }
    const applied = inlineBlockCodec.applyTranslatedTemplate(record.snapshot, cached.translatedTemplate);
    if (!applied.ok) return false;
    record.state = cached.state === 'translated_with_warning'
      ? 'translated_with_warning'
      : 'translated';
    record.code = record.state === 'translated_with_warning'
      ? cached.code || 'quality.target_language_uncertain'
      : null;
    record.attemptCount = Math.min(2, Math.max(1, Number(cached.attemptCount) || 1));
    record.translatedTemplate = cached.translatedTemplate;
    return true;
  }

  // Admitting a block element: applied from the cache, queued for a request, refused locally
  // when it cannot be serialized, or passed over when the operation already has it. Returns the
  // record a scan counts as newly admitted, queued or refused, and null otherwise.
  function admitBlock(operation, blockElement) {
    if (!operation?.byBlock || !blockElement?.isConnected || !inlineBlockCodec) {
      return null;
    }
    const existing = operation.byBlock.get(blockElement);
    if (existing) {
      if (isTranslatedState(existing.state)) {
        if (inlineBlockCodec.matchesAppliedOwnership(existing.snapshot)) {
          return null;
        }
        existing.state = 'stale';
        existing.code = 'runtime.page_changed';
        operation.byBlock.delete(blockElement);
      } else if (['queued', 'translating', 'failed', 'stale'].includes(existing.state)) {
        return null;
      }
    }

    const serialized = inlineBlockCodec.serializeBlock(blockElement);
    if (!serialized.ok) {
      const failedRecord = createRecord(operation, blockElement, {
        state: 'failed',
        code: 'runtime.unsupported_block',
      });
      queueLocalDiagnostic(operation, failedRecord, failedRecord.code, {}, serialized.localRejection);
      return failedRecord;
    }
    const record = createQueuedRecordFromSerialized(operation, blockElement, serialized);
    if (applyCachedTranslation(operation, record)) return null;
    operation.queue.push(record);
    return record;
  }

  // Takes the next batch under the request-size caps and the Session Budget, refusing locally
  // any block either would never let through.
  function takeBatch(operation, maxChars = INLINE_BLOCK_BATCH_MAX_CHARS) {
    if (!operation || operation.stopped || operation.inFlight >= INLINE_VIEWPORT_MAX_IN_FLIGHT) {
      return [];
    }
    const limit = Number(maxChars) || INLINE_BLOCK_BATCH_MAX_CHARS;
    const batch = [];
    let batchCost = 0;

    while (operation.queue.length) {
      if (batch.length >= INLINE_MAX_RECORDS) break;
      const record = operation.queue[0];
      const cost = getRecordCost(record);
      if (cost > limit) {
        operation.queue.shift();
        record.state = 'failed';
        record.code = 'runtime.block_too_large';
        queueLocalDiagnostic(operation, record, record.code, { recordCost: cost, limit });
        continue;
      }
      const reservedCost = getReservedRecordCost(record);
      if (reservedCost > limit) {
        operation.queue.shift();
        record.state = 'failed';
        record.code = 'runtime.block_too_large';
        queueLocalDiagnostic(operation, record, record.code, { recordCost: reservedCost, limit });
        continue;
      }
      // The session budget is charged in actual cost while the caps above stay on reserved
      // cost. Two units for the same record in adjacent lines is deliberate: reserved cost
      // over-counts so one request can never exceed the cap it was checked against, and a
      // cumulative budget needs no such guarantee. See ADR-0007.
      if (operation.session.spent + cost > INLINE_BLOCK_SESSION_MAX_RECORD_COST) {
        operation.queue.shift();
        record.state = 'failed';
        record.code = 'runtime.session_too_large';
        queueLocalDiagnostic(operation, record, record.code, {
          recordCost: cost,
          sessionCost: operation.session.spent,
          limit: INLINE_BLOCK_SESSION_MAX_RECORD_COST,
        });
        continue;
      }
      if (batch.length && batchCost + reservedCost > limit) break;

      operation.queue.shift();
      record.state = 'translating';
      batch.push(record);
      batchCost += reservedCost;
      operation.session.charge(cost);
      if (batchCost >= limit) break;
    }
    if (batch.length) operation.inFlight += 1;
    return batch;
  }

  function queuePageChangeRetry(operation, parentRecord) {
    if (
      !operation ||
      operation.stopped ||
      !parentRecord?.blockElement?.isConnected ||
      operation.byBlock?.get(parentRecord.blockElement) !== parentRecord
    ) {
      return null;
    }
    const pageChangeRetryCount = Number(parentRecord.pageChangeRetryCount) || 0;
    if (pageChangeRetryCount >= 1) return null;

    const serialized = inlineBlockCodec.serializeBlock(parentRecord.blockElement);
    if (!serialized.ok) return null;
    const retryRecord = createQueuedRecordFromSerialized(
      operation,
      parentRecord.blockElement,
      serialized,
      { pageChangeRetryCount: pageChangeRetryCount + 1, retryOf: parentRecord.id, repair: null }
    );
    parentRecord.supersededByRetryId = retryRecord.id;
    if (!applyCachedTranslation(operation, retryRecord)) {
      operation.queue.push(retryRecord);
    }
    return retryRecord;
  }

  // `runtimeOutcomes` are the failures the page files itself, decided where each one happens:
  // an application failure, and a changed block no retry supersedes. A worker verdict and a
  // missing result are the worker's to record, so those records only release their tokens.
  function applyResults(records, results, operationId, operation = null) {
    const byId = new Map((results || []).map((result) => [result.id, result]));
    const runtimeOutcomes = [];

    function fileRuntimeOutcome(record) {
      runtimeOutcomes.push({
        code: record.code,
        correlationToken: record.correlationToken,
      });
    }

    function markChanged(record) {
      record.state = 'stale';
      record.code = 'runtime.page_changed';
      if (queuePageChangeRetry(operation, record)) {
        return;
      }
      fileRuntimeOutcome(record);
    }

    function failApplication(record, codecCode) {
      record.state = 'failed';
      record.code = `runtime.${codecCode || 'apply_failed'}`;
      fileRuntimeOutcome(record);
    }

    for (const record of records || []) {
      const result = byId.get(record.id);
      if (record.operationId !== operationId) {
        continue;
      }
      if (!result) {
        record.state = 'failed';
        record.code = 'runtime.request_failed';
        continue;
      }
      record.correlationToken = result.correlationToken || null;
      if (result.disposition === 'reject' || typeof result.template !== 'string') {
        if (!inlineBlockCodec.matchesOriginalOwnership(record.snapshot)) {
          markChanged(record);
          continue;
        }
        record.state = 'failed';
        record.code = result.terminalCode || 'runtime.request_failed';
        record.attemptCount = result.attemptCount || 1;
        continue;
      }

      const applied = inlineBlockCodec.applyTranslatedTemplate(record.snapshot, result.template);
      if (!applied.ok) {
        if (applied.errorCode === 'block_changed') markChanged(record);
        else failApplication(record, applied.errorCode);
        continue;
      }

      record.state = result.disposition === 'apply_with_warning'
        ? 'translated_with_warning'
        : 'translated';
      record.code = result.terminalCode ||
        (record.state === 'translated_with_warning' ? 'quality.target_language_uncertain' : null);
      record.attemptCount = result.attemptCount || 1;
      record.translatedTemplate = result.template;
      stampRecordSettings(operation, record);
      cacheTranslation(operation, record);
    }
    return runtimeOutcomes;
  }

  // A batch whose request failed outright has no results to say what became of each record.
  function failBatch(records, operationId) {
    for (const record of records || []) {
      if (record.operationId === operationId && record.state === 'translating') {
        record.state = 'failed';
        record.code = 'runtime.request_failed';
      }
    }
  }

  // A repair is a second real request carrying the same record, so it is charged the same
  // record cost again. The worker says whether one was sent by reporting `attemptCount`, and
  // this may only be read where a request actually came back: `attemptCount` is written into
  // the translation cache and replayed out of it, so a cached block presents a 2 for a repair
  // that happened in an earlier session with nothing sent for it now. See ADR-0007.
  //
  // The 2 is exact rather than `>= 2` because the worker sends at most two requests per record
  // and reports nothing else. If a third attempt is ever added, this charge has to be revisited
  // rather than silently counting it as the second.
  function chargeRepairs(session, records, response) {
    if (!response?.ok || !Array.isArray(response.results)) return;
    const byId = new Map(response.results.map((result) => [result?.id, result]));
    for (const record of records) {
      if (Number(byId.get(record.id)?.attemptCount) === 2) {
        session.charge(getRecordCost(record));
      }
    }
  }

  function findRecordById(operation, id) {
    if (!id) return null;
    return (operation?.records || []).find((record) => record?.id === id) || null;
  }

  function clearRetrySupersession(operation, retryRecord) {
    if (!retryRecord?.retryOf) return false;
    const parent = findRecordById(operation, retryRecord.retryOf);
    if (!parent || parent.supersededByRetryId !== retryRecord.id) return false;
    delete parent.supersededByRetryId;
    return true;
  }

  // Puts every block queued but not yet sent back to `original`, so the rescan a viewport
  // change schedules admits only what is still in view.
  function resetQueue(operation) {
    if (!operation?.queue?.length) return;

    const retained = [];
    for (const record of operation.queue) {
      if (record?.state === 'queued') {
        // `retryOf` is what makes a queued record a page-change retry, and a retry is kept
        // rather than reset: the block it superseded is still waiting on it.
        if (record.retryOf) {
          retained.push(record);
          continue;
        }
        clearRetrySupersession(operation, record);
        record.state = 'original';
        continue;
      }
      retained.push(record);
    }
    operation.queue = retained;
  }

  // Ends an operation's work: nothing queued will be sent and no retry will run.
  function stopOperation(operation) {
    // Emptying the queue below discards every queued retry, so a queued retry cancels here
    // just as an in-flight one does and has to release the record it superseded. This must
    // run before `resetQueue`, which retains a queued Semantic Block retry rather than
    // clearing its supersession.
    for (const record of operation.records) {
      if (record?.retryOf && (record.state === 'queued' || record.state === 'translating')) {
        clearRetrySupersession(operation, record);
      }
    }
    resetQueue(operation);
    operation.stopped = true;
    operation.queue = [];
  }

  function getStatusCounts(records) {
    const counts = { translated: 0, partial: 0, pending: 0, changed: 0, failed: 0 };
    for (const record of records || []) {
      if (record.state === 'translated') counts.translated += 1;
      if (record.state === 'translated_with_warning') counts.partial += 1;
      if (record.state === 'queued' || record.state === 'translating') {
        counts.pending += 1;
      }
      if (record.state === 'stale' && !record.supersededByRetryId) {
        counts.changed += 1;
      }
      if (record.state === 'failed' && !record.supersededByRetryId) {
        counts.failed += 1;
      }
    }
    return counts;
  }

  // The exact `runtime.*` codes that have a category of their own. Any other runtime code,
  // an application failure's codec code among them, reads as a failed request.
  const RUNTIME_CODE_CATEGORIES = Object.freeze({
    'runtime.page_changed': 'page_changed',
    'runtime.apply_failed': 'application_failed',
    'runtime.unsupported_block': 'unsupported_block',
    'runtime.block_too_large': 'block_too_large',
    'runtime.session_too_large': 'session_too_large',
  });

  const TERMINAL_REASON_CATEGORIES = Object.freeze([
    {
      key: 'target_language_missing',
      message: 'Translation failed ({count}): The model did not return the target language, so the original was kept.',
    },
    {
      key: 'residual_source_prose',
      message: 'Partial translation ({count}): Some source-language prose remained after one repair attempt.',
    },
    {
      key: 'protected_structure',
      message: 'Translation failed ({count}): Protected page structure could not be preserved, so the original was kept.',
    },
    {
      key: 'malformed_response',
      message: 'Translation failed ({count}): The model response was malformed or incomplete.',
    },
    {
      key: 'application_failed',
      message: 'Translation failed ({count}): The page rejected the translated update, so the original was kept.',
    },
    {
      key: 'unsupported_block',
      message: 'Translation failed ({count}): This page block has unsupported structure, so no request was sent.',
    },
    {
      key: 'block_too_large',
      message: 'Translation failed ({count}): This page block exceeds the 12,000-character request limit, so no request was sent.',
    },
    {
      key: 'session_too_large',
      message: 'Translation failed ({count}): The visible translation reached this page visit\'s limit, so no request was sent. Reload the page to continue.',
    },
    {
      key: 'page_changed',
      message: 'Changed ({count}): Page changed before translation could be applied.',
    },
    {
      key: 'request_failed',
      message: 'Translation failed ({count}): The translation request could not be completed.',
    },
  ]);

  function getTerminalReasonCategory(record) {
    if (
      !record ||
      record.supersededByRetryId ||
      !['translated_with_warning', 'failed', 'stale'].includes(record.state)
    ) {
      return '';
    }
    const code = String(record.code || '');
    if (code === 'quality.target_language_missing') {
      return 'target_language_missing';
    }
    if (record.state === 'translated_with_warning') {
      return 'residual_source_prose';
    }
    if (code.startsWith('structure.')) {
      return 'protected_structure';
    }
    if (code.startsWith('protocol.')) {
      return 'malformed_response';
    }
    return RUNTIME_CODE_CATEGORIES[code] || 'request_failed';
  }

  // The reason summary: why part of an operation will not finish, one line per cause.
  function getTerminalReason(records) {
    const counts = new Map();
    for (const record of records || []) {
      const category = getTerminalReasonCategory(record);
      if (category) counts.set(category, (counts.get(category) || 0) + 1);
    }
    return TERMINAL_REASON_CATEGORIES
      .filter(({ key }) => counts.has(key))
      .map(({ key, message }) => {
        const count = counts.get(key);
        const affectedBlocks = `${count} ${count === 1 ? 'block' : 'blocks'}`;
        return message.replace('{count}', affectedBlocks);
      })
      .join('\n');
  }

  function createInlineTranslationSession() {
    let status = 'original';
    let operationId = 0;
    // One owner per page visit, shared by every operation, including a request an earlier
    // one sent that comes back late. See ADR-0007.
    let spent = 0;
    const cacheBySettings = new Map();
    let translatedRecords = [];
    const budget = {
      get spent() { return spent; },
      charge(cost) { spent += cost; },
    };
    let session = null;
    let operation = null;

    // The translated records of the operation that is ending join what the visit has
    // translated.
    function keepTranslated() {
      const seen = new Set(translatedRecords);
      for (const record of operation.records) {
        if (isTranslatedState(record?.state) && !seen.has(record)) {
          translatedRecords.push(record);
          seen.add(record);
        }
      }
    }

    function getCacheBucket(signature) {
      let cache = cacheBySettings.get(signature);
      if (!cache) {
        cache = new Map();
        cacheBySettings.set(signature, cache);
      }
      return cache;
    }

    function isCurrent(id) {
      return (
        status === 'active' &&
        operationId === id &&
        operation.operationId === id &&
        !operation.stopped
      );
    }

    // Each block the visit translated is either carried into the new operation, when it was
    // translated under these settings and the page still shows that translation, or put back,
    // when it was translated under other settings. A carried block is already translated, so
    // a rescan finds it done instead of queueing it again.
    function begin(settings) {
      keepTranslated();
      const signature = getSettingsSignature(settings);
      operationId += 1;
      status = 'active';
      operation = createOperation(operationId, getCacheBucket(signature), settings, budget);
      for (const record of translatedRecords) {
        const blockElement = record.snapshot?.blockElement;
        if (!blockElement?.isConnected || !isTranslatedState(record.state)) continue;
        const owned = inlineBlockCodec.matchesAppliedOwnership(record.snapshot);
        if ((record.translationSettingsSignature || '') !== signature) {
          if (owned && inlineBlockCodec.restoreBlock(record.snapshot).ok) {
            record.state = 'original';
          }
          continue;
        }
        if (!owned) continue;
        operation.byBlock.set(blockElement, record);
        operation.records.push(record);
        cacheTranslation(operation, record);
      }
      return operationId;
    }

    // A second Stop, with the operation already ended, has nothing to end.
    function stop() {
      stopOperation(operation);
      keepTranslated();
      if (status !== 'stopped') operationId += 1;
      status = 'stopped';
      return operationId;
    }

    // Puts back every block the visit translated, including those of earlier operations,
    // and returns each of the current operation's records to `original` with them. A block
    // the page has changed since cannot be put back and is left marked changed.
    function restore() {
      const restoredBlocks = new Set();
      for (const record of [...new Set([...translatedRecords, ...operation.records])]) {
        // A record with no snapshot never reached the page — a block that could not be
        // serialized is one — so there is nothing to put back, but it still goes back to
        // `original` along with the rest.
        const blockElement = record.snapshot?.blockElement;
        if (
          blockElement &&
          isTranslatedState(record.state) &&
          blockElement.isConnected &&
          !restoredBlocks.has(blockElement)
        ) {
          if (!inlineBlockCodec.restoreBlock(record.snapshot).ok) {
            record.state = 'stale';
            record.code = 'runtime.page_changed';
            continue;
          }
          restoredBlocks.add(blockElement);
        }
        record.state = 'original';
      }
      translatedRecords = [];
      status = 'original';
      operationId += 1;
      operation = createOperation(operationId, null, null, budget);
      return operationId;
    }

    // Settles a batch with its response, or with nothing when the request failed, and returns
    // what the page must send the worker. The repair is charged before anything asks whether
    // the batch's operation is still current: a replaced operation still sent that request,
    // so the page visit pays for it, but it can neither apply the answer nor requeue anything,
    // and has only tokens to release.
    function settle(batch, response) {
      const records = batch || [];
      const batchOperationId = records[0]?.operationId;
      chargeRepairs(budget, records, response);
      if (!isCurrent(batchOperationId)) {
        return {
          runtimeOutcomes: [],
          releaseTokens: Array.isArray(response?.results)
            ? response.results.map((result) => result?.correlationToken).filter(Boolean)
            : [],
          diagnosticsUnavailable: false,
        };
      }
      operation.inFlight = Math.max(0, operation.inFlight - 1);
      if (!response?.ok || !Array.isArray(response.results)) {
        failBatch(records, batchOperationId);
        return { runtimeOutcomes: [], releaseTokens: [], diagnosticsUnavailable: false };
      }
      let runtimeOutcomes;
      try {
        runtimeOutcomes = applyResults(records, response.results, batchOperationId, operation);
      } catch {
        // An answer the page could not settle reads as a failed request, as one that never
        // came back does, rather than leaving its blocks pending for good.
        failBatch(records, batchOperationId);
        return { runtimeOutcomes: [], releaseTokens: [], diagnosticsUnavailable: false };
      }
      const runtimeTokens = new Set(runtimeOutcomes.map((outcome) => outcome.correlationToken));
      return {
        runtimeOutcomes,
        releaseTokens: records
          .map((record) => record.correlationToken)
          .filter((token) => token && !runtimeTokens.has(token)),
        diagnosticsUnavailable: response.results.some((result) => result?.diagnosticsUnavailable),
      };
    }

    session = Object.freeze({
      get status() {
        return status;
      },
      get operationId() {
        return operationId;
      },
      // The current operation's local diagnostics, oldest first. The content script's
      // send-and-retry loop takes them from the front.
      get outbox() {
        return operation.localDiagnostics;
      },
      isCurrent,
      begin,
      stop,
      restore,
      admit: (blockElement) => admitBlock(operation, blockElement),
      takeBatch: () => takeBatch(operation),
      settle,
      resetQueue: () => resetQueue(operation),
      progress: () => ({
        counts: getStatusCounts(operation.records),
        reason: getTerminalReason(operation.records),
      }),
    });
    operation = createOperation(operationId, null, null, budget);
    return session;
  }

  const api = {
    SETTINGS_DEFAULTS,
    createSettingsSnapshot,
    getSettingsSignature,
    getRecordCost,
    getReservedRecordCost,
    createInlineTranslationSession,
  };
  globalScope.ChromeAiTranslatorInlineTranslationSession = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
