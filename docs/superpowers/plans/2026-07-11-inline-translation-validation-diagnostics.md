# Inline Translation Validation and Diagnostics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply structurally safe inline translations even when quality assessment remains uncertain, while preserving privacy-safe diagnostics that explain every partial translation and failure.

**Architecture:** Extract pure validation and disposition policy from `background.js`, then let the background service worker own the initial request and single model-repair lifecycle. Keep live DOM ownership and page-change retries in `content.js`; persist only allowlisted schema-2 diagnostic metadata through a focused diagnostics module.

**Tech Stack:** Chrome Extension Manifest V3, plain JavaScript/CommonJS-compatible modules, OpenAI Responses API structured output, `chrome.storage.local`, Node's built-in test runner harness and assertions.

## Global Constraints

- Never weaken protected-token, wrapper-parent, patch-plan, or live DOM ownership checks.
- A logical block makes at most one initial model request and one model-output repair request.
- Page-change retry remains independent and limited to one retry.
- Persist no source prose, translated prose, matched residue words, URL, title, origin, tab ID, protected label, literal-token value, prompt, request body, response body, API key, authorization header, or raw exception.
- Keep the most recent 20 runs and at most 100 problem blocks per run.
- Read and write diagnostic schema version 2 only; delete legacy `inlineTranslationLogs` keys on the first schema-2 write.
- Do not change full-page Side Panel translation, API-key storage, or page-lifetime translation cache behavior.
- Do not add dependencies, cloud reporting, configurable retention, unlimited retries, or a model-based translation judge.
- Chrome 116 remains the minimum supported browser.

---

## File Map

- Create `extension/translation-validation.js`: pure protocol, structure, and quality validation; stable codes; privacy-safe evidence.
- Create `extension/translation-policy.js`: pure attempt/disposition state machine and user-message keys.
- Create `extension/translation-diagnostics.js`: schema-2 run builder, allowlist serialization, HMAC fingerprints, retention, legacy cleanup, and export serialization.
- Modify `extension/background.js`: load the three modules, orchestrate initial/repair requests, return terminal dispositions, and finalize diagnostics.
- Modify `extension/content.js`: consume terminal dispositions, adopt the new state model, keep page-change retry only, and expose precise UI summaries.
- Modify `extension/options.html`: replace legacy log refresh UI with schema-2 diagnostic summary, copy, and save controls.
- Modify `extension/options.js`: render schema-2 summaries and export the exact redacted JSON.
- Modify `extension/styles.css`: style diagnostic action controls and partial/failure summaries using existing layout conventions.
- Modify `extension/manifest.json`: load new service-worker dependencies through `importScripts`; change no permissions unless Chrome verification proves an anchor-based download cannot work.
- Modify `package.json`: include all new extension modules in `check:syntax`.
- Create `tests/translation-validation.test.js`: validation and Claude Docs regression coverage.
- Create `tests/translation-policy.test.js`: complete disposition table and retry-budget coverage.
- Create `tests/translation-diagnostics.test.js`: privacy, HMAC, schema, retention, and migration coverage.
- Modify `tests/background-helpers.test.js`: request/repair orchestration and terminal-result integration.
- Modify `tests/content-helpers.test.js`: new states, counts, UI messages, and DOM application policy.
- Modify `tests/options-helpers.test.js`: schema-2 rendering and export payload tests.
- Modify `tests/static-assets.test.js`: new scripts, syntax checks, and diagnostic controls.
- Modify `tests/run.js`: register the three new suites.
- Modify `README.md`: document partial results, precise failure reasons, and privacy-safe exports.

---

### Task 1: Extract Protocol, Structure, and Quality Validation

**Files:**
- Create: `extension/translation-validation.js`
- Create: `tests/translation-validation.test.js`
- Modify: `tests/run.js`
- Modify: `extension/background.js`

**Interfaces:**
- Consumes: `inlineBlockCodec.validateTranslatedTemplate(template, contract)` from `extension/inline-block.js`.
- Produces: `validateBlockResponse(outputText, records, options)` returning `{ protocol, records }` where each record contains `{ id, template, structure, quality }`.
- Produces: `assessTranslationQuality(sourceValidation, translatedValidation, literalTokens, targetLanguage)` returning only status, codes, and numeric evidence.
- Produces: stable constants `PROTOCOL_CODES`, `STRUCTURE_CODES`, and `QUALITY_CODES`.

