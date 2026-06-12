# Viewport-First Inline Translation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace inline whole-page translation with an active viewport-first mode that translates visible text quickly, applies successful batches immediately, and keeps translating newly visible text as the user scrolls.

**Architecture:** Keep side panel Markdown translation unchanged. Add viewport-mode state, queueing, batching, scan scheduling, and partial application in `extension/content.js`; add a small batch translation message path in `extension/background.js` that reuses the current OpenAI JSON schema and response validation helpers.

**Tech Stack:** Chrome Manifest V3 extension, content script DOM APIs, service worker message passing, OpenAI Responses API, plain JavaScript, Node-based helper tests.

---

## File Structure

- Modify `extension/content.js`
  - Keep existing article extraction, skip rules, floating button, authorization, and original restore behavior.
  - Add viewport-mode constants and pure helpers for visibility, record state, queue batching, status counts, and operation invalidation.
  - Replace `translateInlinePage()` with active viewport mode startup.
  - Add scroll/resize/mutation scan scheduling and queue draining.
  - Add a `Stop` menu action.
- Modify `extension/background.js`
  - Keep side panel translation and existing `TRANSLATE_TEXT_NODES` handler.
  - Add `TRANSLATE_VISIBLE_TEXT_BATCH` handler.
  - Add `translateVisibleTextBatch()` that translates one caller-sized batch and returns validated translations.
- Modify `tests/content-helpers.test.js`
  - Add tests for viewport inclusion, record state transitions, duplicate suppression, partial application, operation invalidation, status counts, and batching.
- Modify `tests/background-helpers.test.js`
  - Add tests for the visible batch request helper boundaries that can be verified without network.
- Modify `README.md`
  - Update inline translation usage text so it describes viewport-first active mode instead of whole-page inline translation.

---

### Task 1: Add Content Helper Tests For Viewport Mode

**Files:**
- Modify: `tests/content-helpers.test.js`
- Test: `tests/content-helpers.test.js`

- [ ] **Step 1: Add failing tests for viewport and queue helpers**

Append these test cases before the closing `];` in `tests/content-helpers.test.js`:

