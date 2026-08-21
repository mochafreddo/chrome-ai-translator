const assert = require('node:assert/strict');
const helpers = require('../extension/background.js');
const contentHelpers = require('../extension/content.js');
const fullPageMarkdown = require('../extension/full-page-markdown.js');
const { createReasoningFixture } = require('./inline-block.test');
const { DEFAULT_MODEL } = require('../extension/default-model.js');

// Per-tab state is the worker's alone, and the only account of it a caller gets is the
// STATE_UPDATED broadcast the panel listens to. Collecting those is how a test sees both
// what was recorded and, just as importantly, when nothing was.
function createStateBroadcastChrome(broadcasts) {
  return {
    runtime: {
      async sendMessage(message) {
        broadcasts.push(message);
      },
    },
  };
}

function createCompletedResponse(outputText) {
  return {
    status: 'completed',
    output: [{
      type: 'message',
      content: [{ type: 'output_text', text: outputText }],
    }],
  };
}

function createIncompleteResponse() {
  return {
    status: 'incomplete',
    incomplete_details: { reason: 'max_output_tokens' },
    output: [],
  };
}

function createProtectedFullPageChunk() {
  const namespace = 'CAT_RECOVERY';
  const link = {
    id: 'L1',
    kind: 'link',
    openToken: `⟦${namespace}:LINK_OPEN:L1⟧`,
    closeToken: `⟦${namespace}:LINK_CLOSE:L1⟧`,
    destination: 'https://private.test/path?token=secret',
  };
  const code = {
    id: 'C1',
    kind: 'code',
    token: `⟦${namespace}:ATOM:C1⟧`,
    display: 'inline',
    value: 'private-command --secret',
    language: '',
  };
  const documentModel = {
    namespace,
    entries: [link, code],
    blocks: [
      {
        id: 'm1',
        kind: 'paragraph',
        template: `Read ${link.openToken}the guide${link.closeToken}.`,
        entries: [link.id],
      },
      {
        id: 'm2',
        kind: 'paragraph',
        template: `Run ${code.token} now.`,
        entries: [code.id],
      },
    ],
  };
  const [chunk] = fullPageMarkdown.createTranslationChunks(documentModel, 200);
  return { chunk, link, code };
}

function createApiErrorResponse(message) {
  return { apiError: message };
}

// Drives one request and hands back the body it carried. The two checks that use it are about
// what goes out rather than what comes back, so the answer is fixed and the request is what is
// kept. The network is the whole platform, because building a request reaches no Chrome
// namespace.
async function runTranslationRequest(request) {
  let requestBody = null;
  const worker = helpers.createBackgroundWorker({
    fetch: async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return {
        ok: true,
        async json() {
          return createCompletedResponse('번역 결과');
        },
      };
    },
  });

  const output = await worker.openaiTranslateChunk(request);
  return { requestBody, output };
}

const FULL_PAGE_SETTINGS = Object.freeze({
  apiKey: 'sk-test',
  model: 'gpt-5.4-mini',
  reasoningEffort: 'none',
  targetLanguage: 'Korean',
  tone: 'technical',
});

// Drives one Translation Chunk against a queue of answers and hands back what each request
// carried, because every check below is about how many attempts were made and what the later
// ones said. A queue that runs dry is a test asserting on an attempt that was never made, so
// the extra request fails loudly instead of replaying the last answer.
//
// The network is the whole platform this worker gets. Translating a chunk decides how many
// requests to make and what each one says, and reaches nothing else: a chunk that fails
// throws to its caller rather than recording anything, so there is no per-tab state to
// broadcast and no Chrome namespace to hand over.
async function runFullPageChunk(chunk, responses, settings = FULL_PAGE_SETTINGS) {
  const queue = [...responses];
  const requestBodies = [];
  const worker = helpers.createBackgroundWorker({
    fetch: async (_url, options) => {
      requestBodies.push(JSON.parse(options.body));
      if (!queue.length) {
        throw new Error(`Unexpected full-page request #${requestBodies.length}`);
      }
      const response = queue.shift();
      if (response?.apiError) {
        return {
          ok: false,
          status: 400,
          async json() {
            return { error: { message: response.apiError } };
          },
        };
      }
      return { ok: true, async json() { return response; } };
    },
  });

  try {
    const translated = await worker.translateFullPageChunk(chunk, settings);
    return { requestBodies, translated, error: null };
  } catch (error) {
    return { requestBodies, translated: null, error };
  }
}

// The four ways an answer can break the token contract, each written as an answer a model
// could really return. They share a cause — the tokens were handled rather than carried —
// which is why one correction is expected to speak to all four.
function createTokenFailureAnswers({ link, code }) {
  return [
    {
      code: 'markdown.token_missing',
      answer: `읽기 ${link.openToken}안내${link.closeToken}.\n\n지금 실행.`,
    },
    {
      code: 'markdown.token_duplicate',
      answer:
        `읽기 ${link.openToken}안내${link.closeToken}.\n\n` +
        `지금 ${code.token} 그리고 ${code.token} 실행.`,
    },
    {
      code: 'markdown.token_unknown',
      answer:
        `읽기 ${link.openToken}안내${link.closeToken}.\n\n` +
        `지금 ${code.token} 및 ⟦CAT_RECOVERY:ATOM:C9⟧ 실행.`,
    },
    {
      code: 'markdown.token_nesting_invalid',
      answer:
        `읽기 ${link.closeToken}안내${link.openToken}.\n\n지금 ${code.token} 실행.`,
    },
  ];
}

function createPlainTranslationDocument(markdown) {
  return {
    namespace: 'CAT_TAB',
    entries: [],
    blocks: [{
      id: 'm1',
      kind: 'paragraph',
      template: markdown,
      originalMarkdown: markdown,
      entries: [],
    }],
  };
}

function createBlockApiRecord(id = 'b1') {
  const { serialized } = createReasoningFixture();
  return {
    id,
    template: serialized.template,
    atoms: serialized.atoms,
    contract: serialized.contract,
    repair: null,
  };
}

function createTestPlainBlockRecord(id = 'b1') {
  return {
    id,
    template: 'a',
    atoms: [],
    contract: {
      codecVersion: 1,
      namespace: 'CAT_PLAIN',
      entries: [],
      maxOutputChars: 2000,
      requiresText: true,
    },
    repair: null,
  };
}

// The settings a Semantic Block batch translates under. Every check that drives one wants the
// same three fields — a key to send, a model to name in the run it writes, and a target
// language its answers are judged against — so those are the default, and a check spells the
// settings out only where the difference is its subject.
const BLOCK_BATCH_SETTINGS = Object.freeze({
  apiKey: 'sk-test',
  model: 'gpt-5.4-mini',
  targetLanguage: 'Korean',
});

// The platform a Semantic Block batch reaches, and nothing else: `storage.local` for the
// settings it translates under, the key its fingerprints are signed with, and the diagnostics
// run it leaves behind, plus `runtime.getManifest` for the version that run is stamped with.
// A batch is handed its records and hands its results straight back, so there is no tab to
// broadcast to and no panel to open — the network is the only other thing it touches, and the
// worker takes that as `fetch`.
//
// `stored` is the caller's own object, which is how a check reads back the run that was
// written; one that only cares about the results it got lets this keep a throwaway. `session`
// is absent unless a check is about session storage, because a worker without one holds its
// correlations in instance state instead — see the restart below, where the difference is the
// whole point.
function createBlockBatchChrome({
  stored = {},
  settings = BLOCK_BATCH_SETTINGS,
  session = null,
} = {}) {
  return {
    runtime: { getManifest() { return { version: 'test' }; } },
    storage: {
      ...(session ? { session } : {}),
      local: {
        async get(keys) {
          if (keys === null) return { ...stored };
          const requested = Array.isArray(keys) ? keys : [keys];
          if (requested.includes('settings')) return { settings };
          const result = {};
          for (const key of requested) {
            if (Object.hasOwn(stored, key)) result[key] = stored[key];
          }
          return result;
        },
        async set(values) { Object.assign(stored, values); },
        async remove(keys) {
          for (const key of Array.isArray(keys) ? keys : [keys]) delete stored[key];
        },
      },
    },
  };
}

// Three blocks, each too long to share a Translation Chunk with the next at the smallest
// chunk size the options page accepts, so the fixture cuts into three chunks. That is what
// lets a failure arrive late: two answers are already in hand, and billed, when the third
// request goes out.
const THREE_CHUNK_BLOCKS = [1, 2, 3].map((index) => {
  const template = `Paragraph ${index} ${'word '.repeat(299)}`.trim();
  return {
    id: `m${index}`,
    kind: 'paragraph',
    template,
    originalMarkdown: template,
    entries: [],
  };
});

const THREE_CHUNK_DOCUMENT = {
  namespace: 'CAT_TAB_SEQUENCE',
  entries: [],
  blocks: THREE_CHUNK_BLOCKS,
};