- [ ] **Step 1: Register a failing validation suite**

Add the suite to `tests/run.js` before background integration tests:

```js
const suites = [
  require('./inline-block.test'),
  require('./translation-validation.test'),
  require('./translation-policy.test'),
  require('./translation-diagnostics.test'),
  require('./content-helpers.test'),
  require('./background-helpers.test'),
  require('./options-helpers.test'),
  require('./sidepanel-helpers.test'),
  require('./static-assets.test'),
];
```

Create temporary empty exports for the Task 2 and Task 3 suites so the harness can load while this task proceeds:

```js
exports.name = 'translation policy';
exports.tests = [];
```

```js
exports.name = 'translation diagnostics';
exports.tests = [];
```

- [ ] **Step 2: Write failing protocol and structure tests**

In `tests/translation-validation.test.js`, build records from `createReasoningFixture()` and assert exact codes:

```js
const assert = require('node:assert/strict');
const validation = require('../extension/translation-validation.js');
const { createReasoningFixture } = require('./inline-block.test');

function createRecord(id = 'b1') {
  const { serialized } = createReasoningFixture();
  return { id, ...serialized };
}

exports.name = 'translation validation';
exports.tests = [
  {
    name: 'reports a missing protected token as unsafe structure',
    fn() {
      const record = createRecord();
      const output = JSON.stringify({
        translations: [{ id: record.id, template: '보호 토큰 없음' }],
      });
      const result = validation.validateBlockResponse(output, [record], {
        targetLanguage: 'Korean',
      });
      assert.equal(result.protocol.status, 'valid');
      assert.equal(result.records[0].structure.status, 'unsafe');
      assert.deepEqual(result.records[0].structure.codes, [
        'structure.token_missing',
      ]);
    },
  },
  {
    name: 'throws a stable protocol code for a missing response id',
    fn() {
      const record = createRecord();
      assert.throws(
        () =>
          validation.validateBlockResponse(
            JSON.stringify({ translations: [] }),
            [record],
            { targetLanguage: 'Korean' }
          ),
        (error) => error.code === 'protocol.missing_id'
      );
    },
  },
];
```

- [ ] **Step 3: Write failing quality and privacy tests**

Add cases that assert:

```js
assert.deepEqual(result.records[0].quality, {
  status: 'partial',
  codes: ['quality.english_residue'],
  evidence: {
    sourceChars: 55,
    outputChars: 37,
    sharedEnglishSequenceLength: 3,
    sharedEnglishSequenceCount: 1,
  },
});
assert.equal(JSON.stringify(result).includes('This is source prose'), false);
```

Add a permanent Claude Docs regression fixture using this exact source prose:

```text
Claude Code reads CLAUDE.md, not AGENTS.md. If your repository already uses AGENTS.md for other coding agents, create a CLAUDE.md that imports it so both tools read the same instructions without duplicating them.
```

Represent `Claude Code`, `CLAUDE.md`, and `AGENTS.md` as protected atoms. Assert a Korean translation that retains those atoms is `complete`, not `partial`.

- [ ] **Step 4: Run the focused suite and confirm failure**

Run:

```bash
node tests/run.js
```

Expected: `MODULE_NOT_FOUND` for `extension/translation-validation.js` or assertion failures for undefined validation exports.

- [ ] **Step 5: Implement the pure validation module**

Move and adapt the current residue helpers from `background.js`. Export through the browser global and CommonJS:

```js
(function initTranslationValidation(globalScope) {
  const api = {
    validateBlockResponse,
    assessTranslationQuality,
    PROTOCOL_CODES,
    STRUCTURE_CODES,
    QUALITY_CODES,
  };
  globalScope.ChromeAiTranslatorValidation = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
```

Map codec failures deterministically:

```js
function mapStructureCode(errorCode) {
  const known = new Set([
    'token_missing',
    'token_duplicate',
    'token_unknown',
    'token_nesting_invalid',
    'token_parent_changed',
    'output_too_long',
    'output_parse_failed',
  ]);
  return known.has(errorCode)
    ? `structure.${errorCode}`
    : 'structure.output_parse_failed';
}
```

Return the translated template only as the transient `template` field used by policy/orchestration. Ensure diagnostic-facing structures are constructed separately and never serialize that field.

- [ ] **Step 6: Load the validator in the service worker and remove duplicate helpers**