```js
  {
    name: 'detects text rects inside viewport with prefetch margin',
    fn() {
      const viewport = { width: 1000, height: 800 };

      assert.equal(
        helpers.isInlineRectInViewport(
          { top: 100, bottom: 140, left: 10, right: 700 },
          viewport
        ),
        true
      );
      assert.equal(
        helpers.isInlineRectInViewport(
          { top: 1000, bottom: 1040, left: 10, right: 700 },
          viewport
        ),
        true
      );
      assert.equal(
        helpers.isInlineRectInViewport(
          { top: 1300, bottom: 1340, left: 10, right: 700 },
          viewport
        ),
        false
      );
      assert.equal(
        helpers.isInlineRectInViewport(
          { top: 100, bottom: 140, left: 1100, right: 1200 },
          viewport
        ),
        false
      );
    },
  },
  {
    name: 'queues each visible text node once per active operation',
    fn() {
      const store = helpers.createInlineViewportStore(7);
      const node = { isConnected: true, nodeValue: 'Visible article text.' };

      const first = helpers.queueInlineViewportRecord(
        store,
        node,
        'Visible article text.'
      );
      const second = helpers.queueInlineViewportRecord(
        store,
        node,
        'Visible article text.'
      );

      assert.equal(first.id, 'v1');
      assert.equal(first.state, 'queued');
      assert.equal(first.operationId, 7);
      assert.equal(second, null);
      assert.deepEqual(
        store.queue.map((record) => record.id),
        ['v1']
      );
    },
  },
  {
    name: 'moves queued viewport records into character-budget batches',
    fn() {
      const store = helpers.createInlineViewportStore(3);
      const records = [
        helpers.queueInlineViewportRecord(store, { nodeValue: 'a', isConnected: true }, 'alpha beta gamma'),
        helpers.queueInlineViewportRecord(store, { nodeValue: 'b', isConnected: true }, 'delta epsilon zeta'),
        helpers.queueInlineViewportRecord(store, { nodeValue: 'c', isConnected: true }, 'eta theta iota'),
      ];

      const batch = helpers.takeInlineViewportBatch(store, 36);

      assert.deepEqual(
        batch.map((record) => record.id),
        ['v1']
      );
      assert.equal(records[0].state, 'translating');
      assert.equal(store.queue.length, 2);
    },
  },
  {
    name: 'applies successful viewport translations and marks stale nodes',
    fn() {
      const stableNode = { isConnected: true, nodeValue: 'Hello world.' };
      const changedNode = { isConnected: true, nodeValue: 'Updated text.' };
      const detachedNode = { isConnected: false, nodeValue: 'Detached text.' };
      const records = [
        {
          id: 'v1',
          node: stableNode,
          original: 'Hello world.',
          translation: null,
          state: 'translating',
          operationId: 11,
        },
        {
          id: 'v2',
          node: changedNode,
          original: 'Original text.',
          translation: null,
          state: 'translating',
          operationId: 11,
        },
        {
          id: 'v3',
          node: detachedNode,
          original: 'Detached text.',
          translation: null,
          state: 'translating',
          operationId: 11,
        },
      ];

      const result = helpers.applyInlineViewportBatchTranslations(
        records,
        [
          { id: 'v1', translation: '안녕하세요.' },
          { id: 'v2', translation: '원문입니다.' },
          { id: 'v3', translation: '분리됨.' },
        ],
        11
      );

      assert.equal(stableNode.nodeValue, '안녕하세요.');
      assert.equal(changedNode.nodeValue, 'Updated text.');
      assert.equal(detachedNode.nodeValue, 'Detached text.');
      assert.deepEqual(result, { applied: 1, stale: 2, ignored: 0 });
      assert.equal(records[0].state, 'translated');
      assert.equal(records[1].state, 'stale');
      assert.equal(records[2].state, 'stale');
    },
  },
  {
    name: 'ignores late viewport translations from stale operations',
    fn() {
      const node = { isConnected: true, nodeValue: 'Hello world.' };
      const records = [
        {
          id: 'v1',
          node,
          original: 'Hello world.',
          translation: null,
          state: 'translating',
          operationId: 4,
        },
      ];

      const result = helpers.applyInlineViewportBatchTranslations(
        records,
        [{ id: 'v1', translation: '안녕하세요.' }],
        5
      );

      assert.deepEqual(result, { applied: 0, stale: 0, ignored: 1 });
      assert.equal(node.nodeValue, 'Hello world.');
      assert.equal(records[0].state, 'translating');
    },
  },
  {
    name: 'formats viewport active status counts',
    fn() {
      const message = helpers.formatInlineViewportStatusMessage({
        translated: 18,
        pending: 4,
        failed: 1,
      });

      assert.equal(
        message,
        'Visible translation on\nTranslated 18 · Pending 4 · Failed 1'
      );
    },
  },
  {
    name: 'restores translated viewport records and invalidates operation',
    fn() {
      const state = {
        status: 'active',
        operationId: 8,
        viewport: helpers.createInlineViewportStore(8),
      };
      const node = { isConnected: true, nodeValue: '안녕하세요.' };
      const record = {
        id: 'v1',
        node,
        original: 'Hello world.',
        translation: '안녕하세요.',
        state: 'translated',
        operationId: 8,
      };
      state.viewport.records.push(record);

      helpers.restoreInlineViewportRecords(state);

      assert.equal(node.nodeValue, 'Hello world.');
      assert.equal(state.status, 'original');
      assert.equal(state.operationId, 9);
      assert.equal(record.state, 'original');
    },
  },
```

- [ ] **Step 2: Run the tests and verify they fail**

Run:

```bash
npm test
```

Expected: FAIL because `extension/content.js` does not export `isInlineRectInViewport`, `createInlineViewportStore`, `queueInlineViewportRecord`, `takeInlineViewportBatch`, `applyInlineViewportBatchTranslations`, `formatInlineViewportStatusMessage`, or `restoreInlineViewportRecords`.

---

### Task 2: Implement Pure Content Helpers

**Files:**
- Modify: `extension/content.js`
- Test: `tests/content-helpers.test.js`

- [ ] **Step 1: Add viewport constants and store helper**

Near the existing inline constants at the top of `extension/content.js`, add:

```js
var INLINE_VIEWPORT_BATCH_MAX_CHARS = 2000;
var INLINE_VIEWPORT_MAX_IN_FLIGHT = 2;
var INLINE_VIEWPORT_SCAN_DEBOUNCE_MS = 250;
var INLINE_VIEWPORT_PREFETCH_RATIO = 0.5;

function createInlineViewportStore(operationId) {
  return {
    operationId,
    byNode: new WeakMap(),
    records: [],
    queue: [],
    inFlight: 0,
    nextId: 0,
    scanTimer: null,
    observer: null,
    root: null,
    stopped: false,
  };
}
```

- [ ] **Step 2: Add viewport visibility helper**

Add this after `getInlineHostStyleText()`:

```js
function isInlineRectInViewport(
  rect,
  viewport,
  prefetchRatio = INLINE_VIEWPORT_PREFETCH_RATIO
) {
  if (!rect || !viewport) return false;
  const width = Number(viewport.width) || 0;
  const height = Number(viewport.height) || 0;
  if (width <= 0 || height <= 0) return false;

  const margin = height * prefetchRatio;
  const top = Number(rect.top);
  const bottom = Number(rect.bottom);
  const left = Number(rect.left);
  const right = Number(rect.right);

  if (![top, bottom, left, right].every(Number.isFinite)) return false;
  if (bottom < -margin) return false;
  if (top > height + margin) return false;
  if (right < 0) return false;
  if (left > width) return false;
  return true;
}
```

- [ ] **Step 3: Add queue and batch helpers**

Add these helper functions after `isInlineRectInViewport()`:

```js
function getInlineRecordPayloadSize(record) {
  return String(record.id || '').length + String(record.original || record.text || '').length + 20;
}

function queueInlineViewportRecord(store, node, text) {
  if (!store || !node) return null;
  const existing = store.byNode.get(node);
  if (
    existing &&
    ['queued', 'translating', 'translated', 'failed', 'stale'].includes(
      existing.state
    )
  ) {
    return null;
  }

  const record =
    existing || {
      id: `v${store.nextId + 1}`,
      node,
      original: text,
      translation: null,
      state: 'original',
      operationId: store.operationId,
    };

  if (!existing) {
    store.nextId += 1;
    store.byNode.set(node, record);
    store.records.push(record);
  }

  record.original = text;
  record.translation = null;
  record.state = 'queued';
  record.operationId = store.operationId;
  store.queue.push(record);
  return record;
}

function takeInlineViewportBatch(
  store,
  maxChars = INLINE_VIEWPORT_BATCH_MAX_CHARS
) {
  if (!store || store.stopped || store.inFlight >= INLINE_VIEWPORT_MAX_IN_FLIGHT) {
    return [];
  }

  const limit = Number(maxChars) || INLINE_VIEWPORT_BATCH_MAX_CHARS;
  const batch = [];
  let total = 0;

  while (store.queue.length) {
    const record = store.queue[0];
    const size = getInlineRecordPayloadSize(record);
    if (batch.length && total + size > limit) break;

    store.queue.shift();
    record.state = 'translating';
    batch.push(record);
    total += size;

    if (total >= limit) break;
  }

  if (batch.length) {
    store.inFlight += 1;
  }
  return batch;
}
```

- [ ] **Step 4: Add application, failure, status, and restore helpers**

Add these after `takeInlineViewportBatch()`:

```js
function applyInlineViewportBatchTranslations(records, translations, operationId) {
  const byId = new Map((translations || []).map((item) => [item.id, item.translation]));
  const result = { applied: 0, stale: 0, ignored: 0 };

  for (const record of records || []) {
    if (record.operationId !== operationId) {
      result.ignored += 1;
      continue;
    }

    const translation = byId.get(record.id);
    if (typeof translation !== 'string') {
      record.state = 'failed';
      continue;
    }

    if (!record.node?.isConnected || record.node.nodeValue !== record.original) {
      record.state = 'stale';
      result.stale += 1;
      continue;
    }

    record.node.nodeValue = translation;
    record.translation = translation;
    record.state = 'translated';
    result.applied += 1;
  }

  return result;
}

function markInlineViewportBatchFailed(records, operationId) {
  for (const record of records || []) {
    if (record.operationId === operationId && record.state === 'translating') {
      record.state = 'failed';
    }
  }
}

function getInlineViewportStatusCounts(records) {
  const counts = { translated: 0, pending: 0, failed: 0 };
  for (const record of records || []) {
    if (record.state === 'translated') counts.translated += 1;
    if (record.state === 'queued' || record.state === 'translating') {
      counts.pending += 1;
    }
    if (record.state === 'failed' || record.state === 'stale') counts.failed += 1;
  }
  return counts;
}

function formatInlineViewportStatusMessage(counts) {
  const safe = counts || {};
  return [
    'Visible translation on',
    `Translated ${Number(safe.translated) || 0} · Pending ${Number(safe.pending) || 0} · Failed ${Number(safe.failed) || 0}`,
  ].join('\n');
}

function restoreInlineViewportRecords(state = inlineState) {
  const viewport = state.viewport;
  if (viewport?.observer) {
    viewport.observer.disconnect();
  }
  if (viewport?.scanTimer) {
    clearTimeout(viewport.scanTimer);
  }

  for (const record of viewport?.records || []) {
    if (record.state === 'translated' && record.node?.isConnected) {
      record.node.nodeValue = record.original;
    }
    record.state = 'original';
  }

  state.status = 'original';
  state.records = [];
  state.operationId = (Number(state.operationId) || 0) + 1;
  state.viewport = createInlineViewportStore(state.operationId);
}
```