// Hands messages to a worker the way Chrome does and collects the answers. The handler
// returns before the work it started finishes — it returns `true` to keep the channel open
// and calls `sendResponse` later — so a caller waits on the callback rather than on the
// call. Every message is delivered before the wait begins, because a duplicate arriving
// while the first is still running is itself something checked below.
//
// The tick bound is a deadlock guard rather than a timeout worth tuning: everything the
// worker does under these fake platforms resolves in microtasks and immediate timers, so a
// message unanswered after this many turns of the loop is not going to be answered. Coming
// back short is asserted rather than returned, because a check reading only the broadcasts
// would otherwise pass on a message that never got that far.
//
// The sender is where the worker reads the tab out of, so a message whose answer depends on
// which tab sent it passes one. The panel's own messages carry no tab, which is the default.
async function collectWorkerResponses(worker, messages, sender = {}) {
  const responses = [];
  for (const message of messages) {
    worker.handlers.onMessage(message, sender, (response) => responses.push(response));
  }
  for (let i = 0; i < 40 && responses.length < messages.length; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.equal(responses.length, messages.length, 'a worker message went unanswered');
  return responses;
}

// The five namespaces a whole-tab translation reaches and nothing else: `runtime` for the
// state broadcast the panel listens to, `sidePanel` for the panel it opens beside the page,
// `scripting` for the content script it makes sure is there, `storage` for the settings it
// translates under, and `tabs` for the extraction it asks the page for. The checks that
// drive one vary the same three things — what the settings say, what the page hands back,
// and whether the broadcast is collected — so those are the parameters and the rest is the
// same platform every time.
//
// `extract` is handed the tab id, because a check covering what article extraction can come
// back with needs a different answer per tab.
function createTabTranslationChrome({
  settings,
  extract,
  onStateMessage = () => {},
}) {
  return {
    runtime: {
      sendMessage(message) {
        if (message.type === 'STATE_UPDATED') onStateMessage(message);
        return Promise.resolve();
      },
    },
    sidePanel: {
      async setOptions() {},
      async open() {},
    },
    scripting: { async executeScript() {} },
    storage: {
      local: {
        async get() {
          return { settings };
        },
        async set() {},
      },
    },
    tabs: {
      async sendMessage(tabId, message) {
        if (message.type === 'EXTRACT_ARTICLE') {
          return { ok: true, data: extract(tabId) };
        }
        return { ok: true };
      },
    },
  };
}

// Drives a whole Side Panel Translation the way the panel does — one TRANSLATE_TAB message
// into the worker's own chunk loop — and hands back every state the panel would have seen,
// which is the only place the discard is visible. A queue that runs dry throws, so an
// unexpected extra request fails loudly instead of replaying the last answer.
//
// The platform carries the five namespaces this path reaches: `runtime` for the broadcast
// each recorded state travels on, `sidePanel` for the panel the translation opens beside the
// page, `scripting` for the content script it makes sure is there, `storage` for the settings
// it translates under, and `tabs` for the extraction it asks the page for.
async function runTabTranslation(
  tabId,
  answers,
  documentModel = THREE_CHUNK_DOCUMENT
) {
  const queue = [...answers];
  const states = [];
  const requestInputs = [];

  const worker = helpers.createBackgroundWorker({
    fetch: async (_url, options) => {
      requestInputs.push(JSON.parse(options.body).input);
      if (!queue.length) {
        throw new Error(`Unexpected full-page request #${requestInputs.length}`);
      }
      const answer = queue.shift();
      if (answer?.apiError) {
        return {
          ok: false,
          status: 400,
          async json() {
            return { error: { message: answer.apiError } };
          },
        };
      }
      return { ok: true, async json() { return answer; } };
    },
    chrome: createTabTranslationChrome({
      settings: { apiKey: 'sk-test', chunkMaxChars: 2000 },
      extract: () => ({
        title: 'Article',
        url: 'https://example.test',
        langHint: 'en',
        contentMarkdown: 'Original display Markdown.',
        translationDocument: documentModel,
      }),
      onStateMessage: (message) => states.push(message.state),
    }),
  });

  const responses = await collectWorkerResponses(worker, [
    { type: 'TRANSLATE_TAB', tabId },
  ]);
  return { responses, states, requestInputs };
}

exports.name = 'background helpers';
exports.tests = [
  {
    // The platform contract, and the reason every check below can name the namespaces its
    // path touches and be believed: what a worker was handed is all it can reach. There is
    // no global scope behind it, so a namespace left out of a platform is not quietly
    // supplied by the one this suite happens to run in — the call fails saying which piece
    // it was built without. Before that, a worker built with no network made this suite's
    // one real request to api.openai.com, and a worker built with no `chrome` read whatever
    // `global.chrome` a check in another file had left behind.
    //
    // This is the whole reason the platform is an argument, so it is asserted rather than
    // assumed. Restoring either fallback fails here and nowhere else.
    name: 'reaches no platform beyond the one it was constructed with',
    async fn() {
      const worker = helpers.createBackgroundWorker();

      await assert.rejects(
        () => worker.openaiTranslateChunk({
          apiKey: 'sk-test',
          model: 'gpt-5.4-mini',
          instructions: 'Translate.',
          input: 'Hello world.',
        }),
        /built without a network/
      );
      await assert.rejects(() => worker.ensureSidePanel(11), /built without chrome/);
      await assert.rejects(
        () => worker.syncButtonVisibilityRegistration({ showFloatingButton: 'always' }),
        /built without chrome/
      );
      await assert.rejects(
        () => worker.sendInlineInstruction(11, 'translate'),
        /built without chrome/
      );

      // Nor is there a worker to reach without building one. Eleven of the functions this
      // module exported were an instance's, backed by one built at import against whatever
      // global scope it found — the same fallback, in the one place no check could hand a
      // platform to instead. So the export surface is stated whole rather than by the names
      // that left it: everything below either builds a worker or only reasons, and an export
      // arriving here that needs a platform is an ambient worker come back.
      assert.deepEqual(Object.keys(helpers).sort(), [
        'INLINE_TRANSLATION_SHORTCUT_COMMAND',
        'assertFullPageTranslationBudget',
        'buildBlockInstructions',
        'buildBlockResponseFormat',
        'classifyContentScriptFailure',
        'createBackgroundWorker',
        'describeInlineTranslationControlFailure',
        'getBlockBatchMaxOutputTokens',
        'getBlockRecordCost',
        'getInlineContentScriptFiles',
        'getInlineInstructions',
        'mergeSettingsWithExisting',
        'mergeVisibleBatchSettingsSnapshot',
        'normalizeChunkMaxChars',
        'normalizeMaxOutputTokens',
        'normalizeVisibleBlockBatchRecords',
        'planInlineTranslationControl',
        'planInvocation',
        'safeError',
        'sanitizePublicTabState',
      ]);
    },
  },
  {
    name: 'recovers one incomplete full-page chunk with ordered protected children',
    async fn() {
      const { chunk, link, code } = createProtectedFullPageChunk();
      const { requestBodies, translated, error } = await runFullPageChunk(chunk, [
        createIncompleteResponse(),
        createCompletedResponse(
          `읽기 ${link.openToken}안내${link.closeToken}.`
        ),
        createCompletedResponse(`지금 ${code.token} 실행.`),
      ]);

      assert.equal(error, null);
      assert.equal(requestBodies.length, 3);
      assert.equal(
        translated,
        '읽기 [안내](<https://private.test/path?token=secret>).\n\n지금 ```private-command --secret``` 실행.'
      );
      assert.deepEqual(
        requestBodies.map((body) => body.input),
        [chunk.template, chunk.blocks[0].template, chunk.blocks[1].template]
      );
      for (const body of requestBodies) {
        const request = JSON.stringify(body);
        assert.equal(request.includes(link.destination), false);
        assert.equal(request.includes(code.value), false);
      }
    },
  },
  {
    name: 'stops after an incomplete recovery child without publishing success',
    async fn() {
      // The `runtime` this worker is given is what makes the second assertion mean
      // anything: had the failed chunk recorded a state, the broadcast would be collected
      // here. A chunk translation is not supposed to record one at all — the loop that
      // does is a level up — so an empty collection is the check.
      const { chunk, link } = createProtectedFullPageChunk();
      const broadcasts = [];
      const requestBodies = [];
      const answers = [
        createIncompleteResponse(),
        createCompletedResponse(
          `읽기 ${link.openToken}안내${link.closeToken}.`
        ),
        createIncompleteResponse(),
      ];
      const worker = helpers.createBackgroundWorker({
        chrome: createStateBroadcastChrome(broadcasts),
        fetch: async (_url, options) => {
          requestBodies.push(JSON.parse(options.body));
          return { ok: true, async json() { return answers.shift(); } };
        },
      });

      await assert.rejects(
        () => worker.translateFullPageChunk(chunk, FULL_PAGE_SETTINGS),
        (error) => error.code === 'response.incomplete.max_output_tokens'
      );
      assert.equal(requestBodies.length, 3);
      assert.equal(
        broadcasts.some((message) => message?.state?.status === 'done'),
        false
      );
    },
  },
  {
    name: 'asks every full-page request to carry the placeholder tokens back',
    async fn() {
      const { chunk, link, code } = createProtectedFullPageChunk();
      const { requestBodies, error } = await runFullPageChunk(chunk, [
        createCompletedResponse(
          `읽기 ${link.openToken}안내${link.closeToken}.\n\n지금 ${code.token} 실행.`
        ),
      ]);

      assert.equal(error, null);
      assert.equal(requestBodies.length, 1);
      const { instructions } = requestBodies[0];
      // The validator requires every token back, exactly once, and refuses one it never
      // sent. Each of those three is asked for here, or the refusal is for something the
      // model was never told.
      assert.match(instructions, /⟦/);
      assert.match(instructions, /exactly once/i);
      assert.match(instructions, /byte-for-byte/i);
      assert.match(instructions, /invent/i);
      // The wrongly-nested failure is one of the four the instructions have to speak to, and
      // the sentence aimed at it names a token shape. That shape is checked against a token
      // the chunk really carries, so the sentence cannot describe a placeholder no page mints.
      for (const word of ['LINK_OPEN', 'LINK_CLOSE']) {
        assert.match(instructions, new RegExp(word));
        assert.equal(`${link.openToken} ${link.closeToken}`.includes(word), true);
      }
    },
  },
  {
    name: 'repairs a broken token contract with one further attempt that names the code',
    async fn() {
      const { chunk, link, code } = createProtectedFullPageChunk();
      const { requestBodies, translated, error } = await runFullPageChunk(chunk, [
        createCompletedResponse(
          `읽기 ${link.openToken}안내${link.closeToken}.\n\n지금 실행.`
        ),
        createCompletedResponse(
          `읽기 ${link.openToken}안내${link.closeToken}.\n\n지금 ${code.token} 실행.`
        ),
      ]);

      assert.equal(error, null);
      assert.equal(requestBodies.length, 2);
      assert.deepEqual(
        requestBodies.map((body) => body.input),
        [chunk.template, chunk.template]
      );
      assert.equal(
        requestBodies[0].instructions.includes('markdown.token_missing'),
        false
      );
      assert.match(requestBodies[1].instructions, /markdown\.token_missing/);
      assert.equal(
        translated,
        '읽기 [안내](<https://private.test/path?token=secret>).\n\n지금 ```private-command --secret``` 실행.'
      );
    },
  },
  {
    name: 'takes the same one further attempt for each of the four token failures',
    async fn() {
      const { chunk, link, code } = createProtectedFullPageChunk();
      for (const failure of createTokenFailureAnswers({ link, code })) {
        const { requestBodies, translated, error } = await runFullPageChunk(chunk, [
          createCompletedResponse(failure.answer),
          createCompletedResponse(
            `읽기 ${link.openToken}안내${link.closeToken}.\n\n지금 ${code.token} 실행.`
          ),
        ]);

        assert.equal(error, null, `${failure.code} was not repaired`);
        assert.equal(requestBodies.length, 2, `${failure.code} attempt count`);
        assert.match(requestBodies[1].instructions, new RegExp(failure.code.replace('.', '\\.')));
        assert.equal(
          translated,
          '읽기 [안내](<https://private.test/path?token=secret>).\n\n지금 ```private-command --secret``` 실행.'
        );
      }
    },
  },
  {
    name: 'gives up after one repair attempt rather than looping on the tokens',
    async fn() {
      const { chunk, link } = createProtectedFullPageChunk();
      const lostToken = createCompletedResponse(
        `읽기 ${link.openToken}안내${link.closeToken}.\n\n지금 실행.`
      );
      const { requestBodies, error } = await runFullPageChunk(chunk, [
        lostToken,
        lostToken,
      ]);

      assert.equal(error?.code, 'markdown.token_missing');
      assert.equal(requestBodies.length, 2);
    },
  },
  {
    name: 'leaves a failure that is not about the tokens on its first attempt',
    async fn() {
      const { chunk } = createProtectedFullPageChunk();
      const { requestBodies, error } = await runFullPageChunk(chunk, [
        createApiErrorResponse('Incorrect API key provided'),
      ]);

      assert.match(String(error?.message), /Incorrect API key provided/);
      assert.equal(requestBodies.length, 1);
    },
  },
  {
    name: 'repairs the four token codes and no fifth one',
    async fn() {
      // The repairable set is a list, not a prefix match: `markdown.token_parent_changed`
      // is a real code elsewhere in the extension and Side Panel Translation's validator
      // never raises it, so a chunk translation must not spend a second request on it.
      // Only the validator can hand back a code, which is why it is the seam stubbed here.
      const { chunk, link, code } = createProtectedFullPageChunk();
      const originalValidate = fullPageMarkdown.validateAndRehydrateChunk;
      fullPageMarkdown.validateAndRehydrateChunk = () => {
        const error = new Error('markdown.token_parent_changed');
        error.code = 'markdown.token_parent_changed';
        throw error;
      };

      try {
        const { requestBodies, error } = await runFullPageChunk(chunk, [
          createCompletedResponse(
            `읽기 ${link.openToken}안내${link.closeToken}.\n\n지금 ${code.token} 실행.`
          ),
        ]);

        assert.equal(error?.code, 'markdown.token_parent_changed');
        assert.equal(requestBodies.length, 1);
      } finally {
        fullPageMarkdown.validateAndRehydrateChunk = originalValidate;
      }
    },
  },
  {
    name: 'does not repair the tokens of a chunk already split for an over-long answer',
    async fn() {
      // Both recoveries want the same chunk. The split claimed it first, so its children
      // translate once each: a repair per child would turn one over-long chunk into twice
      // as many billed attempts as blocks it holds.
      const { chunk, link } = createProtectedFullPageChunk();
      const { requestBodies, error } = await runFullPageChunk(chunk, [
        createIncompleteResponse(),
        createCompletedResponse(`읽기 ${link.openToken}안내.`),
      ]);

      assert.equal(error?.code, 'markdown.token_missing');
      assert.equal(requestBodies.length, 2);
    },
  },
  {
    name: 'does not split a repair attempt that comes back over-long',
    async fn() {
      // The other order, and the same rule: the token failure claimed the chunk, so an
      // over-long repair answer ends it instead of starting the second recovery.
      const { chunk, link } = createProtectedFullPageChunk();
      const { requestBodies, error } = await runFullPageChunk(chunk, [
        createCompletedResponse(
          `읽기 ${link.openToken}안내${link.closeToken}.\n\n지금 실행.`
        ),
        createIncompleteResponse(),
      ]);

      assert.equal(error?.code, 'response.incomplete.max_output_tokens');
      assert.equal(requestBodies.length, 2);
    },
  },
  {
    name: 'keeps extraction contracts out of tab state while translating protected Markdown',
    async fn() {
      const { chunk, link, code } = createProtectedFullPageChunk();
      const stateMessages = [];
      const requestBodies = [];

      const worker = helpers.createBackgroundWorker({
        fetch: async (_url, options) => {
          requestBodies.push(JSON.parse(options.body));
          return {
            ok: true,
            async json() {
              return createCompletedResponse(
                `읽기 ${link.openToken}안내${link.closeToken}.\n\n지금 ${code.token} 실행.`
              );
            },
          };
        },
        chrome: createTabTranslationChrome({
          settings: {
            apiKey: 'sk-test',
            chunkMaxChars: 2000,
            arbitraryStoredSibling: 'stored-state-secret',
          },
          extract: () => ({
            title: 'Article',
            url: 'https://example.test',
            langHint: 'en',
            contentMarkdown: 'Read the guide and run the command.',
            translationDocument: {
              namespace: chunk.contract.namespace,
              entries: chunk.contract.entries,
              blocks: chunk.blocks,
            },
            contract: 'unexpected-contract-sentinel',
            destination: 'https://unexpected.test/private-destination',
            body: 'unexpected-body-sentinel',
            apiKey: 'unexpected-key-sentinel',
          }),
          onStateMessage: (message) => stateMessages.push(message),
        }),
      });

      const responses = await collectWorkerResponses(worker, [
        { type: 'TRANSLATE_TAB', tabId: 20 },
      ]);

      assert.deepEqual(responses, [{ ok: true }]);
      assert.equal(stateMessages.at(-1)?.state?.status, 'done');
      const publicStateKeys = new Set([
        'status',
        'error',
        'extracted',
        'translated',
        'progress',
        'settingsUsed',
        'updatedAt',
      ]);
      const settingsUsedKeys = [
        'model',
        'reasoningEffort',
        'targetLanguage',
        'tone',
        'viewMode',
        'chunkMaxChars',
      ];
      for (const message of stateMessages) {
        const serialized = JSON.stringify(message);
        assert.equal(
          Object.keys(message.state).every((key) => publicStateKeys.has(key)),
          true
        );
        if (message.state.settingsUsed) {
          assert.deepEqual(
            Object.keys(message.state.settingsUsed),
            settingsUsedKeys
          );
        }
        assert.equal(serialized.includes('translationDocument'), false);
        assert.equal(
          serialized.includes('unexpected-contract-sentinel'),
          false
        );
        assert.equal(serialized.includes('private-destination'), false);
        assert.equal(serialized.includes('unexpected-body-sentinel'), false);
        assert.equal(serialized.includes('unexpected-key-sentinel'), false);
        if (message.state.status !== 'done') {
          assert.equal(serialized.includes('token=secret'), false);
          assert.equal(serialized.includes('private-command --secret'), false);
        }
      }

      // The same worker, asked for the state it just recorded: the panel reads it back
      // through GET_STATE, and what comes out has to be as bounded as what was broadcast.
      const stateResponses = await collectWorkerResponses(worker, [
        { type: 'GET_STATE', tabId: 20 },
      ]);
      assert.equal(
        Object.keys(stateResponses[0].state).every((key) =>
          publicStateKeys.has(key)
        ),
        true
      );
      assert.equal(
        JSON.stringify(stateResponses[0]).includes('stored-state-secret'),
        false
      );
      assert.equal(requestBodies.length, 1);
      assert.equal(
        JSON.stringify(requestBodies).includes('token=secret'),
        false
      );
      assert.equal(
        JSON.stringify(requestBodies).includes('private-command --secret'),
        false
      );
    },
  },
  {
    // Three blocks that do fit one Translation Chunk, so the chunk overruns the output
    // limit and is split; the second child overruns too, and one recovery is all a chunk
    // gets (ADR-0005). Nothing is published, as ADR-0006 has it.
    name: 'does not publish done when a real tab translation recovery child is incomplete',
    async fn() {
      const blocks = [1, 2, 3].map((index) => {
        const template = `Paragraph ${index} ${'word '.repeat(115)}`.trim();
        return {
          id: `m${index}`,
          kind: 'paragraph',
          template,
          originalMarkdown: template,
          entries: [],
        };
      });
      const { responses, states, requestInputs } = await runTabTranslation(
        21,
        [
          createIncompleteResponse(),
          createCompletedResponse(blocks[0].template),
          createIncompleteResponse(),
        ],
        { namespace: 'CAT_TAB_RECOVERY', entries: [], blocks }
      );

      assert.deepEqual(responses, [{
        ok: true,
        skipped: true,
        reason: 'translate_failed',
      }]);
      assert.equal(states.some((state) => state.status === 'done'), false);
      assert.equal(states.at(-1)?.status, 'error');
      assert.equal(states.at(-1)?.translated, null);
      assert.equal(states.at(-1)?.progress, null);
      assert.equal(requestInputs.length, 3);
    },
  },
  {
    // ADR-0006. The discard is the decision, so it is checked rather than left to the
    // comment beside the loop: the two answers already paid for are gone from every state
    // the panel could render, and the reader is left with the failure alone.
    name: 'discards the Translation Chunks already paid for when a later one fails',
    async fn() {
      const { responses, states, requestInputs } = await runTabTranslation(41, [
        createCompletedResponse('첫째 문단 번역.'),
        createCompletedResponse('둘째 문단 번역.'),
        createApiErrorResponse('The service refused the third request.'),
      ]);

      assert.deepEqual(responses, [{
        ok: true,
        skipped: true,
        reason: 'translate_failed',
      }]);
      // Three requests, one per chunk: the failure is the third chunk's own, and the two
      // before it were answered rather than skipped.
      assert.equal(requestInputs.length, 3);
      assert.deepEqual(
        states
          .filter((state) => state.progress)
          .map((state) => `${state.progress.current}/${state.progress.total}`),
        ['1/3', '2/3', '3/3']
      );
      assert.equal(states.some((state) => state.status === 'done'), false);
      assert.equal(states.at(-1)?.status, 'error');
      assert.equal(states.at(-1)?.translated, null);
      assert.equal(states.at(-1)?.progress, null);
      assert.equal(
        states.at(-1)?.error?.message,
        'The service refused the third request.'
      );
      for (const state of states) {
        const serialized = JSON.stringify(state);
        assert.equal(serialized.includes('첫째 문단 번역'), false);
        assert.equal(serialized.includes('둘째 문단 번역'), false);
      }
    },
  },
  {
    // The failure #27 was deferred for, end to end: a token contract broken twice. The
    // third chunk carries a protected link, loses it, buys the one further attempt #26
    // gave it, loses it again, and has no recovery left (ADR-0005). The discard is the
    // same discard — four requests billed to tell the reader nothing.
    name: 'discards the earlier answers when a token contract fails twice',
    async fn() {
      const namespace = 'CAT_TAB_TOKENS';
      const link = {
        id: 'L9',
        kind: 'link',
        openToken: `⟦${namespace}:LINK_OPEN:L9⟧`,
        closeToken: `⟦${namespace}:LINK_CLOSE:L9⟧`,
        destination: 'https://example.test/guide?token=secret',
      };
      const blocks = THREE_CHUNK_BLOCKS.map((block, index) =>
        index < 2
          ? block
          : {
              ...block,
              template: `Read ${link.openToken}the guide${link.closeToken}. ${block.template}`,
              entries: [link.id],
            }
      );
      const { responses, states, requestInputs } = await runTabTranslation(
        43,
        [
          createCompletedResponse('첫째 문단 번역.'),
          createCompletedResponse('둘째 문단 번역.'),
          createCompletedResponse('안내를 읽으세요.'),
          createCompletedResponse('안내를 다시 읽으세요.'),
        ],
        { namespace, entries: [link], blocks }
      );

      // Four requests: three chunks and the third chunk's one repair, which fails on the
      // same code and ends the chunk rather than starting the over-long recovery.
      assert.equal(requestInputs.length, 4);
      assert.equal(requestInputs[2], requestInputs[3]);
      assert.deepEqual(responses, [{
        ok: true,
        skipped: true,
        reason: 'translate_failed',
      }]);
      assert.equal(states.at(-1)?.status, 'error');
      assert.equal(states.at(-1)?.error?.code, 'markdown.token_missing');
      assert.equal(states.at(-1)?.translated, null);
      for (const state of states) {
        const serialized = JSON.stringify(state);
        assert.equal(serialized.includes('첫째 문단 번역'), false);
        assert.equal(serialized.includes('둘째 문단 번역'), false);
        assert.equal(serialized.includes('token=secret'), false);
      }
    },
  },
  {
    // The other half of the check above: the same fixture, answered throughout, does cut
    // into three chunks and does publish all three. Without this, a fixture that quietly
    // stopped producing three chunks would leave the discard checked against nothing.
    name: 'joins every Translation Chunk in order when none of them fails',
    async fn() {
      const { responses, states, requestInputs } = await runTabTranslation(42, [
        createCompletedResponse('첫째 문단 번역.'),
        createCompletedResponse('둘째 문단 번역.'),
        createCompletedResponse('셋째 문단 번역.'),
      ]);

      assert.deepEqual(responses, [{ ok: true }]);
      assert.deepEqual(
        requestInputs,
        THREE_CHUNK_BLOCKS.map((block) => block.template)
      );
      assert.equal(states.at(-1)?.status, 'done');
      assert.equal(
        states.at(-1)?.translated,
        '첫째 문단 번역.\n\n둘째 문단 번역.\n\n셋째 문단 번역.'
      );
      assert.equal(states.at(-1)?.progress, null);
      assert.equal(states.at(-1)?.error, null);
    },
  },
  {
    name: 'owns malformed and oversized extraction failures without publishing display state',
    async fn() {
      const extractionByTab = new Map([
        [30, null],
        [31, undefined],
        [32, 'malformed extraction'],
        [
          33,
          {
            title: 'Missing document',
            url: 'https://example.test/missing',
            langHint: 'en',
            contentMarkdown: 'Visible but invalid.',
          },
        ],
        [
          34,
          {
            title: 'Malformed document',
            url: 'https://example.test/malformed',
            langHint: 'en',
            contentMarkdown: 'Visible but invalid.',
            translationDocument: { blocks: null },
          },
        ],
        [
          35,
          {
            title: 'Oversized',
            url: 'https://example.test/oversized',
            langHint: 'en',
            contentMarkdown: `oversized-display-sentinel${'x'.repeat(60000)}`,
            translationDocument:
              createPlainTranslationDocument('safe template'),
          },
        ],
      ]);
      const statesByTab = new Map();
      let requestCount = 0;

      // One worker for all six tabs, because the per-tab state is this instance's and each
      // tab keeps its own entry in it. Six of them would say nothing the six entries do not.
      const worker = helpers.createBackgroundWorker({
        fetch: async () => {
          requestCount += 1;
          throw new Error('model request must not run');
        },
        chrome: createTabTranslationChrome({
          settings: { apiKey: 'sk-test', chunkMaxChars: 2000 },
          extract: (tabId) => extractionByTab.get(tabId),
          onStateMessage: (message) => {
            const states = statesByTab.get(message.tabId) || [];
            states.push(message.state);
            statesByTab.set(message.tabId, states);
          },
        }),
      });

      for (const tabId of extractionByTab.keys()) {
        const responses = await collectWorkerResponses(worker, [
          { type: 'TRANSLATE_TAB', tabId },
        ]);
        assert.deepEqual(responses, [{
          ok: true,
          skipped: true,
          reason: 'extract_failed',
        }]);
      }

      assert.equal(requestCount, 0);
      assert.equal(statesByTab.size, extractionByTab.size);
      for (const states of statesByTab.values()) {
        assert.equal(states.at(-1)?.status, 'error');
        assert.equal(states.at(-1)?.progress, null);
        assert.equal(states.at(-1)?.translated, null);
        assert.equal(
          states.some((state) => Boolean(state.extracted)),
          false
        );
        assert.equal(
          JSON.stringify(states).includes('oversized-display-sentinel'),
          false
        );
      }
    },
  },
  {
    name: 'defaults to the current small model with no reasoning effort',
    fn() {
      const settings = helpers.mergeSettingsWithExisting({}, {});

      assert.equal(settings.model, DEFAULT_MODEL);
      assert.equal(settings.reasoningEffort, 'none');
    },
  },
  {
    name: 'exact-allowlists public tab state and settings used fields',
    fn() {
      const state = helpers.sanitizePublicTabState({
        status: 'done',
        error: { message: 'bounded', name: 'Error', secret: 'error-secret' },
        extracted: {
          title: 'Article',
          url: 'https://example.test',
          langHint: 'en',
          contentMarkdown: '# Article',
          contract: 'private-contract',
        },
        translated: '# 번역',
        progress: { current: 1, total: 1, privateCounter: 99 },
        settingsUsed: {
          model: 'gpt-5.4-mini',
          reasoningEffort: 'none',
          targetLanguage: 'Korean',
          tone: 'technical',
          viewMode: 'translation',
          chunkMaxChars: 12000,
          apiKey: 'sk-private',
          arbitraryStoredSibling: 'settings-secret',
        },
        updatedAt: '2026-07-13T00:00:00.000Z',
        arbitraryPatchSibling: 'state-secret',
      });

      assert.deepEqual(Object.keys(state), [
        'status',
        'error',
        'extracted',
        'translated',
        'progress',
        'settingsUsed',
        'updatedAt',
      ]);
      assert.deepEqual(Object.keys(state.settingsUsed), [
        'model',
        'reasoningEffort',
        'targetLanguage',
        'tone',
        'viewMode',
        'chunkMaxChars',
      ]);
      assert.deepEqual(Object.keys(state.error), ['message', 'name']);
      assert.deepEqual(Object.keys(state.extracted), [
        'title',
        'url',
        'langHint',
        'contentMarkdown',
      ]);
      assert.deepEqual(Object.keys(state.progress), ['current', 'total']);
      assert.equal(JSON.stringify(state).includes('secret'), false);
      assert.equal(JSON.stringify(state).includes('private-contract'), false);
    },
  },
  {
    name: 'clamps unsafe chunk sizes from saved settings',
    fn() {
      assert.equal(
        helpers.mergeSettingsWithExisting({}, { chunkMaxChars: -1 }).chunkMaxChars,
        2000
      );
      assert.equal(
        helpers.mergeSettingsWithExisting({}, { chunkMaxChars: Infinity })
          .chunkMaxChars,
        12000
      );
      assert.equal(
        helpers.mergeSettingsWithExisting({}, { chunkMaxChars: 900000 })
          .chunkMaxChars,
        60000
      );
    },
  },
  {
    name: 'rejects full-page translations over the total character budget',
    fn() {
      assert.throws(
        () => helpers.assertFullPageTranslationBudget('x'.repeat(60001)),
        /Full-page translation has too much text/
      );
      assert.doesNotThrow(() =>
        helpers.assertFullPageTranslationBudget('x'.repeat(60000))
      );
    },
  },
  {
    name: 'merges partial settings without dropping existing values',
    fn() {
      const next = helpers.mergeSettingsWithExisting(
        {
          apiKey: 'sk-existing',
          chunkMaxChars: 9000,
          buttonVisibility: 'allPages',
          targetLanguage: 'Korean',
          tone: 'technical',
          model: 'gpt-5-mini',
          viewMode: 'translation',
        },
        {
          targetLanguage: 'Japanese',
          tone: 'formal',
          model: 'gpt-5',
          viewMode: 'bilingual',
        }
      );

      assert.equal(next.apiKey, 'sk-existing');
      assert.equal(next.chunkMaxChars, 9000);
      assert.equal(next.buttonVisibility, 'allPages');
      assert.equal(next.targetLanguage, 'Japanese');
      assert.equal(next.tone, 'formal');
      assert.equal(next.model, 'gpt-5');
      assert.equal(next.viewMode, 'bilingual');
    },
  },
  {
    name: 'migrates the old inline button checkbox to a Button Visibility choice',
    fn() {
      // Settings saved before the three states still hold the boolean. Merging is where
      // storage is read, so it is where the older shape stops being visible — and the
      // boolean is not written back.
      const migrated = helpers.mergeSettingsWithExisting(
        { inlineAutoShow: true, targetLanguage: 'Korean' },
        {}
      );
      assert.equal(migrated.buttonVisibility, 'allPages');
      assert.equal(Object.hasOwn(migrated, 'inlineAutoShow'), false);

      assert.equal(
        helpers.mergeSettingsWithExisting({ inlineAutoShow: false }, {})
          .buttonVisibility,
        'never'
      );
      assert.equal(helpers.mergeSettingsWithExisting({}, {}).buttonVisibility, 'never');
    },
  },
  {
    name: 'lets a saved Button Visibility choice replace the migrated one',
    fn() {
      const next = helpers.mergeSettingsWithExisting(
        { inlineAutoShow: true },
        { buttonVisibility: 'onInvocation' }
      );
      assert.equal(next.buttonVisibility, 'onInvocation');
    },
  },
  {
    name: 'drops arbitrary stored and patch siblings when merging settings',
    fn() {
      const next = helpers.mergeSettingsWithExisting(
        {
          apiKey: 'sk-existing',
          targetLanguage: 'Korean',
          arbitraryStoredSibling: 'stored-secret',
        },
        {
          tone: 'formal',
          arbitraryPatchSibling: 'patch-secret',
        }
      );

      assert.equal(next.apiKey, 'sk-existing');
      assert.equal(next.tone, 'formal');
      assert.equal(Object.hasOwn(next, 'arbitraryStoredSibling'), false);
      assert.equal(Object.hasOwn(next, 'arbitraryPatchSibling'), false);
    },
  },
  {
    name: 'merges visible batch settings snapshot without accepting api key',
    fn() {
      const settings = helpers.mergeVisibleBatchSettingsSnapshot(
        {
          apiKey: 'sk-current',
          chunkMaxChars: 9000,
          buttonVisibility: 'allPages',
          targetLanguage: 'Korean',
          tone: 'technical',
          model: 'gpt-5.4-mini',
          reasoningEffort: 'none',
          viewMode: 'translation',
        },
        {
          apiKey: 'sk-from-content',
          chunkMaxChars: 24000,
          buttonVisibility: 'never',
          targetLanguage: 'Japanese',
          tone: 'natural',
          model: 'gpt-5.4',
          reasoningEffort: 'low',
          viewMode: 'bilingual',
        }
      );

      assert.equal(settings.apiKey, 'sk-current');
      assert.equal(settings.chunkMaxChars, 9000);
      assert.equal(settings.buttonVisibility, 'allPages');
      assert.equal(settings.viewMode, 'translation');
      assert.equal(settings.targetLanguage, 'Japanese');
      assert.equal(settings.tone, 'natural');
      assert.equal(settings.model, 'gpt-5.4');
      assert.equal(settings.reasoningEffort, 'low');
    },
  },
  {
    name: 'sends reasoning none in Responses API requests',
    async fn() {
      const { requestBody, output } = await runTranslationRequest({
        apiKey: 'sk-test',
        model: 'gpt-5.4-mini',
        instructions: 'Translate.',
        input: 'Hello.',
      });

      assert.equal(output, '번역 결과');
      assert.deepEqual(requestBody.reasoning, { effort: 'none' });
      assert.equal(requestBody.max_output_tokens, 8192);
      assert.equal(requestBody.store, false);
    },
  },
  {
    name: 'allows a lower output token cap for small translation batches',
    async fn() {
      const { requestBody } = await runTranslationRequest({
        apiKey: 'sk-test',
        model: 'gpt-5.4-mini',
        instructions: 'Translate.',
        input: 'Hello.',
        maxOutputTokens: 2048,
      });

      assert.equal(requestBody.max_output_tokens, 2048);
    },
  },
  {
    name: 'builds the strict semantic block response format and instructions',
    fn() {
      const format = helpers.buildBlockResponseFormat();
      const instructions = helpers.buildBlockInstructions({
        targetLanguage: 'Korean',
        tone: 'technical',
      });

      assert.equal(format.type, 'json_schema');
      assert.equal(format.name, 'inline_block_translations');
      assert.equal(format.strict, true);
      assert.deepEqual(
        format.schema.properties.translations.items.required,
        ['id', 'template']
      );
      assert.match(instructions, /complete semantic block/i);
      assert.match(instructions, /token.*byte-for-byte/i);
      assert.match(instructions, /Do not output HTML/i);
      assert.match(instructions, /repair.*previousErrorCode/i);
    },
  },
  {
    name: 'normalizes block records without allowing DOM attributes',
    fn() {
      const record = createBlockApiRecord();
      const normalized = helpers.normalizeVisibleBlockBatchRecords([record]);

      assert.equal(normalized.length, 1);
      assert.equal(normalized[0].id, 'b1');
      assert.equal(normalized[0].template, record.template);
      assert.deepEqual(normalized[0].atoms, record.atoms);
      assert.deepEqual(normalized[0].contract, record.contract);
      assert.equal(normalized[0].repair, null);
      assert.equal(
        helpers.getBlockRecordCost(normalized[0]),
        record.template.length +
          JSON.stringify(record.atoms).length +
          JSON.stringify(null).length
      );

      assert.throws(
        () =>
          helpers.normalizeVisibleBlockBatchRecords([
            {
              ...record,
              atoms: [{ ...record.atoms[0], href: 'https://example.com' }],
            },
          ]),
        /Unexpected atom field/
      );
      assert.throws(
        () =>
          helpers.normalizeVisibleBlockBatchRecords([
            {
              ...record,
              repair: { attempt: 2, previousErrorCode: 'token_missing' },
            },
          ]),
        /repair attempt/
      );
    },
  },
  {
    name: 'enforces semantic block record and batch budgets',
    fn() {
      const record = createBlockApiRecord();
      const oversized = {
        ...record,
        template: `${'x'.repeat(12000)}${record.template}`,
        contract: { ...record.contract, maxOutputChars: 48000 },
      };

      assert.throws(
        () => helpers.normalizeVisibleBlockBatchRecords([oversized]),
        /block record is too large/i
      );
      assert.equal(helpers.getBlockBatchMaxOutputTokens(100), 4096);
      assert.equal(helpers.getBlockBatchMaxOutputTokens(12000), 15000);
      assert.equal(helpers.getBlockBatchMaxOutputTokens(20000), 16000);
      const plainFixture = createTestPlainBlockRecord();
      assert.throws(
        () =>
          helpers.normalizeVisibleBlockBatchRecords(
            Array.from({ length: 501 }, (_item, index) => ({
              ...plainFixture,
              id: `b${index + 1}`,
            }))
          ),
        /Too many semantic blocks/
      );
    },
  },
  {
    // The worker used to carry an `assertInlineBlockSessionBudget` and a 60,000-character
    // `INLINE_BLOCK_MAX_SESSION_COST` that nothing called, and this suite's green check on
    // them was the only thing making them look live. ADR-0003 gave the session cap to the
    // content script, where `tests/content-helpers.test.js` checks it holds. What kept the
    // pair out until now was a read of `background.js`'s own source text for their two
    // names, because a worker that found its platform by name offered nothing else to ask:
    // an assert kept out of `module.exports` was invisible to any assertion about the
    // module. A worker is built now, so the guarantee is stated as behaviour instead — one
    // worker translates six batches that cost more together than the retired cap, and every
    // one of them is translated. A session cap re-added anywhere on this path fails here,
    // whether it is a module constant, this instance's own accounting, or exported at all.
    //
    // Six batches rather than one over-long one, because the per-batch and per-record caps
    // of 12,000 are real and stay. It is the session across batches that the worker does not
    // account for, and one worker is what makes these six batches one session.
    name: 'leaves the Semantic Block session cap to the content script',
    async fn() {
      const RETIRED_SESSION_COST_CAP = 60000;
      // Just under the 12,000-character record cap, so six batches cost past the retired one
      // together and no single batch is refused for a reason this check is not about.
      const template = `Hello world. ${'word '.repeat(2377)}`.trim();
      // One block per batch, under the same id every time: ids are unique within a batch, and
      // six batches that differ in nothing but being six is exactly the subject here.
      const record = {
        id: 'b1',
        template,
        atoms: [],
        contract: {
          codecVersion: 1,
          namespace: 'CAT_SESSION',
          entries: [],
          // What the codec would have written for a template this long, so the answer below
          // is not refused for overrunning a contract the page never would have sent.
          maxOutputChars: Math.min(48000, Math.max(2000, template.length * 4)),
          requiresText: true,
        },
        repair: null,
      };
      const worker = helpers.createBackgroundWorker({
        chrome: createBlockBatchChrome(),
        // In the target language the settings name, so every batch below is applied on its
        // merits rather than repaired for saying nothing Korean.
        fetch: async () => ({ ok: true, async json() { return createCompletedResponse(JSON.stringify({
          translations: [{ id: record.id, template: `한국어 문장입니다. ${'단어 '.repeat(200)}`.trim() }],
        })); } }),
      });

      let spent = 0;
      for (let batch = 1; batch <= 6; batch += 1) {
        spent += helpers.getBlockRecordCost(record);

        const [result] = await worker.translateVisibleBlockBatch([record]);

        assert.equal(
          result.disposition,
          'apply',
          `batch ${batch} was refused ${spent} characters into the session`
        );
      }

      // The batches only say something about the retired cap if they cost more than it did.
      assert.ok(
        spent > RETIRED_SESSION_COST_CAP,
        `six batches cost ${spent} characters, under the retired ${RETIRED_SESSION_COST_CAP}`
      );
    },
  },
  {
    name: 'rejects repaired non-Korean output without exposing block internals',
    async fn() {
      const record = createBlockApiRecord();
      const requestBodies = [];
      const worker = helpers.createBackgroundWorker({
        // Session storage that refuses the write is what leaves this batch with no
        // correlation token to hand back: the tokens are minted into it, and a batch that
        // cannot record where a block came from does not offer the page one to report under.
        // Everything else about the platform is whole, so that refusal is the only thing the
        // absent token can be blamed on - the diagnostics run itself is written and readable.
        chrome: createBlockBatchChrome({
          settings: {
            apiKey: 'sk-test',
            model: 'gpt-5.4-mini',
            reasoningEffort: 'none',
            targetLanguage: 'Korean',
            tone: 'technical',
          },
          session: {
            async get() { return {}; },
            async set() { throw new Error('session unavailable'); },
          },
        }),
        fetch: async (_url, options) => {
          requestBodies.push(JSON.parse(options.body));
          return {
            ok: true,
            async json() {
              return createCompletedResponse(JSON.stringify({
                translations: [{ id: record.id, template: record.template }],
              }));
            },
          };
        },
      });

      const results = await worker.translateVisibleBlockBatch([record]);
      const input = JSON.parse(requestBodies[1].input);

      assert.equal(results[0].correlationToken, undefined);
      const result = results[0];
      assert.equal(result.disposition, 'reject');
      assert.equal('template' in result, false);
      assert.equal(result.terminalCode, 'quality.target_language_missing');
      assert.equal(requestBodies.length, 2);
      assert.equal(input.records[0].contract, undefined);
      assert.equal(input.records[0].atoms[0].href, undefined);
      assert.equal(requestBodies[1].text.format.name, 'inline_block_translations');
      assert.equal(
        requestBodies[1].max_output_tokens,
        helpers.getBlockBatchMaxOutputTokens(
          helpers.getBlockRecordCost(record)
        )
      );
    },
  },
  {
    name: 'loads the semantic block codec before the content script',
    fn() {
      assert.deepEqual(helpers.getInlineContentScriptFiles(), [
        'default-model.js',
        'placeholder-tokens.js',
        'inline-block.js',
        'inline-diagnostics-protocol.js',
        'inline-translation-controls.js',
        'full-page-markdown.js',
        'content.js',
      ]);
    },
  },
  {
    name: 'serializes concurrent all-pages content script registration',
    async fn() {
      const registered = new Map();

      const chrome = {
        permissions: {
          async contains() {
            return true;
          },
        },
        scripting: {
          async unregisterContentScripts({ ids }) {
            for (const id of ids || []) {
              registered.delete(id);
            }
          },
          async registerContentScripts(scripts) {
            await Promise.resolve();
            for (const script of scripts || []) {
              if (registered.has(script.id)) {
                throw new Error(`Duplicate script ID '${script.id}'`);
              }
            }
            for (const script of scripts || []) {
              registered.set(script.id, { ...script });
            }
          },
        },
      };
      const worker = helpers.createBackgroundWorker({ chrome });

      await Promise.all([
        worker.syncButtonVisibilityRegistration({ buttonVisibility: 'allPages' }),
        worker.syncButtonVisibilityRegistration({ buttonVisibility: 'allPages' }),
      ]);

      assert.equal(registered.size, 1);
      assert.deepEqual(
        registered.get('inline-translator-auto-show')?.matches,
        ['http://*/*', 'https://*/*']
      );
    },
  },
  {
    name: 'updates existing all-pages content script after duplicate registration',
    async fn() {
      const registered = new Map([
        [
          'inline-translator-auto-show',
          {
            id: 'inline-translator-auto-show',
            matches: ['https://old.example/*'],
            js: ['old-content.js'],
            runAt: 'document_start',
          },
        ],
      ]);

      const chrome = {
        permissions: {
          async contains() {
            return true;
          },
        },
        scripting: {
          async unregisterContentScripts() {
            throw new Error('temporary unregister failure');
          },
          async registerContentScripts(scripts) {
            for (const script of scripts || []) {
              if (registered.has(script.id)) {
                throw new Error(`Duplicate script ID '${script.id}'`);
              }
            }
          },
          async updateContentScripts(scripts) {
            for (const script of scripts || []) {
              registered.set(script.id, {
                ...(registered.get(script.id) || {}),
                ...script,
              });
            }
          },
        },
      };
      const worker = helpers.createBackgroundWorker({ chrome });

      await worker.syncButtonVisibilityRegistration({ buttonVisibility: 'allPages' });

      assert.deepEqual(
        registered.get('inline-translator-auto-show'),
        {
          id: 'inline-translator-auto-show',
          matches: ['http://*/*', 'https://*/*'],
          js: [
            'default-model.js',
            'placeholder-tokens.js',
            'inline-block.js',
            'inline-diagnostics-protocol.js',
            'inline-translation-controls.js',
            'full-page-markdown.js',
            'content.js',
          ],
          runAt: 'document_idle',
        }
      );
    },
  },
  {
    name: 'updates registered all-pages content script without duplicate registration',
    async fn() {
      const registered = new Map([
        [
          'inline-translator-auto-show',
          {
            id: 'inline-translator-auto-show',
            matches: ['https://old.example/*'],
            js: ['old-content.js'],
            runAt: 'document_start',
          },
        ],
      ]);

      const chrome = {
        permissions: {
          async contains() {
            return true;
          },
        },
        scripting: {
          async getRegisteredContentScripts({ ids }) {
            return (ids || [])
              .map((id) => registered.get(id))
              .filter(Boolean);
          },
          async unregisterContentScripts({ ids }) {
            for (const id of ids || []) {
              registered.delete(id);
            }
          },
          async registerContentScripts() {
            throw new Error('register should not be called for existing script');
          },
          async updateContentScripts(scripts) {
            for (const script of scripts || []) {
              registered.set(script.id, {
                ...(registered.get(script.id) || {}),
                ...script,
              });
            }
          },
        },
      };
      const worker = helpers.createBackgroundWorker({ chrome });

      await worker.syncButtonVisibilityRegistration({ buttonVisibility: 'allPages' });

      assert.deepEqual(
        registered.get('inline-translator-auto-show'),
        {
          id: 'inline-translator-auto-show',
          matches: ['http://*/*', 'https://*/*'],
          js: [
            'default-model.js',
            'placeholder-tokens.js',
            'inline-block.js',
            'inline-diagnostics-protocol.js',
            'inline-translation-controls.js',
            'full-page-markdown.js',
            'content.js',
          ],
          runAt: 'document_idle',
        }
      );
    },
  },
  {
    name: 'does not throw when all-pages duplicate recovery fails',
    async fn() {
      const chrome = {
        permissions: {
          async contains() {
            return true;
          },
        },
        scripting: {
          async getRegisteredContentScripts() {
            throw new Error('temporary lookup failure');
          },
          async unregisterContentScripts() {
            throw new Error('temporary unregister failure');
          },
          async registerContentScripts() {
            throw new Error("Duplicate script ID 'inline-translator-auto-show'");
          },
          async updateContentScripts() {
            throw new Error("Duplicate script ID 'inline-translator-auto-show'");
          },
        },
      };
      const worker = helpers.createBackgroundWorker({ chrome });

      await worker.syncButtonVisibilityRegistration({ buttonVisibility: 'allPages' });
    },
  },
  {
    name: 'safely ignores all-pages registration failures from runtime events',
    async fn() {
      const chrome = {
        permissions: {
          async contains() {
            return true;
          },
        },
        scripting: {
          async getRegisteredContentScripts() {
            return [];
          },
          async registerContentScripts() {
            throw new Error('Unexpected scripting API failure');
          },
        },
      };
      const worker = helpers.createBackgroundWorker({ chrome });

      assert.equal(
        await worker.syncButtonVisibilityRegistrationSafely({
          buttonVisibility: 'allPages',
        }),
        false
      );
    },
  },
  {
    name: 'registers the content script across pages for the all-pages choice alone',
    async fn() {
      // Registering it is what lets the button appear without the reader invoking the
      // extension. The other two choices must leave no registration behind, or a reader who
      // moved away from all pages would keep getting the button on every page.
      for (const [visibility, expected] of [
        ['allPages', ['inline-translator-auto-show']],
        ['onInvocation', []],
        ['never', []],
      ]) {
        const registered = new Map([
          ['inline-translator-auto-show', { id: 'inline-translator-auto-show' }],
        ]);

        const chrome = {
          permissions: {
            async contains() {
              return true;
            },
          },
          scripting: {
            async getRegisteredContentScripts({ ids }) {
              return Array.from(registered.values()).filter((script) =>
                ids.includes(script.id)
              );
            },
            async unregisterContentScripts({ ids }) {
              for (const id of ids || []) registered.delete(id);
            },
            async updateContentScripts(scripts) {
              for (const script of scripts || []) registered.set(script.id, script);
            },
            async registerContentScripts(scripts) {
              for (const script of scripts || []) registered.set(script.id, script);
            },
          },
        };
        const worker = helpers.createBackgroundWorker({ chrome });

        await worker.syncButtonVisibilityRegistration({
          buttonVisibility: visibility,
        });
        assert.deepEqual(Array.from(registered.keys()), expected, visibility);
      }
    },
  },
  {
    name: 'gives back access to all sites for the two choices that do not need it',
    async fn() {
      // An install migrating off the old checkbox reaches never without the reader opening
      // the options page, so the access the checkbox asked for has to be given back here.
      const removed = [];

      const chrome = {
        permissions: {
          async contains() {
            return true;
          },
          async remove({ origins }) {
            removed.push(origins);
            return true;
          },
        },
        scripting: {
          async unregisterContentScripts() {},
        },
      };
      const worker = helpers.createBackgroundWorker({ chrome });

      await worker.syncButtonVisibilityRegistration({ inlineAutoShow: false });
      await worker.syncButtonVisibilityRegistration({
        buttonVisibility: 'onInvocation',
      });
      assert.deepEqual(removed, [
        ['http://*/*', 'https://*/*'],
        ['http://*/*', 'https://*/*'],
      ]);
    },
  },
  {
    name: 'keeps access to all sites for the all-pages choice',
    async fn() {
      let removed = false;

      const chrome = {
        permissions: {
          async contains() {
            return true;
          },
          async remove() {
            removed = true;
            return true;
          },
        },
        scripting: {
          async getRegisteredContentScripts() {
            return [];
          },
          async registerContentScripts() {},
          async unregisterContentScripts() {},
        },
      };
      const worker = helpers.createBackgroundWorker({ chrome });

      await worker.syncButtonVisibilityRegistration({
        buttonVisibility: 'allPages',
      });
      assert.equal(removed, false);
    },
  },
  {
    name: 'keeps the content script unregistered without access to all sites',
    async fn() {
      // The choice and the permission can disagree: Chrome lets the reader revoke access
      // from its own UI, which no longer reaches the options page.
      const unregistered = [];

      const chrome = {
        permissions: {
          async contains() {
            return false;
          },
        },
        scripting: {
          async unregisterContentScripts({ ids }) {
            unregistered.push(...(ids || []));
          },
          async registerContentScripts() {
            throw new Error('registered without access to all sites');
          },
        },
      };
      const worker = helpers.createBackgroundWorker({ chrome });

      await worker.syncButtonVisibilityRegistration({
        buttonVisibility: 'allPages',
      });
      assert.deepEqual(unregistered, ['inline-translator-auto-show']);
    },
  },
  {
    name: 'skips duplicate full-tab translations while one is running',
    async fn() {
      // Both messages go in before either is waited on, so the second one really does
      // arrive while the first is mid-flight — which is the only condition under which
      // the worker has a running translation to recognize.
      let requestCount = 0;

      const worker = helpers.createBackgroundWorker({
        fetch: async () => {
          requestCount += 1;
          await Promise.resolve();
          return {
            ok: true,
            async json() {
              return createCompletedResponse('번역 결과');
            },
          };
        },
        chrome: createTabTranslationChrome({
          settings: {
            apiKey: 'sk-test',
            model: 'ft:gpt_custom/model',
            targetLanguage: 'Japanese',
            tone: 'technical',
            chunkMaxChars: 12000,
          },
          extract: () => ({
            title: 'Article',
            url: 'https://example.test',
            langHint: 'en',
            contentMarkdown: 'Hello world.',
            translationDocument:
              createPlainTranslationDocument('Hello world.'),
          }),
        }),
      });

      const responses = await collectWorkerResponses(worker, [
        { type: 'TRANSLATE_TAB', tabId: 10 },
        { type: 'TRANSLATE_TAB', tabId: 10 },
      ]);

      assert.equal(requestCount, 1);
      assert.deepEqual(responses.find((response) => response.skipped), {
        ok: true,
        skipped: true,
        reason: 'already_running',
      });
    },
  },
  {
    name: 'uses a full-page output token cap scaled to the chunk size',
    async fn() {
      const requestBodies = [];
      const markdown = 'A'.repeat(20000);

      const worker = helpers.createBackgroundWorker({
        fetch: async (_url, options) => {
          requestBodies.push(JSON.parse(options.body));
          return {
            ok: true,
            async json() {
              return createCompletedResponse('번역 결과');
            },
          };
        },
        chrome: createTabTranslationChrome({
          settings: {
            apiKey: 'sk-test',
            model: 'gpt-5.4-mini',
            targetLanguage: 'Korean',
            tone: 'technical',
            chunkMaxChars: 60000,
          },
          extract: () => ({
            title: 'Article',
            url: 'https://example.test',
            langHint: 'en',
            contentMarkdown: markdown,
            translationDocument: createPlainTranslationDocument(markdown),
          }),
        }),
      });

      const responses = await collectWorkerResponses(worker, [
        { type: 'TRANSLATE_TAB', tabId: 11 },
      ]);

      assert.deepEqual(responses, [{ ok: true }]);
      assert.equal(requestBodies.length, 1);
      assert.equal(requestBodies[0].max_output_tokens, markdown.length);
    },
  },
  {
    // The correlation token a batch hands back has to outlive the worker that minted it: the
    // DOM outcome it is reported under arrives after the service worker has been allowed to
    // sleep and come back up. So this drives one worker to get a token and a second one,
    // built on the same platform, to answer for it — which is what an MV3 restart is, and it
    // says so directly: the second worker starts with none of the first one's instance state
    // and only what session storage kept.
    name: 'handles semantic block viewport translation messages',
    async fn() {
      const record = createBlockApiRecord();
      const stored = {};
      // Already in session storage before either worker starts, and never referenced again.
      // Every field a run is stamped with has to come from what the worker itself wrote about
      // the block it translated, so a planted entry claiming otherwise has to go unread.
      const sessionStored = {
        'inlineRuntimeCorrelations:v1': {
          '00000000-0000-4000-8000-000000000000': {
            expiresAt: Date.now() + 60000,
            runId: 'run-1-bad',
            diagnosticId: 'run-1-bad/b1',
            sourceFingerprint: 'raw secret must not persist',
            contractFingerprint: 'raw source must not persist',
            model: 'gpt-5.4-mini',
            targetLanguageCode: 'ko',
            extensionVersion: 'test',
            tabId: 7,
            operationId: 42,
          },
        },
      };

      // Session storage is what makes the restart below mean anything: a worker that has one
      // keeps its correlations there rather than in the map it loses on the way down.
      const chrome = createBlockBatchChrome({
        stored,
        settings: {
          apiKey: 'sk-test',
          model: 'ft:gpt_custom/model',
          reasoningEffort: 'none',
          targetLanguage: 'Japanese',
          tone: 'technical',
        },
        session: {
          async get(keys) {
            const result = {};
            for (const key of Array.isArray(keys) ? keys : [keys]) {
              if (Object.hasOwn(sessionStored, key)) result[key] = sessionStored[key];
            }
            return result;
          },
          async set(values) { Object.assign(sessionStored, values); },
        },
      });
      const platform = {
        chrome,
        fetch: async () => ({
          ok: true,
          async json() {
            return createCompletedResponse(JSON.stringify({
              translations: [{ id: record.id, template: record.template }],
            }));
          },
        }),
      };
      // Every message here comes from the page, so every one of them carries the tab the
      // correlation is scoped to. A token answered under any other tab is refused.
      const sender = { tab: { id: 7 } };

      const worker = helpers.createBackgroundWorker(platform);
      const [batchResponse] = await collectWorkerResponses(worker, [{
        type: 'TRANSLATE_VISIBLE_BLOCK_BATCH',
        operationId: 42,
        records: [record],
      }], sender);

      assert.equal(batchResponse.ok, true);
      const translated = batchResponse.results[0];
      assert.equal(translated.id, record.id);
      assert.equal(typeof translated.correlationToken, 'string');

      // The MV3 service-worker restart between the translation and the DOM outcome: a second
      // construction on the same platform. It has its own empty correlation map and its own
      // per-tab state, so anything it answers below it read back out of session storage.
      const restarted = helpers.createBackgroundWorker(platform);

      const [runtimeResponse] = await collectWorkerResponses(restarted, [{
        type: 'RECORD_INLINE_RUNTIME_DIAGNOSTIC',
        operationId: 42,
        outcomes: [{
          code: 'runtime.apply_failed',
          correlationToken: translated.correlationToken,
          diagnosticCorrelation: {
            sourceFingerprint: 'must not persist forged fingerprint',
            model: 'must not persist forged model',
            extensionVersion: 'must not persist forged version',
          },
          source: 'must not persist',
          template: 'must not persist',
        }],
      }], sender);

      assert.deepEqual(runtimeResponse, { ok: true });
      const runtimeRun = Object.values(stored).find((value) =>
        value?.blocks?.[0]?.terminalCode === 'runtime.apply_failed'
      );
      assert.equal(runtimeRun.model, 'ft:gpt_custom/model');
      assert.equal(runtimeRun.targetLanguageCode, '');
      assert.match(runtimeRun.blocks[0].parentRunId, /^run-/);
      assert.match(runtimeRun.blocks[0].parentDiagnosticId, /^run-.*\/b1$/);
      assert.match(runtimeRun.blocks[0].sourceFingerprint, /^hmac-sha256:/);
      assert.equal(JSON.stringify(runtimeRun).includes('must not persist'), false);

      const [replayResponse] = await collectWorkerResponses(restarted, [{
        type: 'RECORD_INLINE_RUNTIME_DIAGNOSTIC',
        operationId: 42,
        outcomes: [{ code: 'runtime.apply_failed', correlationToken: translated.correlationToken }],
      }], sender);
      assert.deepEqual(replayResponse, { ok: false });

      const bulkEntries = {};
      const bulkOutcomes = [];
      for (let index = 0; index < 500; index += 1) {
        const token = `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
        bulkEntries[token] = {
          expiresAt: Date.now() + 60000,
          runId: 'run-123-bulk',
          diagnosticId: `run-123-bulk/b${index}`,
          sourceFingerprint: `hmac-sha256:${'A'.repeat(43)}`,
          contractFingerprint: `hmac-sha256:${'B'.repeat(43)}`,
          model: 'gpt-5.4-mini',
          targetLanguageCode: 'ko',
          extensionVersion: 'test',
          tabId: 7,
          operationId: 99,
        };
        bulkOutcomes.push({ code: 'runtime.apply_failed', correlationToken: token });
      }
      sessionStored['inlineRuntimeCorrelations:v1'] = bulkEntries;
      const [bulkResponse] = await collectWorkerResponses(restarted, [{
        type: 'RECORD_INLINE_RUNTIME_DIAGNOSTIC',
        operationId: 99,
        outcomes: bulkOutcomes,
      }], sender);
      assert.deepEqual(bulkResponse, { ok: true });
      const bulkRun = Object.values(stored).find((value) => value?.summary?.failed === 500);
      assert.equal(bulkRun.blocks.length, 100);
      assert.equal(Object.keys(sessionStored['inlineRuntimeCorrelations:v1']).length, 0);

      const [localResponse] = await collectWorkerResponses(restarted, [{
        type: 'RECORD_INLINE_LOCAL_DIAGNOSTIC',
        diagnosticBatchId: '11111111-1111-4111-8111-111111111111',
        operationId: 123,
        settingsSnapshot: { model: 'gpt-5.4-mini', targetLanguage: 'Korean' },
        diagnostics: [
          {
            code: 'runtime.block_too_large',
            template: 'x'.repeat(8000),
            contract: {
              codecVersion: 1,
              literalTokens: Array.from({ length: 24 }, (_, index) => ({
                value: `${index}-${'y'.repeat(195)}`,
                count: 1,
              })),
            },
          },
          {
            code: 'runtime.block_too_large',
            template: record.template,
            contract: record.contract,
            evidence: { recordCost: 13000, limit: 12000, raw: 'ignored' },
          },
        ],
      }], sender);
      assert.deepEqual(localResponse, { ok: true });
      const localRun = Object.values(stored).find((value) =>
        value?.blocks?.[0]?.terminalCode === 'runtime.block_too_large'
      );
      assert.equal(localRun.summary.requested, 1);
      assert.equal(localRun.blocks[0].quality.evidence.recordCost, 13000);
      assert.equal(localRun.blocks[0].quality.evidence.limit, 12000);
      const expectedFingerprints = await require('../extension/translation-diagnostics.js')
        .fingerprintBlock(chrome, record.template, record.contract);
      assert.equal(localRun.blocks[0].sourceFingerprint, expectedFingerprints.sourceFingerprint);
      assert.equal(localRun.blocks[0].contractFingerprint, expectedFingerprints.contractFingerprint);
      assert.equal(JSON.stringify(localRun).includes(record.template), false);

      const [duplicateResponse] = await collectWorkerResponses(restarted, [{
        type: 'RECORD_INLINE_LOCAL_DIAGNOSTIC',
        diagnosticBatchId: '11111111-1111-4111-8111-111111111111',
        operationId: 123,
        settingsSnapshot: { model: 'gpt-5.4-mini', targetLanguage: 'Korean' },
        diagnostics: [{
          code: 'runtime.block_too_large',
          template: record.template,
          contract: record.contract,
          evidence: { recordCost: 13000, limit: 12000 },
        }],
      }], sender);
      assert.deepEqual(duplicateResponse, { ok: true });
      const localRunId = 'local-7-123-11111111-1111-4111-8111-111111111111';
      assert.equal(stored['inlineDiagnostics:v2:index'].filter((id) => id === localRunId).length, 1);
      assert.equal(Object.keys(stored).filter((key) => key === `inlineDiagnostics:v2:run:${localRunId}`).length, 1);

      const [conflictResponse] = await collectWorkerResponses(restarted, [{
        type: 'RECORD_INLINE_LOCAL_DIAGNOSTIC',
        diagnosticBatchId: '11111111-1111-4111-8111-111111111111',
        operationId: 123,
        settingsSnapshot: { model: 'gpt-5.4-mini', targetLanguage: 'Korean' },
        diagnostics: [{
          code: 'runtime.session_too_large',
          evidence: { sessionCost: 60000, limit: 60000 },
        }],
      }], sender);
      assert.deepEqual(conflictResponse, { ok: false });
      assert.equal(stored[`inlineDiagnostics:v2:run:${localRunId}`].blocks[0].terminalCode, 'runtime.block_too_large');
    },
  },
  {
    // The text-node path outlived its only caller for 62 commits because nothing asserted
    // that a retired name stays retired. Every message the text-node path used is listed
    // here, so reviving one half of it fails loudly instead of sitting in the tree.
    //
    // A worker with nothing but a network is the point rather than an economy: each of these
    // messages has to be turned away before anything is reached, so an answer that took any
    // other path would fail on the namespace it went looking for instead of quietly passing.
    name: 'does not answer any retired text-node translation message',
    async fn() {
      let fetchCount = 0;
      const worker = helpers.createBackgroundWorker({
        fetch: async () => {
          fetchCount += 1;
          return {
            ok: true,
            async json() {
              return createCompletedResponse(JSON.stringify({
                translations: [{ id: 'n1', translation: '안녕하세요.' }],
              }));
            },
          };
        },
      });

      const retiredMessages = [
        {
          type: 'TRANSLATE_TEXT_NODES',
          records: [{ id: 'n1', text: 'Hello world.' }],
        },
        {
          type: 'TRANSLATE_VISIBLE_TEXT_BATCH',
          records: [{ id: 'v1', text: 'Hello world.' }],
          settingsSnapshot: null,
        },
        {
          type: 'INLINE_TRANSLATION_PROGRESS',
          operationId: 1,
          progress: { stage: 'queued', recordCount: 1, chunkCount: 1 },
        },
      ];

      // One message at a time, because the assertion names the message it failed on and three
      // identical answers collected together could only be matched back to it by position.
      for (const message of retiredMessages) {
        const [response] = await collectWorkerResponses(worker, [message]);

        assert.deepEqual(
          response,
          { ok: false, error: { message: 'Unknown message' } },
          `${message.type} is answered again`
        );
      }

      assert.equal(fetchCount, 0);
    },
  },
  {
    name: 'isolates a malformed repair response and preserves its protocol code',
    async fn() {
      const first = createBlockApiRecord('first');
      const second = createBlockApiRecord('second');
      const firstTranslation = first.template
        .replace('Reasoning models', '추론 모델')
        .replace(' like ', '와 같은 ')
        .replace(' use internal reasoning tokens.', '은 내부 추론 토큰을 사용합니다.');
      let call = 0;
      const worker = helpers.createBackgroundWorker({
        chrome: createBlockBatchChrome(),
        fetch: async () => {
          call += 1;
          if (call === 2) {
            return { ok: true, async json() { return createCompletedResponse('{invalid'); } };
          }
          return { ok: true, async json() { return createCompletedResponse(JSON.stringify({
            translations: [
              { id: first.id, template: firstTranslation },
              { id: second.id, template: second.template },
            ],
          })); } };
        },
      });

      const results = await worker.translateVisibleBlockBatch([first, second]);
      assert.equal(results.find((result) => result.id === first.id).disposition, 'apply');
      assert.equal(results.find((result) => result.id === second.id).terminalCode, 'protocol.invalid_json');
    },
  },
  {
    // The content script charges the Session Budget a second time for a block whose
    // `attemptCount` comes back as 2, so this field is what a repair request costs the
    // reader. It is produced here, and until now it was only ever asserted where it is
    // consumed — the shape of failure ADR-0003 was written about.
    name: 'reports the second real request a repair makes as attemptCount 2',
    async fn() {
      const repaired = createTestPlainBlockRecord('needs-repair');
      repaired.template = 'Hello world.';
      const clean = createTestPlainBlockRecord('first-time');
      clean.template = 'Hello world.';

      let repairCalls = 0;
      const repairWorker = helpers.createBackgroundWorker({
        chrome: createBlockBatchChrome(),
        fetch: async () => {
          repairCalls += 1;
          return { ok: true, async json() { return createCompletedResponse(JSON.stringify({
            translations: [{
              id: repaired.id,
              template: repairCalls === 1 ? repaired.template : '한국어 문장입니다.',
            }],
          })); } };
        },
      });

      const repairedResults = await repairWorker.translateVisibleBlockBatch([repaired]);

      assert.equal(repairCalls, 2);
      assert.equal(repairedResults[0].disposition, 'apply');
      assert.equal(repairedResults[0].attemptCount, 2);

      // The control: one request, and nothing for the content script to charge twice. What
      // separates it from the case above is the answers, and the network a worker translates
      // against is fixed when the worker is built, so the control gets a worker of its own.
      let cleanCalls = 0;
      const cleanWorker = helpers.createBackgroundWorker({
        chrome: createBlockBatchChrome(),
        fetch: async () => {
          cleanCalls += 1;
          return { ok: true, async json() { return createCompletedResponse(JSON.stringify({
            translations: [{ id: clean.id, template: '한국어 문장입니다.' }],
          })); } };
        },
      });

      const cleanResults = await cleanWorker.translateVisibleBlockBatch([clean]);

      assert.equal(cleanCalls, 1);
      assert.equal(cleanResults[0].disposition, 'apply');
      assert.equal(cleanResults[0].attemptCount, 1);
    },
  },
  {
    name: 'persists repaired detail and falls back to compact final when fingerprints fail',
    async fn() {
      const diagnostics = require('../extension/translation-diagnostics.js');
      const previousFingerprintBlock = diagnostics.fingerprintBlock;
      const stored = {};
      let record = createTestPlainBlockRecord('repair-success');
      record.template = 'Hello world.';
      let call = 0;
      const worker = helpers.createBackgroundWorker({
        chrome: createBlockBatchChrome({ stored }),
        fetch: async () => {
          call += 1;
          return { ok: true, async json() { return createCompletedResponse(JSON.stringify({
            translations: [{ id: record.id, template: call === 1 ? record.template : '한국어 문장입니다.' }],
          })); } };
        },
      });

      // Fingerprinting is the one thing here that is still borrowed rather than handed over:
      // it lives in the diagnostics module, which closes over its own global scope, so making
      // it fail means replacing it and putting it back afterwards.
      try {
        const detailedResults = await worker.translateVisibleBlockBatch([record]);
        const detailedRun = Object.values(stored).find((value) => value?.blocks?.length === 1);
        assert.equal(detailedResults[0].disposition, 'apply');
        assert.equal(detailedResults[0].diagnosticsUnavailable, undefined);
        assert.equal(detailedRun.outcome, 'done');
        assert.equal(detailedRun.blocks[0].terminalDisposition, 'apply');
        assert.equal(detailedRun.blocks[0].terminalCode, '');
        assert.equal(detailedRun.blocks[0].timeline[1].disposition, 'apply');

        record = createTestPlainBlockRecord('fingerprint-failure');
        record.template = 'Hello world.';
        call = 0;
        diagnostics.fingerprintBlock = async () => { throw new Error('fingerprint unavailable'); };
        const fallbackResults = await worker.translateVisibleBlockBatch([record]);
        const compactRun = Object.values(stored).find((value) =>
          value?.outcome === 'done' && Array.isArray(value.blocks) && value.blocks.length === 0
        );
        assert.equal(fallbackResults[0].disposition, 'apply');
        assert.equal(fallbackResults[0].diagnosticsUnavailable, true);
        assert.ok(compactRun);
      } finally {
        diagnostics.fingerprintBlock = previousFingerprintBlock;
      }
    },
  },
  {
    name: 'names the model and the batch size in the run a failed request leaves behind',
    async fn() {
      const stored = {};
      const first = createTestPlainBlockRecord('failed-first');
      const second = createTestPlainBlockRecord('failed-second');
      first.template = 'Hello world.';
      second.template = 'Goodbye world.';
      const worker = helpers.createBackgroundWorker({
        chrome: createBlockBatchChrome({ stored }),
        fetch: async () => { throw new Error('network is down'); },
      });

      await assert.rejects(
        worker.translateVisibleBlockBatch([first, second]),
        /network is down/
      );
      const failedRun = Object.values(stored).find((value) => value?.outcome === 'failed');
      assert.ok(failedRun, 'the failed request is written to diagnostics');
      assert.equal(failedRun.model, 'gpt-5.4-mini');
      assert.equal(failedRun.summary.requested, 2);
      assert.equal(failedRun.summary.failed, 2);
    },
  },
  {
    // Two runs of one tab can start in the same millisecond, so the timestamp cannot be the
    // whole id. The crypto is the whole platform here, and handing over one that answers
    // differently every time is what makes the check say that: the worker has to ask it per
    // id rather than once per millisecond, which is the only way two ids stamped 1234 differ.
    name: 'creates collision-resistant runtime diagnostic ids within one millisecond',
    fn() {
      let issued = 0;
      const worker = helpers.createBackgroundWorker({
        crypto: {
          randomUUID() {
            issued += 1;
            return `00000000-0000-4000-8000-${String(issued).padStart(12, '0')}`;
          },
        },
      });

      const first = worker.createRuntimeDiagnosticId(1234);
      const second = worker.createRuntimeDiagnosticId(1234);
      assert.notEqual(first, second);
      assert.match(first, /^runtime-1234-/);
    },
  },
  {
    name: 'plans the side panel as the first step for both triggers',
    fn() {
      for (const trigger of ['action', 'command']) {
        assert.equal(helpers.planInvocation({ trigger }).steps[0], 'openSidePanel');
      }
    },
  },
  {
    name: 'runs the first plan step before awaiting anything',
    async fn() {
      // ADR-0001. The gesture that authorizes sidePanel.open() is spent by the first
      // await on the path from the listener to the call, so the guard has to be that
      // nothing awaits ahead of it — not merely that the plan lists it first. An await
      // added above the loop in runInvocationPlan fails here and nowhere else in this
      // suite. Deliberately not awaiting the returned promise before asserting.
      let openedSynchronously = false;
      const worker = helpers.createBackgroundWorker();
      const running = worker.runInvocationPlan(
        helpers.planInvocation({ trigger: 'action' }),
        1,
        {
          openSidePanel: () => {
            openedSynchronously = true;
          },
          injectContentScripts: () => {},
          grantInlineTranslationAuthorization: () => {},
          mountFloatingTranslateButton: () => {},
        }
      );
      assert.equal(openedSynchronously, true);
      await running;
    },
  },
  {
    name: 'opens the side panel before reasserting its options',
    async fn() {
      // Same constraint one level down: setOptions only restates the manifest default,
      // so awaiting it ahead of open() would spend the gesture for nothing.
      const calls = [];
      const chrome = {
        sidePanel: {
          async open() {
            calls.push('open');
          },
          async setOptions() {
            calls.push('setOptions');
          },
        },
      };
      const worker = helpers.createBackgroundWorker({ chrome });
      await worker.ensureSidePanel(11);
      assert.deepEqual(calls, ['open', 'setOptions']);
    },
  },
  {
    name: 'injects and authorizes inline translation from both the toolbar action and the command',
    fn() {
      for (const trigger of ['action', 'command']) {
        const { steps } = helpers.planInvocation({ trigger });
        assert.ok(steps.includes('injectContentScripts'));
        assert.ok(steps.includes('grantInlineTranslationAuthorization'));
      }
    },
  },
  {
    name: 'never mounts the Floating Translate Button where the reader chose never',
    fn() {
      // The invocation still injects the content scripts and grants Inline Translation
      // Authorization. Mounting the button is a separate step, which is the whole reason
      // never can be honoured without switching the rest of an invocation off with it.
      for (const trigger of ['action', 'command', 'pageLoad']) {
        assert.equal(
          helpers
            .planInvocation({ trigger, settings: { buttonVisibility: 'never' } })
            .steps.includes('mountFloatingTranslateButton'),
          false
        );
      }
    },
  },
  {
    name: 'mounts the Floating Translate Button on invocation where the reader chose on invocation',
    fn() {
      for (const trigger of ['action', 'command']) {
        assert.ok(
          helpers
            .planInvocation({
              trigger,
              settings: { buttonVisibility: 'onInvocation' },
            })
            .steps.includes('mountFloatingTranslateButton')
        );
      }
      assert.deepEqual(
        helpers.planInvocation({
          trigger: 'pageLoad',
          settings: { buttonVisibility: 'onInvocation' },
        }).steps,
        []
      );
    },
  },
  {
    name: 'mounts the Floating Translate Button on page load only where it shows on all pages',
    fn() {
      assert.deepEqual(
        helpers.planInvocation({
          trigger: 'pageLoad',
          settings: { buttonVisibility: 'allPages' },
        }).steps,
        ['mountFloatingTranslateButton']
      );
      assert.deepEqual(
        helpers.planInvocation({
          trigger: 'pageLoad',
          settings: { buttonVisibility: 'never' },
        }).steps,
        []
      );
      assert.deepEqual(helpers.planInvocation({ trigger: 'pageLoad' }).steps, []);
    },
  },
  {
    name: 'plans an invocation from a migrated install as the old checkbox did',
    fn() {
      assert.ok(
        helpers
          .planInvocation({
            trigger: 'pageLoad',
            settings: { buttonVisibility: 'allPages' },
          })
          .steps.includes('mountFloatingTranslateButton')
      );
      assert.deepEqual(
        helpers.planInvocation({
          trigger: 'pageLoad',
          settings: { inlineAutoShow: false },
        }).steps,
        []
      );
    },
  },
  {
    name: 'starts Inline Translation for the shortcut but not the toolbar action',
    fn() {
      // ADR-0004. Reaching the side panel spends nothing, and only the reader who reached
      // for the Inline Translation Shortcut asked for a translation — so the shortcut is
      // still the one invocation that starts one, and what it starts is now the feature
      // the steps above it have just finished preparing the page for.
      const settings = { buttonVisibility: 'onInvocation' };
      assert.deepEqual(
        helpers.planInvocation({ trigger: 'action', settings }).steps,
        [
          'openSidePanel',
          'injectContentScripts',
          'grantInlineTranslationAuthorization',
          'mountFloatingTranslateButton',
        ]
      );
      assert.deepEqual(
        helpers.planInvocation({ trigger: 'command', settings }).steps,
        [
          'openSidePanel',
          'injectContentScripts',
          'grantInlineTranslationAuthorization',
          'mountFloatingTranslateButton',
          'startInlineTranslation',
        ]
      );
    },
  },
  {
    name: 'starts Inline Translation from the shortcut where the reader chose never',
    fn() {
      // Button Visibility says when the Floating Translate Button may appear, not whether
      // Inline Translation may run. The side panel the shortcut opens carries the same
      // controls, so a run under never still has a home to report from.
      assert.deepEqual(
        helpers.planInvocation({
          trigger: 'command',
          settings: { buttonVisibility: 'never' },
        }).steps,
        [
          'openSidePanel',
          'injectContentScripts',
          'grantInlineTranslationAuthorization',
          'startInlineTranslation',
        ]
      );
    },
  },
  {
    name: 'plans no step that starts Side Panel Translation',
    fn() {
      // ADR-0004: the step is removed rather than left unused. The side panel's own
      // Translate button sends TRANSLATE_TAB straight to the worker without an invocation
      // plan, so no plan has a caller to serve — and putting one back would be taking the
      // shortcut away from Inline Translation again.
      //
      // The removed step's name is checked, which catches the plain revert, and so is the
      // property that outlives the name: every step of a plan is either one of the two the
      // worker carries out itself or an instruction the content script understands. A step
      // that translates in the worker is neither, so it cannot come back under any name
      // without failing here.
      const workerSteps = ['openSidePanel', 'injectContentScripts'];
      const understood = Object.keys(
        contentHelpers.getDefaultInlineInstructionHandlers({})
      );
      for (const trigger of ['action', 'command', 'pageLoad', undefined]) {
        for (const buttonVisibility of ['never', 'onInvocation', 'allPages']) {
          const { steps } = helpers.planInvocation({
            trigger,
            settings: { buttonVisibility },
          });
          assert.equal(steps.includes('startSidePanelTranslation'), false);
          for (const step of steps) {
            assert.ok(
              workerSteps.includes(step) || understood.includes(step),
              `${step} is neither the worker's own step nor one the page can carry out`
            );
          }
        }
      }
    },
  },
  {
    name: 'opens the side panel before reading the settings the rest of the plan needs',
    async fn() {
      // ADR-0001: the panel opens only from inside the click's own task, and Button
      // Visibility can only be read asynchronously. Reading it first would forfeit the
      // gesture — silently, since Chrome simply refuses to open the panel.
      const calls = [];
      let releaseSettings = null;

      const chrome = {
        storage: {
          local: {
            get() {
              calls.push('readSettings');
              return new Promise((resolve) => {
                releaseSettings = () =>
                  resolve({ settings: { buttonVisibility: 'onInvocation' } });
              });
            },
          },
        },
      };
      const worker = helpers.createBackgroundWorker({ chrome });

      const running = worker.runInvocation('action', 9, {
        openSidePanel: async (tabId) => calls.push(`openSidePanel:${tabId}`),
        injectContentScripts: async () => calls.push('injectContentScripts'),
        grantInlineTranslationAuthorization: async () =>
          calls.push('grantInlineTranslationAuthorization'),
        mountFloatingTranslateButton: async () =>
          calls.push('mountFloatingTranslateButton'),
      });

      assert.deepEqual(calls, ['openSidePanel:9', 'readSettings']);
      releaseSettings();
      await running;
      assert.deepEqual(calls, [
        'openSidePanel:9',
        'readSettings',
        'injectContentScripts',
        'grantInlineTranslationAuthorization',
        'mountFloatingTranslateButton',
      ]);
    },
  },
  {
    name: 'opens the side panel exactly once per invocation',
    async fn() {
      // The step is started before the plan runs, so the plan must adopt what is already
      // running rather than open a second panel.
      const calls = [];

      const chrome = {
        storage: {
          local: {
            async get() {
              return { settings: { buttonVisibility: 'never' } };
            },
          },
        },
      };
      const worker = helpers.createBackgroundWorker({ chrome });

      await worker.runInvocation('action', 2, {
        openSidePanel: async () => calls.push('openSidePanel'),
        injectContentScripts: async () => calls.push('injectContentScripts'),
        grantInlineTranslationAuthorization: async () =>
          calls.push('grantInlineTranslationAuthorization'),
      });

      assert.deepEqual(calls, [
        'openSidePanel',
        'injectContentScripts',
        'grantInlineTranslationAuthorization',
      ]);
    },
  },
  {
    name: 'runs plan steps in order and reports which ran',
    async fn() {
      const calls = [];
      const handlers = {
        openSidePanel: async (tabId) => calls.push(`openSidePanel:${tabId}`),
        injectContentScripts: async (tabId) => calls.push(`injectContentScripts:${tabId}`),
        grantInlineTranslationAuthorization: async (tabId) =>
          calls.push(`grantInlineTranslationAuthorization:${tabId}`),
        mountFloatingTranslateButton: async (tabId) =>
          calls.push(`mountFloatingTranslateButton:${tabId}`),
        startInlineTranslation: async (tabId) => calls.push(`startInlineTranslation:${tabId}`),
      };

      const settings = { buttonVisibility: 'onInvocation' };
      const worker = helpers.createBackgroundWorker();
      await worker.runInvocationPlan(
        helpers.planInvocation({ trigger: 'command', settings }),
        7,
        handlers
      );
      assert.deepEqual(calls, [
        'openSidePanel:7',
        'injectContentScripts:7',
        'grantInlineTranslationAuthorization:7',
        'mountFloatingTranslateButton:7',
        'startInlineTranslation:7',
      ]);

      calls.length = 0;
      await worker.runInvocationPlan(
        helpers.planInvocation({ trigger: 'action', settings }),
        7,
        handlers
      );
      assert.deepEqual(calls, [
        'openSidePanel:7',
        'injectContentScripts:7',
        'grantInlineTranslationAuthorization:7',
        'mountFloatingTranslateButton:7',
      ]);
    },
  },
  {
    name: 'only instructs the content script in steps the content script can carry out',
    fn() {
      // The instruction the worker sends is the plan step's own name, so the two sides
      // share one vocabulary and nothing links them. A rename on either side would fail
      // silently: the content script rejects the instruction, the worker never reads the
      // response, and the plan runner swallows what is left.
      const understood = Object.keys(
        contentHelpers.getDefaultInlineInstructionHandlers({})
      );
      for (const trigger of ['action', 'command', 'pageLoad']) {
        const instructions = helpers.getInlineInstructions(
          helpers.planInvocation({ trigger, settings: { buttonVisibility: 'allPages' } })
        );
        for (const instruction of instructions) {
          assert.ok(
            understood.includes(instruction),
            `content script cannot run ${instruction}`
          );
        }
      }
      assert.deepEqual(
        helpers.getInlineInstructions(
          helpers.planInvocation({
            trigger: 'action',
            settings: { buttonVisibility: 'onInvocation' },
          })
        ),
        ['grantInlineTranslationAuthorization', 'mountFloatingTranslateButton']
      );
      assert.deepEqual(
        helpers.getInlineInstructions(
          helpers.planInvocation({
            trigger: 'command',
            settings: { buttonVisibility: 'never' },
          })
        ),
        ['grantInlineTranslationAuthorization', 'startInlineTranslation']
      );
    },
  },
  {
    name: 'authorizes Inline Translation ahead of every control in the section',
    fn() {
      // A control in the Inline Translation Section is a deliberate reader gesture through
      // extension-owned UI a page cannot forge, so it grants the authorization rather than
      // requiring one. That is also what keeps a panel left open past the expiry working.
      assert.deepEqual(helpers.planInlineTranslationControl('start').steps, [
        'grantInlineTranslationAuthorization',
        'startInlineTranslation',
      ]);
      assert.deepEqual(helpers.planInlineTranslationControl('stop').steps, [
        'grantInlineTranslationAuthorization',
        'stopInlineTranslation',
      ]);
      assert.deepEqual(helpers.planInlineTranslationControl('restore').steps, [
        'grantInlineTranslationAuthorization',
        'restoreInlineOriginal',
      ]);
      assert.deepEqual(helpers.planInlineTranslationControl('translateTab').steps, []);
      assert.deepEqual(helpers.planInlineTranslationControl().steps, []);
    },
  },
  {
    name: 'only asks the content script for section controls it can carry out',
    fn() {
      const understood = Object.keys(
        contentHelpers.getDefaultInlineInstructionHandlers({})
      );
      for (const control of ['start', 'stop', 'restore']) {
        for (const step of helpers.planInlineTranslationControl(control).steps) {
          assert.ok(
            understood.includes(step),
            `content script cannot run ${step}`
          );
        }
      }
    },
  },
  {
    name: 'stops a section control at the first step the tab refuses',
    async fn() {
      // Unlike an invocation, whose steps are independent, a control is one gesture: if
      // the authorization did not land, carrying on would run it unauthorized, and the
      // reader has to be told their click did nothing.
      const sent = [];
      const worker = helpers.createBackgroundWorker();
      await assert.rejects(
        worker.runInlineTranslationControl(9, 'start', async (tabId, step) => {
          sent.push(`${step}:${tabId}`);
          throw new Error('Could not establish connection.');
        }),
        /Could not establish connection/
      );
      assert.deepEqual(sent, ['grantInlineTranslationAuthorization:9']);

      await assert.rejects(
        worker.runInlineTranslationControl(9, 'nonsense', async () => {}),
        /nonsense/
      );
    },
  },
  {
    name: 'treats an instruction the page refused as a failure, not a success',
    async fn() {
      // The content script answers whether it carried the instruction out, and it catches
      // its own throw to do so. A sender that read only the transport would report a
      // gesture the page declined as done, and the panel would render success.
      const refusingPage = helpers.createBackgroundWorker({
        chrome: {
          tabs: {
            async sendMessage() {
              return { ok: false, error: { message: 'no page to authorize' } };
            },
          },
        },
      });
      await assert.rejects(
        refusingPage.sendInlineInstruction(5, 'grantInlineTranslationAuthorization'),
        /no page to authorize/
      );

      const silentPage = helpers.createBackgroundWorker({
        chrome: { tabs: { async sendMessage() {} } },
      });
      await assert.rejects(
        silentPage.sendInlineInstruction(5, 'startInlineTranslation'),
        /startInlineTranslation/
      );
    },
  },
  {
    name: 'stops a control at the step the page refuses, before it runs unauthorized',
    async fn() {
      const sent = [];
      const chrome = {
        tabs: {
          async sendMessage(tabId, message) {
            sent.push(message.instruction);
            return message.instruction === 'grantInlineTranslationAuthorization'
              ? { ok: false, error: { message: 'no page to authorize' } }
              : { ok: true };
          },
        },
      };
      const worker = helpers.createBackgroundWorker({ chrome });
      await assert.rejects(
        worker.runInlineTranslationControl(5, 'start'),
        /no page to authorize/
      );
      assert.deepEqual(sent, ['grantInlineTranslationAuthorization']);
    },
  },
  {
    name: 'tells the reader what to do when no content script answers a control',
    fn() {
      // Chrome's own answer names no action the reader can take, and the action they need
      // is the one the missing-access failure already asks for.
      const missingAccess = helpers.classifyContentScriptFailure(
        new Error('Cannot access contents of the page at url "https://example.com/"'),
        'https://example.com/'
      ).message;

      assert.equal(
        helpers.describeInlineTranslationControlFailure(
          new Error(
            'Could not establish connection. Receiving end does not exist.'
          )
        ),
        missingAccess
      );
      assert.match(
        helpers.describeInlineTranslationControlFailure(
          new Error('Unknown inline translation control: nonsense')
        ),
        /nonsense/
      );
      assert.ok(
        helpers.describeInlineTranslationControlFailure(null).length > 0
      );
    },
  },
  {
    name: 'injects and authorizes without mounting when the plan leaves the button out',
    async fn() {
      // The three concerns are separate steps precisely so a plan can carry the first two
      // alone. Nothing in the extension yet produces such a plan for an invocation, but the
      // runner must honour one when Button Visibility starts suppressing the button.
      const calls = [];
      const worker = helpers.createBackgroundWorker();
      await worker.runInvocationPlan(
        { steps: ['injectContentScripts', 'grantInlineTranslationAuthorization'] },
        4,
        {
          injectContentScripts: async () => calls.push('injectContentScripts'),
          grantInlineTranslationAuthorization: async () =>
            calls.push('grantInlineTranslationAuthorization'),
          mountFloatingTranslateButton: async () => calls.push('mountFloatingTranslateButton'),
        }
      );
      assert.deepEqual(calls, [
        'injectContentScripts',
        'grantInlineTranslationAuthorization',
      ]);
    },
  },
  {
    name: 'keeps running later steps when injecting the content scripts fails',
    async fn() {
      // Injection legitimately fails on pages extensions cannot touch, and one refused
      // step must not cost an invocation the rest of them — the plan's steps are
      // independent. On such a page every step that speaks to the content script fails
      // with it, the shortcut's own start step included; the start step is reported to
      // the reader as well, which the tests below cover, but no step's failure — nor the
      // report of it — may stop the steps after it.
      const attempted = [];
      // The start step's failure is reported, and the report has somewhere to go here.
      // What it says is the next check's business; what matters to this one is that no
      // step's failure stopped the step after it, report included.
      const worker = helpers.createBackgroundWorker({
        chrome: createStateBroadcastChrome([]),
      });
      await worker.runInvocationPlan(
        helpers.planInvocation({
          trigger: 'command',
          settings: { buttonVisibility: 'onInvocation' },
        }),
        3,
        {
          openSidePanel: async () => attempted.push('openSidePanel'),
          injectContentScripts: async () => {
            attempted.push('injectContentScripts');
            throw new Error('Cannot access contents of the page');
          },
          grantInlineTranslationAuthorization: async () => {
            attempted.push('grantInlineTranslationAuthorization');
            throw new Error('Could not establish connection');
          },
          mountFloatingTranslateButton: async () => {
            attempted.push('mountFloatingTranslateButton');
            throw new Error('Could not establish connection');
          },
          startInlineTranslation: async () => {
            attempted.push('startInlineTranslation');
            throw new Error('Could not establish connection');
          },
        }
      );
      assert.deepEqual(attempted, [
        'openSidePanel',
        'injectContentScripts',
        'grantInlineTranslationAuthorization',
        'mountFloatingTranslateButton',
        'startInlineTranslation',
      ]);
    },
  },
  {
    name: 'tells the reader when the shortcut could not start a run, and stays silent otherwise',
    async fn() {
      // The start step is the one the reader pressed for: on a tab out of reach its
      // silence is indistinguishable from a translation about to appear. The steps that
      // prepare the page are not what they pressed, so those stay silent.
      const broadcasts = [];
      const worker = helpers.createBackgroundWorker({
        chrome: createStateBroadcastChrome(broadcasts),
      });

      await worker.runInvocationPlan(
        helpers.planInvocation({
          trigger: 'command',
          settings: { buttonVisibility: 'onInvocation' },
        }),
        4201,
        {
          openSidePanel: async () => {},
          injectContentScripts: async () => {
            throw new Error('Cannot access contents of the page');
          },
          grantInlineTranslationAuthorization: async () => {
            throw new Error('Could not establish connection');
          },
          mountFloatingTranslateButton: async () => {
            throw new Error('Could not establish connection');
          },
          startInlineTranslation: async () => {
            throw new Error(
              'Could not establish connection. Receiving end does not exist.'
            );
          },
        }
      );

      assert.equal(broadcasts.length, 1);
      const [update] = broadcasts;
      assert.equal(update.type, 'STATE_UPDATED');
      assert.equal(update.tabId, 4201);
      assert.match(
        update.state.inlineTranslationError.message,
        /Click the extension icon on this tab/
      );
      // Side Panel Translation's error area is not where this belongs.
      assert.equal(update.state.error, undefined);
    },
  },
  {
    name: 'clears a reported start failure once a later run on the tab starts',
    async fn() {
      const broadcasts = [];
      const worker = helpers.createBackgroundWorker({
        chrome: createStateBroadcastChrome(broadcasts),
      });

      const plan = { steps: ['startInlineTranslation'] };
      const refusing = {
        startInlineTranslation: async () => {
          throw new Error('Could not establish connection.');
        },
      };
      const accepting = { startInlineTranslation: async () => {} };

      await worker.runInvocationPlan(plan, 4201, refusing);
      assert.equal(broadcasts.length, 1);

      await worker.runInvocationPlan(plan, 4201, accepting);
      assert.equal(broadcasts.length, 2);
      assert.equal(broadcasts[1].state.inlineTranslationError, null);

      // Nothing left to clear, so a run that starts on a tab carrying no failure says
      // nothing at all.
      await worker.runInvocationPlan(plan, 4201, accepting);
      assert.equal(broadcasts.length, 2);
    },
  },
  {
    name: 'withdraws a reported start failure once the tab answers an invocation again',
    async fn() {
      // The message asks for a click on the extension icon. That click is an invocation,
      // and its injection step succeeding is the tab answering it — so the message is
      // withdrawn without waiting for a run the reader has not started yet. On a page no
      // click can grant, injection fails too and the message stands.
      const broadcasts = [];
      const worker = helpers.createBackgroundWorker({
        chrome: createStateBroadcastChrome(broadcasts),
      });

      const grantedByClick = {
        openSidePanel: async () => {},
        injectContentScripts: async () => {},
        grantInlineTranslationAuthorization: async () => {},
      };
      const clickOnAPageChromeKeepsToItself = {
        ...grantedByClick,
        injectContentScripts: async () => {
          throw new Error('Cannot access contents of the page');
        },
      };
      const actionInvocation = helpers.planInvocation({
        trigger: 'action',
        settings: { buttonVisibility: 'never' },
      });
      const refusedStart = {
        startInlineTranslation: async () => {
          throw new Error('Could not establish connection.');
        },
      };

      await worker.runInvocationPlan(
        { steps: ['startInlineTranslation'] },
        4201,
        refusedStart
      );
      assert.equal(broadcasts.length, 1);

      await worker.runInvocationPlan(
        actionInvocation,
        4201,
        clickOnAPageChromeKeepsToItself
      );
      assert.equal(broadcasts.length, 1);

      await worker.runInvocationPlan(actionInvocation, 4201, grantedByClick);
      assert.equal(broadcasts.length, 2);
      assert.equal(broadcasts[1].state.inlineTranslationError, null);
    },
  },
  {
    name: 'clears a reported start failure when a control the reader pressed runs',
    async fn() {
      // The field says Inline Translation could not be reached on this tab. A control the
      // tab has just carried out disproves that, whichever of the three it was, and the
      // reader has one more home for these controls than the shortcut.
      const broadcasts = [];
      const worker = helpers.createBackgroundWorker({
        chrome: createStateBroadcastChrome(broadcasts),
      });

      await worker.runInvocationPlan({ steps: ['startInlineTranslation'] }, 4201, {
        startInlineTranslation: async () => {
          throw new Error('Could not establish connection.');
        },
      });
      assert.equal(broadcasts.length, 1);

      await worker.runInlineTranslationControl(4201, 'start', async () => {});
      assert.equal(broadcasts.length, 2);
      assert.equal(broadcasts[1].state.inlineTranslationError, null);
    },
  },
  {
    name: 'keeps the two translations’ failures in separate fields',
    fn() {
      // CONTEXT.md spends half its vocabulary keeping the two translations apart. An error
      // box that merged them would undo that for the one moment the reader most needs to
      // know which feature is talking.
      const state = helpers.sanitizePublicTabState({
        status: 'error',
        error: { message: 'Side Panel Translation failed', name: 'Error', stack: 'x' },
        inlineTranslationError: {
          message: 'Inline Translation could not start',
          stack: 'x',
        },
      });

      assert.equal(state.error.message, 'Side Panel Translation failed');
      assert.equal(state.error.stack, undefined);
      assert.equal(
        state.inlineTranslationError.message,
        'Inline Translation could not start'
      );
      assert.equal(state.inlineTranslationError.stack, undefined);
    },
  },
  {
    name: 'tells a reader without tab access to click the extension icon',
    fn() {
      // Chrome's wording when neither activeTab nor a host permission covers the tab.
      const classified = helpers.classifyContentScriptFailure(
        new Error(
          'Cannot access contents of the page. Extension manifest must request permission to access the respective host.'
        ),
        'https://example.com/article'
      );
      assert.equal(classified.reason, 'missing_access');
      assert.match(classified.message, /extension icon/i);
      assert.doesNotMatch(classified.message, /chrome:\/\//i);
    },
  },
  {
    name: 'tells a reader on a page extensions cannot run on that the page is the problem',
    fn() {
      for (const [failure, url] of [
        [new Error('Cannot access a chrome:// URL'), ''],
        [
          new Error('Cannot access contents of url "chrome://settings/".'),
          '',
        ],
        [new Error('The extensions gallery cannot be scripted.'), ''],
        [
          new Error('Cannot access contents of the page.'),
          'https://chromewebstore.google.com/detail/abc',
        ],
        [new Error('Cannot access contents of the page.'), 'about:blank'],
      ]) {
        const classified = helpers.classifyContentScriptFailure(failure, url);
        assert.equal(
          classified.reason,
          'unsupported_page',
          `expected an unsupported page for: ${failure.message} @ ${url || '(unknown)'}`
        );
        assert.match(classified.message, /this page/i);
      }
    },
  },
  {
    name: 'does not read a refused scheme it has never heard of as missing access',
    fn() {
      // Chrome gives one generic sentence for nearly every page it refuses, so the scheme
      // it names is what separates them. Enumerating the refused schemes would mis-sort
      // every one left off the list; only the grantable shape — an ordinary web page — is
      // enumerable, and these are not it. An SSL interstitial is the everyday case.
      for (const refused of [
        'chrome-error://chromewebdata/',
        'data:text/html,hello',
        'blob:https://example.com/9a1f',
        'devtools://devtools/bundled/devtools_app.html',
      ]) {
        const classified = helpers.classifyContentScriptFailure(
          new Error(
            `Cannot access contents of url "${refused}". Extension manifest must request permission to access this host.`
          ),
          ''
        );
        assert.equal(
          classified.reason,
          'unsupported_page',
          `expected an unsupported page for ${refused}`
        );
      }
    },
  },
  {
    name: 'sends a reader blocked on a local file to the switch that unblocks it',
    fn() {
      // Neither of the two reasons fits: file access is grantable, but not by invoking the
      // extension on the page, so both other messages would send the reader nowhere.
      const classified = helpers.classifyContentScriptFailure(
        new Error(
          'Cannot access contents of the page. Extension manifest must request permission to access this host.'
        ),
        'file:///Users/reader/article.html'
      );
      assert.equal(classified.reason, 'file_access');
      assert.match(classified.message, /Allow access to file URLs/i);
    },
  },
  {
    name: 'never blames the page when access is the actual problem',
    fn() {
      // The message this replaces blamed chrome:// pages for every failure, which is what
      // sent the diagnosis behind the parent spec down the wrong path for two symptoms.
      const missingAccess = helpers.classifyContentScriptFailure(
        new Error(
          'Cannot access contents of url "https://example.com/". Extension manifest must request permission to access this host.'
        ),
        'https://example.com/'
      );
      const unsupported = helpers.classifyContentScriptFailure(
        new Error('Cannot access a chrome:// URL'),
        'chrome://settings/'
      );
      assert.equal(missingAccess.reason, 'missing_access');
      assert.equal(unsupported.reason, 'unsupported_page');
      assert.notEqual(missingAccess.message, unsupported.message);
    },
  },
  {
    name: 'reports a failure it cannot classify as itself',
    fn() {
      // Guessing between the two known reasons is how the old message misled. An
      // unrecognised failure says what happened instead of picking one.
      const classified = helpers.classifyContentScriptFailure(
        new Error('Frame with ID 0 is showing error page'),
        'https://example.com/'
      );
      assert.equal(classified.reason, 'unknown');
      assert.match(classified.message, /Frame with ID 0 is showing error page/);

      // The address can be a navigation behind the failure, so it is only ever read once
      // Chrome has said it refused the page. On its own it settles nothing.
      const stale = helpers.classifyContentScriptFailure(
        new Error('The tab was closed.'),
        'about:blank'
      );
      assert.equal(stale.reason, 'unknown');

      const empty = helpers.classifyContentScriptFailure(null, '');
      assert.equal(empty.reason, 'unknown');
      assert.ok(empty.message.length > 0);
      assert.doesNotMatch(empty.message, /\[object Object\]/);
    },
  },
];