At the top of `background.js`, load dependencies in order:

```js
if (typeof importScripts === 'function') {
  if (!globalThis.ChromeAiTranslatorInlineBlock) importScripts('inline-block.js');
  if (!globalThis.ChromeAiTranslatorValidation) {
    importScripts('translation-validation.js');
  }
}
```

Use `globalThis.ChromeAiTranslatorValidation` in Chrome and `require('./translation-validation.js')` in Node. Delete the moved quality/residue functions and the old `parseAndValidateBlockTranslations` implementation from `background.js`.

- [ ] **Step 7: Run validation and existing regression tests**

Run:

```bash
node tests/run.js
npm run check:syntax
```

Expected: all registered tests pass; all extension scripts parse successfully.

- [ ] **Step 8: Commit the validation contract**

```bash
git add extension/translation-validation.js extension/background.js tests/translation-validation.test.js tests/translation-policy.test.js tests/translation-diagnostics.test.js tests/run.js
git commit -m "refactor: separate inline translation validation"
```

---

### Task 2: Add the Disposition and Repair Policy

**Files:**
- Create: `extension/translation-policy.js`
- Modify: `tests/translation-policy.test.js`
- Modify: `extension/background.js`
- Modify: `tests/background-helpers.test.js`

**Interfaces:**
- Consumes: validation records `{ id, template, structure, quality }` from Task 1.
- Produces: `decideBlockDisposition(validationRecord, attempt)` where `attempt` is `1 | 2`.
- Produces: `{ disposition, repairKind, terminalCode, messageKey }` with no source/output text.
- Produces: `translateVisibleBlockBatch(records, settingsSnapshot, options, dependencies)` returning only terminal results.

- [ ] **Step 1: Write the complete failing policy table**

Replace the placeholder suite with table-driven tests:

```js
const cases = [
  ['safe complete initial', 1, 'safe', 'complete', 'apply', null],
  ['safe partial initial', 1, 'safe', 'partial', 'retry', 'quality'],
  ['safe uncertain initial', 1, 'safe', 'uncertain', 'retry', 'quality'],
  ['unsafe initial', 1, 'unsafe', 'complete', 'retry', 'structure'],
  ['safe partial repair', 2, 'safe', 'partial', 'apply_with_warning', null],
  ['safe uncertain repair', 2, 'safe', 'uncertain', 'apply_with_warning', null],
  ['unsafe repair', 2, 'unsafe', 'complete', 'reject', null],
];
```

For each row, assert exact `disposition` and `repairKind`. Add an invariant test that `apply` and `apply_with_warning` are impossible when structure is `unsafe`.

- [ ] **Step 2: Run the suite and verify failure**

Run `node tests/run.js`.

Expected: the translation policy suite fails because `decideBlockDisposition` is missing.

- [ ] **Step 3: Implement the pure policy module**

Use an exhaustive function with explicit attempt validation:

```js
function decideBlockDisposition(record, attempt) {
  if (attempt !== 1 && attempt !== 2) {
    throw new TypeError('attempt must be 1 or 2');
  }
  if (record.structure.status === 'unsafe') {
    return attempt === 1
      ? decision('retry', 'structure', firstCode(record.structure.codes), 'repairing_structure')
      : decision('reject', null, firstCode(record.structure.codes), 'unsafe_translation_rejected');
  }
  if (record.quality.status === 'complete') {
    return decision('apply', null, null, 'translation_complete');
  }
  const code = firstCode(record.quality.codes) || 'quality.target_language_uncertain';
  return attempt === 1
    ? decision('retry', 'quality', code, 'repairing_quality')
    : decision('apply_with_warning', null, code, 'partial_translation_applied');
}
```

- [ ] **Step 4: Write failing background orchestration tests**

Inject a fake `requestTranslation` dependency and assert:

- initial complete result makes one request;
- initial partial then complete makes two requests and applies the repair;
- initial unsafe then unsafe makes two requests and rejects;
- one record needing repair does not resend already terminal sibling records;
- repair payload contains `{ attempt: 1, previousErrorCode }` but no token contract or raw diagnostics.

Use explicit call assertions:

```js
assert.equal(requests.length, 2);
assert.deepEqual(requests[1].records.map(({ id, repair }) => ({ id, repair })), [
  { id: 'b1', repair: { attempt: 1, previousErrorCode: 'quality.english_residue' } },
]);
```