- [ ] **Step 5: Initialize viewport state and export helpers**

After `globalThis.__chromeAiTranslatorInlineState = inlineState;`, add:

```js
if (!inlineState.viewport) {
  inlineState.viewport = createInlineViewportStore(inlineState.operationId);
}
```

Add these names to the `module.exports` object:

```js
    isInlineRectInViewport,
    createInlineViewportStore,
    queueInlineViewportRecord,
    takeInlineViewportBatch,
    applyInlineViewportBatchTranslations,
    markInlineViewportBatchFailed,
    getInlineViewportStatusCounts,
    formatInlineViewportStatusMessage,
    restoreInlineViewportRecords,
```

- [ ] **Step 6: Run tests**

Run:

```bash
npm test
```

Expected: PASS for the new content helper tests and all existing helper tests.

- [ ] **Step 7: Commit**

Run:

```bash
git add extension/content.js tests/content-helpers.test.js
git commit -m "feat: add viewport inline translation helpers"
```

---

### Task 3: Add Visible Batch Translation To Background

**Files:**
- Modify: `tests/background-helpers.test.js`
- Modify: `extension/background.js`
- Test: `tests/background-helpers.test.js`

- [ ] **Step 1: Add failing background helper tests**

Append these test cases before the closing `];` in `tests/background-helpers.test.js`:

```js
  {
    name: 'uses a small visible inline batch character budget',
    fn() {
      assert.equal(helpers.getVisibleInlineBatchMaxChars(), 2000);
    },
  },
  {
    name: 'normalizes visible inline batch records with existing validation',
    fn() {
      assert.deepEqual(
        helpers.normalizeVisibleTextBatchRecords([
          { id: 'v1', text: 'Hello world.' },
        ]),
        [{ id: 'v1', text: 'Hello world.' }]
      );
      assert.throws(
        () => helpers.normalizeVisibleTextBatchRecords([{ id: '', text: 'Hello.' }]),
        /Invalid inline translation record id/
      );
    },
  },
```

- [ ] **Step 2: Run tests and verify they fail**

Run:

```bash
npm test
```

Expected: FAIL because `getVisibleInlineBatchMaxChars` and `normalizeVisibleTextBatchRecords` are not exported.

- [ ] **Step 3: Add visible batch constants and pure helpers**

Near the existing background inline constants in `extension/background.js`, add:

```js
const INLINE_VISIBLE_BATCH_MAX_CHARS = 2000;
```

After `normalizeTextNodeRecords(records)`, add:

```js
function getVisibleInlineBatchMaxChars() {
  return INLINE_VISIBLE_BATCH_MAX_CHARS;
}

function normalizeVisibleTextBatchRecords(records) {
  const normalized = normalizeTextNodeRecords(records);
  const totalChars = normalized.reduce(
    (sum, record) => sum + String(record.text || '').length,
    0
  );
  if (totalChars > INLINE_VISIBLE_BATCH_MAX_CHARS) {
    throw new Error(
      `Visible inline translation batch is too large (${totalChars}/${INLINE_VISIBLE_BATCH_MAX_CHARS} characters)`
    );
  }
  return normalized;
}
```

- [ ] **Step 4: Add networked visible batch translation helper**

