// The Inline Translation Session: one page visit, and what outlives each Inline Translation
// Operation within it. The Session Budget, the translation cache buckets, the Semantic Blocks
// the visit translated, the Inline Translation status and the operation id all live here, so
// no operation hands any of them to the next.
//
// The session is kept on the page's persistent inline state, so injecting the content scripts
// again continues it. It never messages the worker: what has to be sent is the content
// script's to send.
(function initInlineTranslationSession(globalScope) {
  const inlineBlockCodec =
    globalScope.ChromeAiTranslatorInlineBlock ||
    (typeof module !== 'undefined' && module.exports
      ? require('./inline-block.js')
      : null);
  const { DEFAULT_MODEL } =
    globalScope.ChromeAiTranslatorDefaultModel ||
    (typeof module !== 'undefined' && module.exports
      ? require('./default-model.js')
      : {});

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

  function createInlineTranslationSession() {
    let status = 'original';
    let operationId = 0;
    // One owner per page visit, shared by every operation, including a request an earlier
    // one sent that comes back late. See ADR-0007.
    let spent = 0;
    const cacheBySettings = new Map();
    let translatedRecords = [];

    function keep(records = []) {
      const seen = new Set(translatedRecords);
      for (const record of records || []) {
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

    // `records` are the ending operation's own. The translated ones join what the visit has
    // translated, and each block the visit translated is either carried into this operation,
    // when it was translated under these settings and the page still shows that translation,
    // or put back, when it was translated under other settings.
    function begin(settings, records = []) {
      keep(records);
      const signature = getSettingsSignature(settings);
      operationId += 1;
      status = 'active';
      const carriedRecords = [];
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
        if (owned) carriedRecords.push(record);
      }
      return {
        operationId,
        translationCache: getCacheBucket(signature),
        carriedRecords,
      };
    }

    // A second Stop, with the operation already ended, has nothing to end.
    function stop(records = []) {
      keep(records);
      if (status !== 'stopped') operationId += 1;
      status = 'stopped';
      return operationId;
    }

    // Puts back every block the visit translated, including those of earlier operations,
    // and returns each of `records` to `original` with them. A block the page has changed
    // since cannot be put back and is left marked changed.
    function restore(records = []) {
      const restoredBlocks = new Set();
      for (const record of [...new Set([...translatedRecords, ...(records || [])])]) {
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
      return operationId;
    }

    return Object.freeze({
      get status() {
        return status;
      },
      get operationId() {
        return operationId;
      },
      get spent() {
        return spent;
      },
      charge(recordCost) {
        spent += recordCost;
      },
      begin,
      stop,
      restore,
    });
  }

  const api = {
    SETTINGS_DEFAULTS,
    createSettingsSnapshot,
    getSettingsSignature,
    isTranslatedState,
    createInlineTranslationSession,
  };
  globalScope.ChromeAiTranslatorInlineTranslationSession = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