- [ ] **Step 5: Refactor background orchestration minimally**

Create an internal helper:

```js
async function resolveBlockTranslations(records, settings, requestTranslation) {
  const initial = await requestTranslation(records, settings);
  const terminal = [];
  const repairRecords = [];
  // decide each initial record; collect only retry dispositions
  // request repairs once; decide repair records with attempt 2
  return terminal.sort(byOriginalRecordOrder(records));
}
```

Terminal results sent to content must be exactly:

```js
{
  id,
  disposition: 'apply' | 'apply_with_warning' | 'reject',
  template: disposition === 'reject' ? undefined : validatedTemplate,
  terminalCode: string | null,
  messageKey: string,
  attemptCount: 1 | 2,
  diagnostic: { structure, quality, timeline }
}
```

The `diagnostic` field is metadata only and contains no template or prose.

- [ ] **Step 6: Run focused and full tests**

Run:

```bash
node tests/run.js
npm run check:syntax
```

Expected: all suites pass and no logical block exceeds two request calls.

- [ ] **Step 7: Commit policy and orchestration**

```bash
git add extension/translation-policy.js extension/background.js tests/translation-policy.test.js tests/background-helpers.test.js
git commit -m "feat: distinguish safe partial inline translations"
```

---

### Task 3: Persist Privacy-Safe Schema-2 Diagnostics

**Files:**
- Create: `extension/translation-diagnostics.js`
- Modify: `tests/translation-diagnostics.test.js`
- Modify: `extension/background.js`
- Modify: `tests/background-helpers.test.js`

**Interfaces:**
- Consumes: terminal metadata from Task 2 plus transient source-template and
  canonical-contract strings used only as HMAC inputs. The serializer never
  receives or persists those strings.
- Produces: `createRunDiagnostic(meta)`, `addProblemBlock(run, block)`, `finalizeRun(run, outcome)`, `persistRun(chromeApi, run)`, and `exportDiagnostics(stored)`.
- Produces: async `fingerprint(secretBytes, value)` using Web Crypto HMAC-SHA-256.

- [ ] **Step 1: Write failing allowlist and schema tests**

Replace the placeholder suite and construct hostile input containing `source`, `template`, `url`, `apiKey`, `atoms`, `requestBody`, and a raw `Error`. Assert none survive:

```js
const json = JSON.stringify(diagnostics.serializeProblemBlock(hostileBlock));
for (const secret of [
  'source prose',
  'translated prose',
  'https://example.com/private',
  'sk-test-secret',
  'protected label',
]) {
  assert.equal(json.includes(secret), false);
}
assert.equal(JSON.parse(json).terminalCode, 'structure.token_missing');
```

- [ ] **Step 2: Write failing HMAC, retention, and migration tests**

Use fixed byte arrays to prove:

```js
assert.equal(await fingerprint(secretA, 'same input'), await fingerprint(secretA, 'same input'));
assert.notEqual(await fingerprint(secretA, 'same input'), await fingerprint(secretB, 'same input'));
```

Create 21 runs and 101 problem blocks; assert output retains 20 runs and 100 blocks. Mock storage containing legacy aggregate and per-run keys; assert first `persistRun` removes all keys matching `inlineTranslationLogs` and `inlineTranslationLogs:*`.

- [ ] **Step 3: Run the suite and confirm failure**

Run `node tests/run.js`.

Expected: missing diagnostics exports or failed schema assertions.

- [ ] **Step 4: Implement schema construction and allowlist serialization**

Define constants:

```js
const DIAGNOSTIC_SCHEMA_VERSION = 2;
const DIAGNOSTIC_INDEX_KEY = 'inlineDiagnostics:v2:index';
const DIAGNOSTIC_RUN_PREFIX = 'inlineDiagnostics:v2:run:';
const INSTALL_SECRET_KEY = 'inlineDiagnostics:v2:hmacSecret';
const MAX_RUNS = 20;
const MAX_PROBLEM_BLOCKS = 100;
```

Construct persisted objects field-by-field. Do not spread caller-owned objects. Use code allowlists for `terminalCode`, `structure.codes`, and `quality.codes`; unknown values become `runtime.request_failed` rather than persisting arbitrary strings.

- [ ] **Step 5: Implement installation-scoped HMAC**