After `translateTextNodeRecords(records, context = {})`, add:

```js
async function translateVisibleTextBatch(records) {
  const startedAtMs = Date.now();
  const logEntry = createInlineTranslationLogEntry(startedAtMs);
  let completed = false;

  try {
    const normalized = normalizeVisibleTextBatchRecords(records);
    Object.assign(logEntry, getTextRecordStats(normalized));
    logEntry.chunkCount = normalized.length ? 1 : 0;
    logEntry.chunkMaxChars = INLINE_VISIBLE_BATCH_MAX_CHARS;
    logEntry.chunks = normalized.length
      ? [getTextRecordChunkStats(normalized, 1)]
      : [];

    if (!normalized.length) {
      completed = true;
      return [];
    }

    const settings = await getSettings();
    logEntry.model = settings.model;
    if (!settings.apiKey) {
      throw new Error('OpenAI API key is not set. Open Options and paste your key.');
    }

    const chunkStartedAtMs = Date.now();
    const output = await openaiTranslateChunk({
      apiKey: settings.apiKey,
      model: settings.model,
      instructions: buildTextNodeInstructions(settings),
      input: JSON.stringify({ records: normalized }),
      textFormat: buildTextNodeResponseFormat(),
    });

    const translations = parseAndValidateTextNodeTranslations(output, normalized);
    if (logEntry.chunks[0]) {
      logEntry.chunks[0].durationMs = Date.now() - chunkStartedAtMs;
      logEntry.chunks[0].ok = true;
    }
    completed = true;
    return translations;
  } catch (error) {
    logEntry.error = sanitizeLogError(error);
    if (logEntry.chunks[0]) {
      logEntry.chunks[0].ok = false;
      logEntry.chunks[0].error = sanitizeLogError(error);
    }
    throw error;
  } finally {
    const finishedAtMs = Date.now();
    logEntry.status = completed ? 'done' : 'error';
    logEntry.finishedAt = new Date(finishedAtMs).toISOString();
    logEntry.durationMs = finishedAtMs - startedAtMs;
    await appendInlineTranslationLog(logEntry);
  }
}
```

- [ ] **Step 5: Add the new runtime message handler**

In the `chrome.runtime.onMessage` handler, after the existing `TRANSLATE_TEXT_NODES` case, add:

```js
        if (msg?.type === 'TRANSLATE_VISIBLE_TEXT_BATCH') {
          const translations = await translateVisibleTextBatch(msg.records || []);
          sendResponse({ ok: true, translations });
          return;
        }
```

- [ ] **Step 6: Export new helpers**

Add these names to `module.exports`:

```js
    getVisibleInlineBatchMaxChars,
    normalizeVisibleTextBatchRecords,
```

- [ ] **Step 7: Run tests**

Run:

```bash
npm test
```

Expected: PASS.

- [ ] **Step 8: Commit**

Run:

```bash
git add extension/background.js tests/background-helpers.test.js
git commit -m "feat: add visible inline translation batch endpoint"
```

---

### Task 4: Wire Active Viewport Mode In Content Script

**Files:**
- Modify: `extension/content.js`
- Test: `tests/content-helpers.test.js`

- [ ] **Step 1: Add DOM visibility helpers**

Add these after `isElementHidden(el)`:

```js
function getInlineViewportInfo() {
  return {
    width: window.innerWidth || document.documentElement.clientWidth || 0,
    height: window.innerHeight || document.documentElement.clientHeight || 0,
  };
}

function getInlineTextNodeRect(textNode) {
  try {
    const range = document.createRange();
    range.selectNodeContents(textNode);
    const rect = range.getBoundingClientRect();
    range.detach?.();
    if (rect && (rect.width || rect.height)) return rect;
  } catch {}
  return textNode.parentElement?.getBoundingClientRect?.() || null;
}

function isInlineTextNodeInViewport(textNode) {
  return isInlineRectInViewport(
    getInlineTextNodeRect(textNode),
    getInlineViewportInfo()
  );
}
```

- [ ] **Step 2: Add visible text collection**

Add this after `collectInlineTextNodes(root)`:

```js
function collectVisibleInlineTextNodes(root, store) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (shouldSkipInlineTextNode(node)) return NodeFilter.FILTER_REJECT;
      if (!isInlineTextNodeInViewport(node)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  const queued = [];
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const record = queueInlineViewportRecord(store, node, node.nodeValue);
    if (record) queued.push(record);
  }
  return queued;
}
```

