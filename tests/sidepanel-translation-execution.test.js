const assert = require('node:assert/strict');
const execution = require('../extension/sidepanel-translation-execution.js');
const markdownRehydration = require('../extension/markdown-rehydration.js');
const translationChunks = require('../extension/translation-chunks.js');

const FULL_PAGE_SETTINGS = Object.freeze({
  model: 'gpt-5.4-mini', reasoningEffort: 'none',
  targetLanguage: 'Korean', tone: 'technical', chunkMaxChars: 200,
});

function createCompletedResponse(text) { return text; }
function createIncompleteResponse() { return { incomplete: true }; }
function createApiErrorResponse(apiError) { return { apiError }; }

function createExtraction(documentModel) {
  return {
    title: 'Fixture', url: 'https://example.test/article', langHint: 'en',
    contentMarkdown: documentModel.blocks.map((block) => block.originalMarkdown || block.template).join('\n\n'),
    translationDocument: documentModel,
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
  const [chunk] = translationChunks.createTranslationChunks(documentModel, 200);
  return { chunk, link, code };
}

// The fixture starts with a document; requests and results cross the shipped execution interface.
async function runFullPageChunk(chunk, responses, settings = FULL_PAGE_SETTINGS) {
  const queue = [...responses];
  const requestBodies = [];
  const progress = [];
  const extraction = createExtraction({
    namespace: chunk.contract.namespace,
    entries: chunk.contract.entries,
    blocks: chunk.blocks,
  });
  try {
    const translated = await execution.execute(extraction, settings, async (request) => {
      requestBodies.push(request);
      if (!queue.length) throw new Error(`Unexpected request #${requestBodies.length}`);
      const answer = queue.shift();
      if (answer?.apiError) throw new Error(answer.apiError);
      if (answer?.incomplete) {
        const error = new Error('Translation output reached its token limit.');
        error.code = 'response.incomplete.max_output_tokens';
        throw error;
      }
      return answer;
    }, (event) => progress.push(event));
    return { requestBodies, translated, error: null, progress };
  } catch (error) {
    return { requestBodies, translated: null, error, progress };
  }
}

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

exports.name = 'Side Panel Translation execution';
exports.tests = [
  {
    name: 'recovers one incomplete full-page chunk with ordered protected children',
    async fn() {
      const { chunk, link, code } = createProtectedFullPageChunk();
      const { requestBodies, translated, error, progress } = await runFullPageChunk(chunk, [
        createIncompleteResponse(),
        createCompletedResponse(
          `읽기 ${link.openToken}안내${link.closeToken}.`
        ),
        createCompletedResponse(`지금 ${code.token} 실행.`),
      ]);

      assert.equal(error, null);
      assert.equal(requestBodies.length, 3);
      assert.deepEqual(progress, [{ progress: null }, { progress: { current: 1, total: 1 } }]);
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
    name: 'rejects the whole document when a recovery child is incomplete',
    async fn() {
      const { chunk, link } = createProtectedFullPageChunk();
      const { requestBodies, translated, error } = await runFullPageChunk(chunk, [
        createIncompleteResponse(),
        createCompletedResponse(`읽기 ${link.openToken}안내${link.closeToken}.`),
        createIncompleteResponse(),
      ]);
      assert.equal(error?.code, 'response.incomplete.max_output_tokens');
      assert.equal(translated, null);
      assert.equal(requestBodies.length, 3);
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
      const originalValidate = markdownRehydration.validateAndRehydrateChunk;
      markdownRehydration.validateAndRehydrateChunk = () => {
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
        markdownRehydration.validateAndRehydrateChunk = originalValidate;
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
    name: 'validates extraction before any request or progress notification',
    async fn() {
      const valid = createExtraction({ namespace: 'PLAIN', entries: [], blocks: [{ id: 'p1', template: 'text', entries: [] }] });
      const malformed = [null, [], {}, { ...valid, title: null }, { ...valid, url: 1 },
        { ...valid, langHint: null }, { ...valid, contentMarkdown: [] },
        { ...valid, translationDocument: null }, { ...valid, translationDocument: { blocks: null } }];
      for (const extraction of malformed) {
        let requests = 0;
        const events = [];
        await assert.rejects(() => execution.execute(extraction, FULL_PAGE_SETTINGS,
          async () => { requests += 1; return '번역'; }, (event) => events.push(event)),
        /Article extraction/);
        assert.equal(requests, 0);
        assert.deepEqual(events, []);
      }
    },
  },
  {
    name: 'enforces the total character budget through document execution',
    async fn() {
      const documentModel = { namespace: 'PLAIN', entries: [], blocks: [{ id: 'p1', template: 'text', entries: [] }] };
      const extraction = createExtraction(documentModel);
      let requests = 0;
      const request = async () => { requests += 1; return '번역'; };
      await assert.rejects(() => execution.execute({ ...extraction, contentMarkdown: 'x'.repeat(60001) },
        FULL_PAGE_SETTINGS, request), /Full-page translation has too much text/);
      assert.equal(requests, 0);
      assert.equal(await execution.execute({ ...extraction, contentMarkdown: 'x'.repeat(60000) },
        FULL_PAGE_SETTINGS, request), '번역');
      assert.equal(requests, 1);
    },
  },
  {
    name: 'does not signal preparation when protected content cannot be split safely',
    async fn() {
      const { chunk } = createProtectedFullPageChunk();
      const result = await runFullPageChunk(chunk, [], { ...FULL_PAGE_SETTINGS, chunkMaxChars: 10 });
      assert.equal(result.error?.code, 'markdown.segment_too_large');
      assert.deepEqual(result.requestBodies, []);
      assert.deepEqual(result.progress, []);
    },
  },
  {
    name: 'reports original chunk progress and publishes only the complete document',
    async fn() {
      const blocks = ['First paragraph.', 'Second paragraph.', 'Third paragraph.'].map((template, index) =>
        ({ id: `p${index}`, template, entries: [] }));
      const extraction = createExtraction({ namespace: 'PLAIN', entries: [], blocks });
      const events = [];
      const inputs = [];
      const translated = await execution.execute(extraction, { ...FULL_PAGE_SETTINGS, chunkMaxChars: 20 },
        async (request) => { inputs.push(request.input); return ` ${inputs.length}번 번역 `; },
        (event) => events.push(event));
      assert.equal(translated, '1번 번역\n\n2번 번역\n\n3번 번역');
      assert.deepEqual(inputs, blocks.map((block) => block.template));
      assert.deepEqual(events, [{ progress: null },
        { progress: { current: 1, total: 3 } }, { progress: { current: 2, total: 3 } },
        { progress: { current: 3, total: 3 } }]);
      assert.equal(events.some((event) => 'translated' in event), false);
    },
  },
  {
    name: 'rejects a later chunk without returning the earlier paid answers',
    async fn() {
      const blocks = ['First paragraph.', 'Second paragraph.', 'Third paragraph.'].map((template, index) =>
        ({ id: `p${index}`, template, entries: [] }));
      const events = [];
      let requests = 0;
      let result = null;
      const failure = new Error('Third request failed');
      await assert.rejects(async () => {
        result = await execution.execute(createExtraction({ namespace: 'PLAIN', entries: [], blocks }),
          { ...FULL_PAGE_SETTINGS, chunkMaxChars: 20 }, async () => {
            requests += 1;
            if (requests === 3) throw failure;
            return `번역 ${requests}`;
          }, (event) => events.push(event));
      }, (error) => error === failure);
      assert.equal(result, null);
      assert.equal(requests, 3);
      assert.equal(events.some((event) => JSON.stringify(event).includes('번역')), false);
    },
  },
  {
    name: 'waits for the current chunk before requesting the next',
    async fn() {
      const blocks = ['First paragraph.', 'Second paragraph.'].map((template, index) =>
        ({ id: `p${index}`, template, entries: [] }));
      let releaseFirst;
      const firstAnswer = new Promise((resolve) => { releaseFirst = resolve; });
      const inputs = [];
      const result = execution.execute(createExtraction({ namespace: 'PLAIN', entries: [], blocks }),
        { ...FULL_PAGE_SETTINGS, chunkMaxChars: 20 }, async (request) => {
          inputs.push(request.input);
          return inputs.length === 1 ? firstAnswer : '둘째';
        });
      assert.deepEqual(inputs, [blocks[0].template]);
      releaseFirst('첫째');
      assert.equal(await result, '첫째\n\n둘째');
      assert.deepEqual(inputs, blocks.map((block) => block.template));
    },
  },
  {
    name: 'scales output tokens to the chunk size above the default',
    async fn() {
      const extraction = createExtraction({ namespace: 'PLAIN', entries: [],
        blocks: [{ id: 'p1', template: 'x'.repeat(11000), entries: [] }] });
      let request;
      assert.equal(await execution.execute(extraction, { ...FULL_PAGE_SETTINGS, chunkMaxChars: 12000 },
        async (value) => { request = value; return '번역'; }), '번역');
      assert.equal(request.maxOutputTokens, 11000);
    },
  },
  {
    name: 'passes translation settings and output sizing to the request adapter without credentials',
    async fn() {
      const { chunk, link, code } = createProtectedFullPageChunk();
      const result = await runFullPageChunk(chunk, [createCompletedResponse(
        `${link.openToken}안내${link.closeToken} ${code.token}`)]);
      assert.equal(result.error, null);
      const request = result.requestBodies[0];
      assert.equal(request.model, FULL_PAGE_SETTINGS.model);
      assert.equal(request.reasoningEffort, 'none');
      assert.equal(request.maxOutputTokens, 8192);
      assert.equal('apiKey' in request, false);
      assert.equal('textFormat' in request, false);
      assert.match(request.instructions, /Korean/);
    },
  },
];

exports.createProtectedFullPageChunk = createProtectedFullPageChunk;