Use `crypto.subtle` in Chrome and Node's standards-compatible `globalThis.crypto.subtle`:

```js
const key = await crypto.subtle.importKey(
  'raw',
  secretBytes,
  { name: 'HMAC', hash: 'SHA-256' },
  false,
  ['sign']
);
const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value));
return `hmac-sha256:${toBase64Url(new Uint8Array(signature))}`;
```

Generate 32 random bytes once with `crypto.getRandomValues`, store only the base64url secret locally, and never include it in export output.

- [ ] **Step 6: Implement bounded storage and interrupted-run recovery**

Store each run under its own key and the ordered IDs in the index. On every write:

1. mark older unfinished runs `interrupted`;
2. write the current sanitized run;
3. trim the index to 20 IDs;
4. remove evicted run keys;
5. remove legacy aggregate and prefixed keys;
6. swallow storage failures after returning a structured `{ persisted: false }` result.

- [ ] **Step 7: Integrate diagnostics into background orchestration**

Create the run before the initial request. Add block detail only when a block is repaired, partial, rejected, changed, or application-failed. Because final DOM application happens in content, add a runtime message:

```js
{
  type: 'FINALIZE_INLINE_BLOCK_APPLICATION',
  runId,
  outcomes: [{ diagnosticId, applied: true, runtimeCode: null }]
}
```

Background finalizes the stored run after receiving application outcomes or marks it `interrupted` on the next write if no finalization arrives.

- [ ] **Step 8: Run privacy and integration tests**

Run:

```bash
node tests/run.js
npm run check:syntax
```

Expected: all tests pass; hostile secret strings never occur in serialized diagnostics.

- [ ] **Step 9: Commit diagnostics**

```bash
git add extension/translation-diagnostics.js extension/background.js tests/translation-diagnostics.test.js tests/background-helpers.test.js
git commit -m "feat: persist privacy-safe inline diagnostics"
```

---

### Task 4: Adopt Terminal Dispositions and Precise Inline UI States

**Files:**
- Modify: `extension/content.js`
- Modify: `tests/content-helpers.test.js`

**Interfaces:**
- Consumes: terminal results `{ id, disposition, template, terminalCode, messageKey, attemptCount, diagnosticId, runId }` from Task 2/3.
- Produces: content states `translated`, `translated_with_warning`, `failed`, and existing `stale` mapped to user-facing `changed`.
- Produces: `getInlineViewportStatusCounts()` returning `{ translated, partial, pending, changed, failed }`.

- [ ] **Step 1: Write failing status and application tests**

Add tests for all terminal dispositions:

```js
assert.deepEqual(
  helpers.getInlineViewportStatusCounts([
    { state: 'translated' },
    { state: 'translated_with_warning' },
    { state: 'queued' },
    { state: 'stale' },
    { state: 'failed' },
  ]),
  { translated: 1, partial: 1, pending: 1, changed: 1, failed: 1 }
);
```

Assert `apply_with_warning` applies the validated template, sets the warning state, and retains `terminalCode`. Assert `reject` leaves the original block unchanged and does not enter the page cache.

- [ ] **Step 2: Write failing retry-separation tests**

Assert:

- content does not queue token/quality repair records;
- a rejected model result is terminal for that operation;
- a live page ownership conflict may still queue one page-change retry;
- page-change retry metadata never contains `previousErrorCode` from model validation.

- [ ] **Step 3: Run focused tests and confirm failure**

Run `node tests/run.js`.

Expected: count-shape and disposition assertions fail against the old `ok/errorCode` contract.

- [ ] **Step 4: Replace content-side repair handling**

Delete `INLINE_BLOCK_REPAIRABLE_ERROR_CODES`, `repairRetryCount`, and the `repair` branch from `queueInlineViewportBlockRetry`. Keep only page-change retry metadata.

Refactor result application:

```js
if (result.disposition === 'reject') {
  record.state = 'failed';
  record.terminalCode = result.terminalCode;
  record.attemptCount = result.attemptCount;
  return;
}
const applyResult = inlineBlockCodec.applyTranslatedTemplate(
  record.snapshot,
  result.template
);
if (!applyResult.ok) {
  record.state = 'failed';
  record.terminalCode = 'runtime.apply_failed';
  return;
}
record.state =
  result.disposition === 'apply_with_warning'
    ? 'translated_with_warning'
    : 'translated';
```

Cache both successful states; never cache rejected or apply-failed records.

