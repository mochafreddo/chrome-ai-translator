(function initSettingsLifecycle(globalScope) {
  const { ALL_SITES_ORIGINS, BUTTON_VISIBILITY, readButtonVisibility } =
    globalScope.ChromeAiTranslatorButtonVisibility || require('./button-visibility.js');
  const { DEFAULT_MODEL, getEffectiveModelSettings } =
    globalScope.ChromeAiTranslatorDefaultModel || require('./default-model.js');

  const DEFAULT_SETTINGS = {
    service: 'openai',
    apiKey: '',
    openrouterApiKey: '',
    model: DEFAULT_MODEL,
    reasoningEffort: 'none',
    targetLanguage: 'Korean',
    tone: 'technical',
    viewMode: 'translation', // translation | bilingual
    chunkMaxChars: 12000,
    cacheEnabled: false,
    cacheTtlDays: 7,
    buttonVisibility: BUTTON_VISIBILITY.NEVER,
  };
  const SETTINGS_KEYS = Object.freeze(Object.keys(DEFAULT_SETTINGS));

  const MIN_CHUNK_MAX_CHARS = 2000;
  const MAX_CHUNK_MAX_CHARS = 60000;
  function normalizeChunkMaxChars(value, fallback = DEFAULT_SETTINGS.chunkMaxChars) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(
      MAX_CHUNK_MAX_CHARS,
      Math.max(MIN_CHUNK_MAX_CHARS, Math.floor(parsed))
    );
  }

  function mergeSettings(partial) {
    const merged = { ...DEFAULT_SETTINGS };
    for (const key of SETTINGS_KEYS) {
      if (Object.prototype.hasOwnProperty.call(partial || {}, key)) {
        merged[key] = partial[key];
      }
    }
    merged.chunkMaxChars = normalizeChunkMaxChars(merged.chunkMaxChars);
    merged.service = getEffectiveModelSettings(merged).service;
    // Reading settings is the one place the older `inlineAutoShow` boolean can still arrive
    // from storage, so it is the place it stops being visible: nothing downstream, and
    // nothing written back, knows about it.
    merged.buttonVisibility = readButtonVisibility(partial);
    return merged;
  }

  function mergeSettingsWithExisting(existing, partial) {
    return mergeSettings({
      ...(existing || {}),
      ...(partial || {}),
    });
  }

  // Named after the setting that used to govern it. Chrome keeps a registration under this id
  // across restarts, so renaming it would strand the old one on installs that already have it.
  const INLINE_CONTENT_SCRIPT_ID = 'inline-translator-auto-show';

  function createSettingsLifecycle({ chrome = null, contentScriptFiles = [] } = {}) {
    function getChrome() {
      if (!chrome) throw new Error('This worker was built without chrome');
      return chrome;
    }

    let buttonVisibilityRegistrationSync = Promise.resolve();
    let settingsMutation = Promise.resolve();
    let settingsChangeGeneration = 0;
    let allPagesAccessGeneration = 0;

    async function read() {
      const stored = await getChrome().storage.local.get(['settings', 'openai_api_key']);
      const settings = stored.settings || {};
      const apiKey = settings.apiKey || stored.openai_api_key || '';
      return mergeSettings({ ...settings, apiKey });
    }

    function change({ settings = {}, clearApiKey = false, service = 'openai' } = {}) {
      const keyService = getEffectiveModelSettings({ service }).service;
      const generation = ++settingsChangeGeneration;
      if (readButtonVisibility(settings) === BUTTON_VISIBILITY.ALL_PAGES) {
        allPagesAccessGeneration = generation;
      }
      // Read inside the ordered mutation: queued saves and install normalization must see
      // completed writes, and a failed storage operation must leave later requests usable.
      const nextMutation = settingsMutation.catch(() => {}).then(async () => {
        const current = await read();
        const next = mergeSettingsWithExisting(current, settings);
        if (clearApiKey) delete next[keyService === 'openrouter' ? 'openrouterApiKey' : 'apiKey'];
        await getChrome().storage.local.set({ settings: next });
        if (clearApiKey && keyService === 'openai') await getChrome().storage.local.remove('openai_api_key');
        await syncButtonVisibilityRegistrationSafely(next, generation);
      });
      settingsMutation = nextMutation;
      return nextMutation;
    }

    function getAllPagesContentScript() {
      return {
        id: INLINE_CONTENT_SCRIPT_ID,
        matches: ALL_SITES_ORIGINS,
        js: contentScriptFiles,
        runAt: 'document_idle',
      };
    }

    function isDuplicateInlineContentScriptError(error) {
      return String(error?.message || error).includes(
        `Duplicate script ID '${INLINE_CONTENT_SCRIPT_ID}'`
      );
    }

    async function hasAllSitesAccess() {
      const chrome = getChrome();
      if (!chrome.permissions?.contains) return false;
      return chrome.permissions.contains({ origins: ALL_SITES_ORIGINS });
    }

    async function getRegisteredAllPagesContentScript() {
      const chrome = getChrome();
      if (!chrome.scripting.getRegisteredContentScripts) return null;
      const scripts = await chrome.scripting.getRegisteredContentScripts({
        ids: [INLINE_CONTENT_SCRIPT_ID],
      });
      return (scripts || []).find((script) => script?.id === INLINE_CONTENT_SCRIPT_ID);
    }

    async function updateAllPagesContentScript(script) {
      const chrome = getChrome();
      if (!chrome.scripting.updateContentScripts) return false;
      try {
        await chrome.scripting.updateContentScripts([script]);
        return true;
      } catch (error) {
        if (isDuplicateInlineContentScriptError(error)) return false;
        throw error;
      }
    }

    async function syncButtonVisibilityRegistration(settings = null, generation = settingsChangeGeneration) {
      // Startup reads after accepted writes, before joining the registration queue. Waiting
      // inside that queue would deadlock a settings write awaiting its own registration.
      if (!settings) await settingsMutation.catch(() => {});
      const previousSync = buttonVisibilityRegistrationSync.catch(() => {});
      const nextSync = previousSync.then(() =>
        syncButtonVisibilityRegistrationNow(settings, generation)
      );
      buttonVisibilityRegistrationSync = nextSync;
      return nextSync;
    }

    async function syncButtonVisibilityRegistrationSafely(settings = null, generation = settingsChangeGeneration) {
      try {
        await syncButtonVisibilityRegistration(settings, generation);
        return true;
      } catch {
        return false;
      }
    }

    async function unregisterAllPagesContentScript() {
      const chrome = getChrome();
      try {
        await chrome.scripting.unregisterContentScripts({
          ids: [INLINE_CONTENT_SCRIPT_ID],
        });
      } catch {}
    }

    // Brings both things the all-pages choice needs — access to every site and a content script
    // registered across pages — into line with the choice the reader has made.
    async function syncButtonVisibilityRegistrationNow(settings = null, generation = settingsChangeGeneration) {
      const chrome = getChrome();
      const effective = settings || (await read());
      const visibility = readButtonVisibility(effective);

      if (visibility !== BUTTON_VISIBILITY.ALL_PAGES) {
        await unregisterAllPagesContentScript();
        // Giving the access back belongs here as well as on the options page: an install
        // migrating off the old checkbox reaches never without the reader opening options at
        // all, and the access that checkbox asked for would otherwise outlive it.
        try {
          // A newer Options gesture may have granted access while this older write waited.
          // Keep registration ordered even if that newer write fails, but do not revoke its grant.
          if (generation >= allPagesAccessGeneration && chrome.permissions?.remove) {
            await chrome.permissions.remove({ origins: ALL_SITES_ORIGINS });
          }
        } catch {}
        return;
      }

      // Registering the content script across pages is what lets the button appear without the
      // reader invoking the extension. It needs the access the choice asked for, which Chrome's
      // own UI can revoke without the options page ever hearing about it.
      if (!(await hasAllSitesAccess())) {
        await unregisterAllPagesContentScript();
        return;
      }

      const allPagesContentScript = getAllPagesContentScript();
      try {
        if (
          chrome.scripting.updateContentScripts &&
          (await getRegisteredAllPagesContentScript())
        ) {
          if (await updateAllPagesContentScript(allPagesContentScript)) return;
        }
      } catch {}

      try {
        await chrome.scripting.registerContentScripts([allPagesContentScript]);
      } catch (error) {
        if (isDuplicateInlineContentScriptError(error)) {
          if (await updateAllPagesContentScript(allPagesContentScript)) return;
          try {
            await chrome.scripting.unregisterContentScripts({
              ids: [INLINE_CONTENT_SCRIPT_ID],
            });
            await chrome.scripting.registerContentScripts([allPagesContentScript]);
          } catch {}
          return;
        }
        throw error;
      }
    }

    return {
      read,
      save: (partial = {}) => change({ settings: partial }),
      clearKey: (service = 'openai') => change({ clearApiKey: true, service }),
      reconcile: () => syncButtonVisibilityRegistrationSafely(),
    };
  }

  const api = { createSettingsLifecycle, DEFAULT_SETTINGS, mergeSettings };
  globalScope.ChromeAiTranslatorSettingsLifecycle = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