- [ ] **Step 3: Add active mode status updater**

Add this after `setInlineMessage(message)`:

```js
function updateInlineViewportMessage() {
  const counts = getInlineViewportStatusCounts(inlineState.viewport?.records || []);
  inlineState.message = formatInlineViewportStatusMessage(counts);
  updateInlineTranslatorUi();
}
```

- [ ] **Step 4: Add queue draining**

Add this before `translateInlinePage()`:

```js
async function drainInlineViewportQueue() {
  const store = inlineState.viewport;
  if (!store || store.stopped || inlineState.status !== 'active') return;

  while (
    inlineState.status === 'active' &&
    !store.stopped &&
    store.inFlight < INLINE_VIEWPORT_MAX_IN_FLIGHT &&
    store.queue.length
  ) {
    const batch = takeInlineViewportBatch(store);
    if (!batch.length) return;
    updateInlineViewportMessage();

    chrome.runtime
      .sendMessage({
        type: 'TRANSLATE_VISIBLE_TEXT_BATCH',
        operationId: inlineState.operationId,
        records: batch.map((record) => ({
          id: record.id,
          text: record.original,
        })),
      })
      .then((resp) => {
        if (inlineState.operationId !== store.operationId) return;
        if (!resp?.ok || !Array.isArray(resp.translations)) {
          markInlineViewportBatchFailed(batch, store.operationId);
          return;
        }
        applyInlineViewportBatchTranslations(
          batch,
          resp.translations,
          store.operationId
        );
      })
      .catch(() => {
        markInlineViewportBatchFailed(batch, store.operationId);
      })
      .finally(() => {
        store.inFlight = Math.max(0, store.inFlight - 1);
        updateInlineViewportMessage();
        drainInlineViewportQueue().catch((error) =>
          setInlineMessage(error?.message || String(error))
        );
      });
  }
}
```

- [ ] **Step 5: Add scan scheduling and mutation observer setup**

Add this before `drainInlineViewportQueue()`:

```js
function runInlineViewportScan() {
  const store = inlineState.viewport;
  if (!store || store.stopped || inlineState.status !== 'active') return;
  const root = store.root || pickArticleRoot();
  if (!root) {
    setInlineMessage('No article content found.');
    return;
  }
  store.root = root;
  collectVisibleInlineTextNodes(root, store);
  updateInlineViewportMessage();
  drainInlineViewportQueue().catch((error) =>
    setInlineMessage(error?.message || String(error))
  );
}

function scheduleInlineViewportScan() {
  const store = inlineState.viewport;
  if (!store || store.stopped || inlineState.status !== 'active') return;
  if (store.scanTimer) clearTimeout(store.scanTimer);
  store.scanTimer = setTimeout(() => {
    store.scanTimer = null;
    runInlineViewportScan();
  }, INLINE_VIEWPORT_SCAN_DEBOUNCE_MS);
}

function attachInlineViewportWatchers(root) {
  window.addEventListener('scroll', scheduleInlineViewportScan, { passive: true });
  window.addEventListener('resize', scheduleInlineViewportScan);

  const observer = new MutationObserver(scheduleInlineViewportScan);
  observer.observe(root, {
    childList: true,
    subtree: true,
    characterData: true,
  });
  inlineState.viewport.observer = observer;
}

function detachInlineViewportWatchers() {
  window.removeEventListener('scroll', scheduleInlineViewportScan);
  window.removeEventListener('resize', scheduleInlineViewportScan);
  if (inlineState.viewport?.observer) {
    inlineState.viewport.observer.disconnect();
    inlineState.viewport.observer = null;
  }
}
```

- [ ] **Step 6: Replace `translateInlinePage()` with active mode startup**

Replace the current `translateInlinePage()` body with:

```js
async function translateInlinePage() {
  if (inlineState.status === 'active') {
    scheduleInlineViewportScan();
    updateInlineViewportMessage();
    return;
  }
  if (!hasInlineTranslationAuthorization()) {
    setInlineMessage(
      'Use the extension toolbar or shortcut first to authorize inline translation.'
    );
    return;
  }

  const root = pickArticleRoot();
  if (!root) throw new Error('No article content found.');

  detachInlineViewportWatchers();
  inlineState.operationId = (Number(inlineState.operationId) || 0) + 1;
  inlineState.status = 'active';
  inlineState.viewport = createInlineViewportStore(inlineState.operationId);
  inlineState.viewport.root = root;
  inlineState.records = inlineState.viewport.records;

  attachInlineViewportWatchers(root);
  runInlineViewportScan();
}
```