- [ ] **Step 5: Implement precise counts and messages**

Return the five-part count and format:

```text
Visible translation on
Translated 12 · Partial 1 · Pending 0 · Changed 0 · Failed 1
```

Map stable message keys to fixed human copy in content code. Show the most recent partial and failure reason beneath the count. Change the manual recovery label to `Retry failed blocks` only when terminal failures are present and safe to start as a new operation.

- [ ] **Step 6: Send application finalization metadata**

After applying a terminal batch, send `FINALIZE_INLINE_BLOCK_APPLICATION` with opaque run/diagnostic IDs and runtime outcomes only. Do not include templates, originals, block labels, or DOM data.

- [ ] **Step 7: Run full content and syntax verification**

Run:

```bash
node tests/run.js
npm run check:syntax
```

Expected: all tests pass; existing restore, cache, stop, and page-change tests remain green.

- [ ] **Step 8: Commit the new state model**

```bash
git add extension/content.js tests/content-helpers.test.js
git commit -m "feat: expose partial and failed inline states"
```

---

### Task 5: Replace Legacy Logs with RCA Export Controls

**Files:**
- Modify: `extension/options.html`
- Modify: `extension/options.js`
- Modify: `extension/styles.css`
- Modify: `tests/options-helpers.test.js`
- Modify: `tests/static-assets.test.js`

**Interfaces:**
- Consumes: `translationDiagnostics.exportDiagnostics(stored)` schema-2 JSON from Task 3.
- Produces: concise run summaries plus `Copy diagnostics` and `Save diagnostics` actions.

- [ ] **Step 1: Write failing formatter and export tests**

Replace the legacy chunk-log test with schema-2 assertions:

```js
const formatted = helpers.formatDiagnosticRun({
  startedAt: '2026-07-11T00:00:00.000Z',
  outcome: 'partial',
  model: 'gpt-5.4-mini',
  summary: { requested: 1, translated: 0, translatedWithWarning: 1, failed: 0, repairs: 1 },
  blocks: [{ terminalCode: 'quality.english_residue', terminalDisposition: 'apply_with_warning' }],
});
assert.match(formatted, /Partial 1/);
assert.match(formatted, /quality\.english_residue/);
```

Assert `buildDiagnosticExport()` returns schema-2 objects without the installation HMAC secret or any settings API key.

- [ ] **Step 2: Write failing static control tests**

Assert `options.html` contains unique buttons `btnCopyDiagnostics` and `btnSaveDiagnostics`, does not contain `btnRefreshInlineLogs`, and retains touch-sized `.btn` behavior.

- [ ] **Step 3: Run tests and confirm failure**

Run `node tests/run.js`.

Expected: old formatter/control names cause failures.

- [ ] **Step 4: Replace the Options diagnostic section**

Use:

```html
<section>
  <h2>Inline diagnostics</h2>
  <p class="muted">
    Recent partial translations and failures. Source text, translations,
    URLs, protected labels, and API keys are never stored.
  </p>
  <div class="row diagnostic-actions">
    <button id="btnCopyDiagnostics" class="btn">Copy diagnostics</button>
    <button id="btnSaveDiagnostics" class="btn">Save diagnostics</button>
  </div>
  <pre id="inlineDiagnostics" class="muted"></pre>
</section>
```

- [ ] **Step 5: Implement schema-2 rendering and copy**

Load only diagnostic index/run keys. Render run outcome, counts, model, duration, and stable terminal codes. Copy exactly `JSON.stringify(exportPayload, null, 2)` through `navigator.clipboard.writeText` and show `Diagnostics copied.` on success.

- [ ] **Step 6: Implement save without new permissions**

Create a Blob, object URL, and temporary anchor in the Options document:

```js
const blob = new Blob([JSON.stringify(payload, null, 2)], {
  type: 'application/json',
});
const link = document.createElement('a');
link.href = URL.createObjectURL(blob);
link.download = `chrome-ai-translator-diagnostics-${dateStamp}.json`;
link.click();
const objectUrl = link.href;
setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
```

Verify in Chrome. Add the `downloads` permission only if this exact user-gesture path fails; if permission becomes necessary, stop and update the design before proceeding.

- [ ] **Step 7: Run tests and commit**

Run:

```bash
node tests/run.js
npm run check:syntax
```

Expected: all tests pass.

Commit:

