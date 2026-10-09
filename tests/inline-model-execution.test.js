const assert = require('node:assert/strict');
const { execute } = require('../extension/inline-model-execution.js');
const codec = require('../extension/inline-block.js');
const { createReasoningFixture, createTestDocument, LINGUISTIC_SLASH_PROSE } = require('./inline-block.test');

const SETTINGS = { model: 'gpt-5.4-mini', reasoningEffort: 'none', targetLanguage: 'Korean', tone: 'technical' };
function plainRecord(id = 'b1', template = 'This is source prose.') {
  return {
    id, template, atoms: [], repair: null,
    contract: { codecVersion: 1, namespace: 'CAT_PLAIN', entries: [], maxOutputChars: 48000, requiresText: true, literalTokens: [] },
  };
}
function response(translations) { return JSON.stringify({ translations }); }
function reasoningRecord(id = 'reasoning') {
  const { serialized } = createReasoningFixture();
  return { id, template: serialized.template, atoms: serialized.atoms, contract: serialized.contract, repair: null };
}
function translatedReasoning(record) {
  return record.template.replace('Reasoning models', '추론 모델').replace(' like ', '와 같은 ').replace(' use internal reasoning tokens.', '은 내부 추론 토큰을 사용합니다.');
}

exports.name = 'inline model execution';
exports.tests = [
  {
    name: 'preserves Korean text, JSON escaping and record field order in the actual request',
    async fn() {
      const records = [plainRecord('한글', '한국어 "인용" \\ 경로\n다음\t줄'), plainRecord('second')];
      let calls = 0;
      const results = await execute(records, { ...SETTINGS, targetLanguage: 'English' }, async ({ input }) => {
        calls += 1;
        const expected = String.raw`{"records":[{"id":"한글","template":"한국어 \"인용\" \\ 경로\n다음\t줄","atoms":[],"repair":null},{"id":"second","template":"This is source prose.","atoms":[],"repair":null}]}`;
        assert.equal(input, expected);
        assert.equal(input.length, expected.length);
        return response(records.map(({ id }) => ({ id, template: 'Translated prose.' })));
      });
      assert.equal(calls, 1);
      assert.deepEqual(results.map(({ id, disposition }) => ({ id, disposition })), [
        { id: '한글', disposition: 'apply' }, { id: 'second', disposition: 'apply' },
      ]);
    },
  },
  {
    name: 'repairs only failed Semantic Blocks and preserves input order and first successes',
    async fn() {
      const records = [plainRecord('first'), plainRecord('second'), plainRecord('third')];
      const requests = [];
      const results = await execute(records, SETTINGS, async (request) => {
        requests.push(request);
        if (requests.length === 1) return response([
          { id: 'third', template: '세 번째 번역입니다.' },
          { id: 'second', template: 'This is source prose.' },
          { id: 'first', template: '첫 번째 번역입니다.' },
        ]);
        assert.deepEqual(JSON.parse(request.input).records.map((record) => record.id), ['second']);
        return response([{ id: 'second', template: '두 번째 번역입니다.' }]);
      });
      assert.equal(requests.length, 2);
      assert.deepEqual(results.map(({ id, template, disposition, attemptCount }) => ({ id, template, disposition, attemptCount })), [
        { id: 'first', template: '첫 번째 번역입니다.', disposition: 'apply', attemptCount: 1 },
        { id: 'second', template: '두 번째 번역입니다.', disposition: 'apply', attemptCount: 2 },
        { id: 'third', template: '세 번째 번역입니다.', disposition: 'apply', attemptCount: 1 },
      ]);
      assert.deepEqual(results[1].diagnostic.timeline, [
        { stage: 'initial_validation', disposition: 'retry', codes: ['quality.target_language_missing'] },
        { stage: 'repair_validation', disposition: 'apply', codes: [] },
      ]);
    },
  },
  {
    name: 'sends only model fields and preserves instructions, format, limits and settings for both attempts',
    async fn() {
      const record = reasoningRecord();
      const requests = [];
      const settings = { ...SETTINGS, model: 'configured-model', reasoningEffort: 'low', tone: 'formal', apiKey: 'must-not-leave-adapter' };
      const [result] = await execute([record], settings, async (request) => {
        requests.push(request);
        return response([{ id: record.id, template: requests.length === 1 ? record.template : translatedReasoning(record) }]);
      });
      assert.equal(result.disposition, 'apply');
      assert.equal(result.attemptCount, 2);
      assert.equal(requests.length, 2);
      for (const request of requests) {
        assert.deepEqual(Object.keys(request).sort(), ['input', 'instructions', 'maxOutputTokens', 'model', 'reasoningEffort', 'textFormat']);
        assert.equal(request.model, 'configured-model');
        assert.equal(request.reasoningEffort, 'low');
        assert.match(request.instructions, /complete semantic block/i);
        assert.match(request.instructions, /token.*byte-for-byte/i);
        assert.match(request.instructions, /formal and polite/);
        assert.match(request.instructions, /For Korean/);
        assert.match(request.instructions, /Do not output HTML/i);
        assert.match(request.instructions, /repair.*previousErrorCode/i);
        assert.equal(request.maxOutputTokens, 4096);
        const format = request.textFormat;
        assert.equal(format.type, 'json_schema');
        assert.equal(format.name, 'inline_block_translations');
        assert.equal(format.strict, true);
        assert.equal(format.schema.additionalProperties, false);
        assert.equal(format.schema.properties.translations.minItems, 1);
        assert.equal(format.schema.properties.translations.maxItems, 1);
        assert.equal(format.schema.properties.translations.items.additionalProperties, false);
        assert.deepEqual(format.schema.properties.translations.items.required, ['id', 'template']);
        assert.deepEqual(Object.keys(JSON.parse(request.input).records[0]).sort(), ['atoms', 'id', 'repair', 'template']);
        assert.deepEqual(JSON.parse(request.input).records[0].atoms, record.atoms);
        assert.equal(JSON.stringify(request).includes('must-not-leave-adapter'), false);
      }
      assert.equal(JSON.parse(requests[0].input).records[0].repair, null);
      assert.deepEqual(JSON.parse(requests[1].input).records[0].repair, { attempt: 1, previousErrorCode: 'quality.target_language_missing' });
      assert.equal(requests[0].instructions, requests[1].instructions);
      assert.equal(JSON.stringify(result).includes('must-not-leave-adapter'), false);

      for (const [length, expected] of [[11994, 15000]]) {
        const source = plainRecord('large', 'x'.repeat(length));
        await execute([source], { ...SETTINGS, targetLanguage: 'English', tone: 'unknown' }, async (request) => {
          assert.equal(request.maxOutputTokens, expected);
          assert.match(request.instructions, /clear, technical tone/);
          assert.doesNotMatch(request.instructions, /For Korean/);
          return response([{ id: 'large', template: 'Translated.' }]);
        });
      }
      const many = Array.from({ length: 500 }, (_, index) => plainRecord(`b${index}`, 'This is the input.'));
      let calls = 0;
      const results = await execute(many, SETTINGS, async (request) => {
        calls += 1;
        assert.equal(request.maxOutputTokens, calls === 1 ? 15000 : 16000);
        assert.equal(request.textFormat.schema.properties.translations.minItems, 500);
        assert.equal(request.textFormat.schema.properties.translations.maxItems, 500);
        return response(many.map((record) => ({ id: record.id, template: calls === 1 ? record.template : '한국어 번역입니다.' })));
      });
      assert.equal(calls, 2);
      assert.ok(results.every((result) => result.attemptCount === 2));
    },
  },
  {
    name: 'distinguishes initial protocol failures and sends no retry',
    async fn() {
      const cases = [
        ['{', 'protocol.invalid_json'],
        [JSON.stringify({ records: [] }), 'protocol.missing_translations'],
        [response([]), 'protocol.missing_id'],
        [response([{ id: 'b1', template: '번역문.' }]), 'protocol.missing_id'],
        [response([{ id: 'unexpected', template: '번역문.' }]), 'protocol.unexpected_id'],
        [response([{ id: 'b1', template: '하나.' }, { id: 'b1', template: '둘.' }]), 'protocol.duplicate_id'],
        [response([{ id: 'b1' }]), 'protocol.missing_template'],
      ];
      for (const [output, code] of cases) {
        let calls = 0;
        await assert.rejects(execute([plainRecord('b1'), plainRecord('b2')], SETTINGS, async () => { calls += 1; return output; }), (error) => error.code === code);
        assert.equal(calls, 1, code);
      }
      const failure = Object.assign(new Error('Model request did not complete'), { code: 'openai.incomplete' });
      let calls = 0;
      await assert.rejects(execute([plainRecord()], SETTINGS, async () => { calls += 1; throw failure; }), (error) => error === failure);
      assert.equal(calls, 1);
    },
  },
  {
    name: 'preserves first successes and initial evidence when a batched repair fails or has invalid protocol',
    async fn() {
      for (const failure of [new Error('transport failed'), '{', response([])]) {
        const records = [plainRecord('success'), plainRecord('repair-a'), plainRecord('repair-b')];
        const requests = [];
        const results = await execute(records, SETTINGS, async (request) => {
          requests.push(request);
          if (requests.length === 1) return response([
            { id: 'success', template: '성공한 번역입니다.' },
            { id: 'repair-a', template: records[1].template },
            { id: 'repair-b', template: records[2].template },
          ]);
          assert.deepEqual(JSON.parse(request.input).records.map(({ id }) => id), ['repair-a', 'repair-b']);
          if (failure instanceof Error) throw failure;
          return failure;
        });
        assert.equal(requests.length, 2);
        assert.equal(results[0].template, '성공한 번역입니다.');
        assert.equal(results[0].disposition, 'apply');
        assert.equal(results[0].attemptCount, 1);
        const code = failure instanceof Error ? 'runtime.repair_request_failed' : failure === '{' ? 'protocol.invalid_json' : 'protocol.missing_id';
        for (const result of results.slice(1)) {
          assert.equal(result.disposition, 'reject');
          assert.equal(result.terminalCode, code);
          assert.equal(result.messageKey, 'repair_request_failed');
          assert.equal('template' in result, false);
          assert.equal(result.attemptCount, 2);
          assert.deepEqual(result.diagnostic.quality.codes, ['quality.target_language_missing']);
          assert.deepEqual(result.diagnostic.timeline, [
            { stage: 'initial_validation', disposition: 'retry', codes: ['quality.target_language_missing'] },
            { stage: 'repair_validation', disposition: 'reject', codes: [code] },
          ]);
        }
      }
    },
  },
  {
    name: 'repairs structure once, then rejects unsafe output without a template or third request',
    async fn() {
      const record = reasoningRecord();
      const token = record.contract.entries.find((entry) => entry.kind === 'atom').token;
      const broken = translatedReasoning(record).split(token).join('');
      let calls = 0;
      const [result] = await execute([record], SETTINGS, async (request) => {
        calls += 1;
        if (calls === 2) assert.deepEqual(JSON.parse(request.input).records[0].repair, { attempt: 1, previousErrorCode: 'structure.token_missing' });
        return response([{ id: record.id, template: broken }]);
      });
      assert.equal(calls, 2);
      assert.equal(result.attemptCount, 2);
      assert.equal(result.disposition, 'reject');
      assert.equal(result.messageKey, 'unsafe_translation_rejected');
      assert.equal(result.terminalCode, 'structure.token_missing');
      assert.equal('template' in result, false);
      assert.equal(result.diagnostic.structure.status, 'unsafe');
      assert.equal(result.diagnostic.quality.status, 'uncertain');
      assert.deepEqual(result.diagnostic.timeline, [
        { stage: 'initial_validation', disposition: 'retry', codes: ['structure.token_missing'] },
        { stage: 'repair_validation', disposition: 'reject', codes: ['structure.token_missing'] },
      ]);
    },
  },
  {
    name: 'applies a safe structural repair and retains an allowed emphasis drop',
    async fn() {
      const record = reasoningRecord();
      const strong = record.contract.entries.find((entry) => entry.tagName === 'STRONG');
      const dropped = translatedReasoning(record).split(strong.openToken).join('').split(strong.closeToken).join('');
      let calls = 0;
      const [repaired] = await execute([record], SETTINGS, async () => {
        calls += 1;
        return response([{ id: record.id, template: calls === 1 ? dropped.split(strong.closeToken).join('') + strong.closeToken : dropped }]);
      });
      assert.equal(calls, 2);
      assert.equal(repaired.disposition, 'apply');
      assert.equal(repaired.attemptCount, 2);
      assert.deepEqual(repaired.diagnostic.structure, { status: 'safe', codes: ['structure.emphasis_dropped'] });
      calls = 0;
      const [first] = await execute([record], SETTINGS, async () => { calls += 1; return response([{ id: record.id, template: dropped }]); });
      assert.equal(calls, 1);
      assert.equal(first.disposition, 'apply');
      assert.equal(first.attemptCount, 1);
      assert.equal(first.terminalCode, null);
      assert.equal(first.messageKey, 'translation_complete');
      assert.deepEqual(first.diagnostic.structure, { status: 'safe', codes: ['structure.emphasis_dropped'] });
    },
  },
  {
    name: 'rejects wrong target language after one repair and preserves numeric evidence',
    async fn() {
      for (const output of ['Ceci est une phrase traduite.', 'Completely different English prose.']) {
        let calls = 0;
        const [result] = await execute([plainRecord()], SETTINGS, async () => { calls += 1; return response([{ id: 'b1', template: output }]); });
        assert.equal(calls, 2);
        assert.equal(result.disposition, 'reject');
        assert.equal(result.attemptCount, 2);
        assert.equal(result.terminalCode, 'quality.target_language_missing');
        assert.equal(result.messageKey, 'wrong_target_language_rejected');
        assert.equal('template' in result, false);
        assert.equal(result.diagnostic.quality.evidence.outputHangulCount, 0);
        assert.ok(Object.values(result.diagnostic.quality.evidence).every((value) => typeof value === 'number'));
      }
    },
  },
  {
    name: 'applies Partial Translation after the single quality repair for prose residue and empty prose',
    async fn() {
      for (const [source, output, targetLanguage, code] of [
        ['This is source prose.', 'This is source prose. 번역.', 'Korean', 'quality.english_residue'],
        ['⟦Read the safety instructions carefully⟧', '⟦Read the safety instructions carefully⟧', 'Japanese', 'quality.english_residue'],
        ['This is source prose.', '   ', 'Japanese', 'quality.empty_prose'],
      ]) {
        const record = plainRecord('b1', source);
        if (code === 'quality.empty_prose') record.contract.requiresText = false;
        let calls = 0;
        const [result] = await execute([record], { ...SETTINGS, targetLanguage }, async () => { calls += 1; return response([{ id: 'b1', template: output }]); });
        assert.equal(calls, 2);
        assert.equal(result.disposition, 'apply_with_warning');
        assert.equal(result.attemptCount, 2);
        assert.equal(result.template, output);
        assert.equal(result.terminalCode, code);
        assert.equal(result.messageKey, 'partial_translation_applied');
        assert.equal(result.diagnostic.structure.status, 'safe');
        assert.equal(result.diagnostic.quality.status, 'partial');
        assert.equal(JSON.stringify(result.diagnostic.quality).includes(source), false);
      }
    },
  },
  {
    name: 'accepts protected technical names, tokens and Source Syntax without repair',
    async fn() {
      const { document, element, text } = createTestDocument();
      const link = element('a', text('mattpocock/skills'));
      link.setAttribute('href', 'https://github.com/mattpocock/skills');
      const block = element('dd', link);
      document.body.appendChild(block);
      const serialized = codec.serializeBlock(block);
      assert.equal(serialized.ok, true);
      const repository = { id: 'repository', template: serialized.template, atoms: serialized.atoms, contract: serialized.contract, repair: null };
      const tokenized = reasoningRecord('tokenized');
      const cases = [
        [plainRecord('technical', 'GPT API'), 'GPT API'],
        [plainRecord('docs', 'Claude Code reads CLAUDE.md, not AGENTS.md.'), 'Claude Code는 CLAUDE.md를 읽으며 AGENTS.md는 읽지 않습니다.'],
        [repository, repository.template],
        [tokenized, translatedReasoning(tokenized)],
      ];
      for (const [record, template] of cases) {
        let calls = 0;
        const [result] = await execute([record], SETTINGS, async () => { calls += 1; return response([{ id: record.id, template }]); });
        assert.equal(calls, 1, record.id);
        assert.equal(result.disposition, 'apply', record.id);
        assert.equal(result.diagnostic.quality.status, 'complete');
      }
      const changed = repository.template.replace('mattpocock/skills', 'other/project');
      let calls = 0;
      const [result] = await execute([repository], SETTINGS, async () => { calls += 1; return response([{ id: repository.id, template: changed }]); });
      assert.equal(calls, 2);
      assert.equal(result.disposition, 'reject');
      assert.equal(result.terminalCode, 'structure.source_syntax_changed');
      assert.equal('template' in result, false);
    },
  },
  {
    name: 'treats linguistic slash compounds as prose requiring a target-language repair',
    async fn() {
      for (const source of LINGUISTIC_SLASH_PROSE) {
        let calls = 0;
        const [result] = await execute([plainRecord('b1', source)], SETTINGS, async () => { calls += 1; return response([{ id: 'b1', template: source }]); });
        assert.equal(calls, 2, source);
        assert.equal(result.disposition, 'reject', source);
        assert.equal(result.terminalCode, 'quality.target_language_missing', source);
      }
    },
  },
];