- [ ] **Step 7: Update restore behavior**

Replace `restoreInlineOriginal()` with:

```js
function restoreInlineOriginal() {
  detachInlineViewportWatchers();
  restoreInlineViewportRecords(inlineState);
  setInlineMessage('');
  updateInlineTranslatorUi();
}
```

- [ ] **Step 8: Add stop behavior and menu button**

In the `inlineUiRoot.innerHTML` menu markup, add the stop button between `Page in Korean` and `Original text`:

```html
        <button type="button" data-action="stop">Stop</button>
```

After the translate button event listener, add:

```js
  inlineUiRoot
    .querySelector('[data-action="stop"]')
    .addEventListener('click', (event) => {
      if (!isTrustedInlineUiEvent(event)) return;
      if (inlineState.viewport) {
        inlineState.viewport.stopped = true;
        inlineState.viewport.queue = [];
      }
      detachInlineViewportWatchers();
      updateInlineViewportMessage();
    });
```

- [ ] **Step 9: Update the floating button label**

In `updateInlineTranslatorUi()`, replace the `toggle.textContent = ...` expression with:

```js
  toggle.textContent =
    inlineState.status === 'active'
      ? 'Translated'
      : inlineState.status === 'translating'
      ? 'Translating...'
      : inlineState.status === 'translated'
      ? 'Translated'
      : 'Translate';
```

- [ ] **Step 10: Run tests and syntax checks**

Run:

```bash
npm test
npm run check:syntax
```

Expected: both commands PASS.

- [ ] **Step 11: Commit**

Run:

```bash
git add extension/content.js tests/content-helpers.test.js
git commit -m "feat: translate visible inline text progressively"
```

---

### Task 5: Update README And Do Focused Manual Verification

**Files:**
- Modify: `README.md`
- Test: Chrome extension manual verification

- [ ] **Step 1: Update README inline usage text**

Replace the inline translation steps in `README.md` with:

```markdown
For inline page translation:

1. Click the extension toolbar icon or press the shortcut on the target page.
2. Open the floating **Translate** button.
3. Choose **Page in Korean** to start viewport-first inline translation.
4. As you scroll, newly visible article text is translated and kept in place.
5. Choose **Stop** to stop translating newly visible text while keeping current
   translations.
6. Choose **Original text** to restore the page text that was replaced.
```

Replace the inline note that currently says inline translation skips pages with too many text nodes or characters with:

```markdown
- Inline translation skips code-like text, links, filenames, commands, and page
  chrome. It translates visible article text in small batches while active.
```

- [ ] **Step 2: Run automated checks**

Run:

```bash
npm test
npm run check:syntax
```

Expected: both commands PASS.

- [ ] **Step 3: Manual verification in Chrome**

Load the extension from `/Users/jw.kim/workspaces/chrome-ai-translator/extension` and verify:

```text
1. Existing side panel translation still opens from the toolbar action.
2. The floating Translate button appears after toolbar or shortcut activation.
3. Page in Korean starts active viewport translation.
4. The current visible article area translates before below-the-fold text.
5. Scrolling down translates newly visible paragraphs.
6. Already translated paragraphs remain translated after they leave the viewport.
7. Stop prevents new text from being queued while keeping current translations.
8. Original text restores all translated text from the active session.
9. API failure leaves successful batches translated and failed batches original.
10. Code blocks, inline code, URL-like text, filenames, and page chrome stay unchanged.
```

- [ ] **Step 4: Commit**

Run:

```bash
git add README.md
git commit -m "docs: explain viewport inline translation"
```

---

## Final Verification

After all tasks are complete, run:

```bash
npm test
npm run check:syntax
git status --short
```

Expected:

```text
npm test: all tests pass
npm run check:syntax: all checked extension scripts pass
git status --short: no tracked implementation files left unstaged
```

The `.superpowers/` brainstorming directory may still appear as untracked local scratch data if it has not been removed or ignored. Do not include it in implementation commits.