```bash
git add extension/options.html extension/options.js extension/styles.css tests/options-helpers.test.js tests/static-assets.test.js
git commit -m "feat: export inline translation diagnostics"
```

---

### Task 6: Wire Assets, Documentation, and End-to-End Regression Verification

**Files:**
- Modify: `extension/manifest.json`
- Modify: `package.json`
- Modify: `README.md`
- Modify: `tests/static-assets.test.js`
- Modify: `tests/qa-issue-003.regression-1.test.js`

**Interfaces:**
- Consumes: all modules and UI behavior from Tasks 1-5.
- Produces: a loadable extension, documented behavior, and reproducible regression evidence.

- [ ] **Step 1: Write failing asset-order and syntax tests**

Assert `background.js` imports modules in dependency order:

```text
inline-block.js
translation-validation.js
translation-policy.js
translation-diagnostics.js
```

Assert `package.json` checks each new file with `node --check`.

- [ ] **Step 2: Update the syntax script**

Set `check:syntax` to check all extension JavaScript, including the three new modules, without introducing a shell glob whose behavior differs across platforms.

- [ ] **Step 3: Update README behavior and privacy contract**

Document:

- `Partial` versus `Failed`;
- one model repair and one independent page-change retry;
- structurally unsafe output is never applied;
- exact privacy exclusions;
- 20-run/100-problem-block retention;
- how to copy or save diagnostics for Codex RCA;
- legacy inline logs are removed rather than migrated.

- [ ] **Step 4: Run the complete automated verification**

Run:

```bash
npm test
npm run check:syntax
git diff --check
```

Expected:

- every suite prints `PASS` with no `FAIL` lines;
- every extension script passes `node --check`;
- `git diff --check` prints no output.

- [ ] **Step 5: Perform Chrome regression verification**

Reload the unpacked extension, open:

```text
https://code.claude.com/docs/en/memory#agents-md
```

At the `AGENTS.md` section:

1. choose `Page in Korean`;
2. wait for terminal counts;
3. confirm the visible block is `Translated` or `Partial`, never silently discarded by quality assessment;
4. confirm any partial reason is visible in human language;
5. use Options to copy diagnostics;
6. inspect the exported JSON for the initial/repair timeline and terminal disposition;
7. search the JSON for the page URL, visible source sentence, Korean output, `CLAUDE.md`, `AGENTS.md`, and API-key prefixes; each search must return no match;
8. restore original text and confirm exact DOM restoration;
9. rerun translation and confirm existing page-lifetime cache behavior still works for successfully applied blocks.

- [ ] **Step 6: Verify a forced unsafe-output scenario**

Use the existing deterministic test fixture rather than modifying production prompts. Confirm automated integration coverage proves:

- unsafe initial output requests one repair;
- unsafe repaired output remains original;
- UI shows a human failure reason;
- diagnostics contain `structure.token_missing` and two bounded timeline stages;
- no raw template appears in stored/exported data.

- [ ] **Step 7: Final review and commit**

Review the complete diff for unrelated refactors and legacy symbols:

```bash
rg -n "inlineTranslationLogs|btnRefreshInlineLogs|parseAndValidateBlockTranslations|INLINE_BLOCK_REPAIRABLE_ERROR_CODES" extension tests README.md
```

Expected: no production reference remains; any test reference exists only to verify legacy cleanup.

Commit:

```bash
git add extension/manifest.json package.json README.md tests/static-assets.test.js tests/qa-issue-003.regression-1.test.js
git commit -m "docs: document reliable inline translation failures"
```

---

## Final Verification Checklist

- [ ] `npm test` passes with no failures.
- [ ] `npm run check:syntax` passes for every extension script.
- [ ] `git diff --check` prints no output.
- [ ] No logical block performs more than two model requests.
- [ ] Unsafe structure never reaches DOM application.
- [ ] Safe partial output is applied only after one repair attempt.
- [ ] Partial, changed, and failed counts remain distinct.
- [ ] Every partial or failed block has a stable terminal code and bounded timeline.
- [ ] Exported diagnostics reconstruct initial validation, repair validation, and terminal disposition.
- [ ] Persisted/exported diagnostics contain none of the forbidden sensitive fields or values.
- [ ] The Claude Docs `AGENTS.md` scenario is translated or explicitly partial.
- [ ] Original-text restore and page-lifetime cache regressions pass.
