const assert = require('node:assert/strict');
const { PROFILES, adaptQualityRequest, buildQualityPlan, validateQualityOutput, validateQualityRequest } =
  require('./integration/model-quality.mjs');
const codec = require('../extension/inline-block.js');
const { execute } = require('../extension/inline-model-execution.js');
const { createReasoningFixture } = require('./inline-block.test.js');

const PROFILE_KEYS = [
  'deepseek', 'gpt-6-luna', 'solar-pro4', 'mimo-v2.6-flash', 'claude-haiku-5.5', 'minimax-m3.1-flash',
];

function plainRecord(id = 'block-1', template = 'Translate this source block.') {
  return {
    id,
    template,
    atoms: [],
    repair: null,
    contract: {
      codecVersion: 1,
      namespace: 'CAT_QUALITY',
      entries: [],
      maxOutputChars: 48000,
      requiresText: true,
      literalTokens: [],
    },
  };
}

function originalBody(records = [plainRecord()]) {
  const count = records.length;
  return {
    model: 'deepseek/deepseek-v4.1-flash-1017',
    reasoning: { effort: 'none' },
    provider: { require_parameters: true, data_collection: 'deny', zdr: true },
    store: false,
    instructions: 'Translate each input record into Korean.',
    input: codec.serializeModelRequest(records),
    max_output_tokens: 4096,
    text: { format: {
      type: 'json_schema',
      name: 'inline_block_translations',
      strict: true,
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          translations: {
            type: 'array', minItems: count, maxItems: count,
            items: {
              type: 'object', additionalProperties: false,
              properties: { id: { type: 'string' }, template: { type: 'string' } },
              required: ['id', 'template'],
            },
          },
        },
        required: ['translations'],
      },
    } },
  };
}

function sidePanelBody(input = '# Setup\n\nTranslate these Markdown paragraphs.') {
  return {
    model: 'deepseek/deepseek-v4.1-flash-1017',
    reasoning: { effort: 'none' },
    provider: { require_parameters: true, data_collection: 'deny', zdr: true },
    store: false,
    instructions: 'Translate the page Markdown into Korean.',
    input,
    max_output_tokens: 8192,
  };
}

function response(translations) {
  return JSON.stringify({ translations });
}

exports.name = 'model quality';
exports.tests = [{
  name: 'freezes six model profiles with the approved caps and tentative MiMo metadata',
  fn() {
    assert.deepEqual(PROFILES.map((profile) => profile.key), PROFILE_KEYS);
    assert.equal(Object.isFrozen(PROFILES), true);
    assert.equal(PROFILES.every((profile) => Object.isFrozen(profile) &&
      Object.isFrozen(profile.reasoning) && Object.isFrozen(profile.priceCap)), true);
    assert.deepEqual(PROFILES.map(({ model, reasoning, priceCap, contextWindow, maxOutputTokens }) =>
      [model, reasoning, priceCap, contextWindow, maxOutputTokens]), [
      ['deepseek/deepseek-v4.1-flash-1017', { effort: 'none' }, { prompt: 0.30, completion: 1.20, request: 0 }, 1_048_576, 131_072],
      ['openai/gpt-6-luna', { effort: 'none' }, { prompt: 0.11, completion: 0.55, request: 0 }, 1_050_000, 128_000],
      ['upstage/solar-pro4', { effort: 'none' }, { prompt: 0.15, completion: 0.60, request: 0 }, 524_288, 131_072],
      ['xiaomi/mimo-v2.6-flash', { enabled: false }, { prompt: 0.14, completion: 0.28, request: 0 }, 1_050_000, 131_072],
      ['anthropic/claude-haiku-5.5', { effort: 'none' }, { prompt: 0.11, completion: 0.55, request: 0 }, 1_000_000, 128_000],
      ['minimax/minimax-m3.1-flash', { effort: 'low' }, { prompt: 0.30, completion: 1.20, request: 0 }, 1_048_576, 524_288],
    ]);
    assert.equal(PROFILES.find((profile) => profile.key === 'deepseek').conservative, true);
    assert.equal(PROFILES.find((profile) => profile.key === 'mimo-v2.6-flash').compatibilityPending, true);
  },
}, {
  name: 'builds one unique run for every page, translation flow, and profile',
  fn() {
    const pages = Array.from({ length: 12 }, (_, index) => `page-${index + 1}`);
    const plan = buildQualityPlan(pages);
    assert.equal(plan.length, 144);
    assert.equal(new Set(plan.map((run) => run.id)).size, 144);
    assert.deepEqual([...new Set(plan.map((run) => run.flow))], ['inline', 'sidepanel']);
    assert.deepEqual([...new Set(plan.map((run) => run.profileKey))], PROFILE_KEYS);
    assert.deepEqual(plan.slice(0, 6).map((run) => run.flow), Array(6).fill('inline'));
    assert.throws(() => buildQualityPlan([]));
    assert.throws(() => buildQualityPlan(['same', 'same']));

    const requestedIds = ['page-1|sidepanel|deepseek', 'page-1|inline|deepseek'];
    const continuation = buildQualityPlan(['page-1'], ['deepseek'], requestedIds);
    assert.deepEqual(continuation.map(run => run.id), requestedIds);
    assert.deepEqual(continuation.map(run => run.flow), ['sidepanel', 'inline']);
    for (const invalidIds of [[], [requestedIds[0], requestedIds[0]], ['missing|inline|deepseek'], [12]]) {
      assert.throws(() => buildQualityPlan(['page-1'], ['deepseek'], invalidIds));
    }
  },
}, {
  name: 'adapts initial and repair requests for every profile without mutating their inputs',
  fn() {
    const initial = plainRecord();
    const repair = { ...plainRecord(), repair: { attempt: 1, previousErrorCode: 'quality.english_residue' } };
    const inputs = [originalBody([initial]), originalBody([repair])];
    const cloneAdapter = new Function(`return (${adaptQualityRequest.toString()})`)();
    for (const profile of PROFILES) {
      for (const body of inputs) {
        const before = structuredClone(body);
        const adapted = cloneAdapter(body, profile);
        assert.deepEqual(body, before);
        assert.equal(adapted.model, profile.model);
        assert.deepEqual(adapted.reasoning, profile.reasoning);
        assert.deepEqual(adapted.provider, {
          require_parameters: true,
          data_collection: 'deny',
          zdr: true,
          max_price: profile.priceCap,
        });
        assert.equal(adapted.store, false);
        assert.equal(adapted.input, body.input);
        assert.equal(adapted.instructions, body.instructions);
        assert.equal(adapted.max_output_tokens, body.max_output_tokens);
        const expectedSchema = structuredClone(body.text.format.schema);
        delete expectedSchema.properties.translations.minItems;
        delete expectedSchema.properties.translations.maxItems;
        assert.deepEqual(adapted.text.format.schema, expectedSchema);
        assert.equal('minItems' in adapted.text.format.schema.properties.translations, false);
        assert.equal('maxItems' in adapted.text.format.schema.properties.translations, false);
        assert.equal(validateQualityRequest(adapted, profile.key), true);
      }
    }
  },
}, {
  name: 'adapts and validates plain-text Side Panel requests without inventing JSON schema fields',
  fn() {
    const repairInstructions = 'Translate the same Markdown again, preserving every placeholder.';
    const inputs = [
      sidePanelBody(),
      { ...sidePanelBody(), instructions: repairInstructions },
    ];
    for (const profile of PROFILES) {
      const adapted = inputs.map((body) => adaptQualityRequest(body, profile));
      for (let index = 0; index < inputs.length; index += 1) {
        assert.equal(Object.hasOwn(adapted[index], 'text'), false);
        assert.equal(adapted[index].input, inputs[index].input);
        assert.equal(adapted[index].instructions, inputs[index].instructions);
        assert.equal(adapted[index].model, profile.model);
        assert.deepEqual(adapted[index].reasoning, profile.reasoning);
        assert.deepEqual(adapted[index].provider.max_price, profile.priceCap);
        assert.equal(validateQualityRequest(adapted[index], profile.key), true);
      }
      assert.deepEqual(Object.keys(adapted[0]).sort(), Object.keys(adapted[1]).sort());
    }
    const selected = PROFILES[1];
    const adapted = adaptQualityRequest(sidePanelBody('ordinary Markdown, not JSON'), selected);
    assert.throws(() => validateQualityRequest(adapted, PROFILES[0].key), /selected model profile/);
    assert.throws(() => adaptQualityRequest({ ...sidePanelBody(), tools: [] }, selected));
    assert.throws(() => validateQualityRequest({ ...adapted, fallback_models: ['other'] }, selected.key));
    assert.throws(() => validateQualityRequest({ ...adapted, max_output_tokens: selected.maxOutputTokens + 1 }, selected.key));
  },
}, {
  name: 'validates the selected model, reasoning, privacy cap, schema, and request limits exactly',
  fn() {
    const profile = PROFILES.find((candidate) => candidate.key === 'gpt-6-luna');
    const valid = adaptQualityRequest(originalBody(), profile);
    assert.equal(validateQualityRequest(valid, profile), true);
    const invalid = [
      (body) => { body.model = 'different/model'; },
      (body) => { body.reasoning = { effort: 'low' }; },
      (body) => { body.reasoning.extra = true; },
      (body) => { body.provider.zdr = false; },
      (body) => { body.provider.max_price.prompt = 0.12; },
      (body) => { body.provider.sort = 'throughput'; },
      (body) => { body.text.format.schema.properties.translations.minItems = 1; },
      (body) => { body.max_output_tokens = profile.maxOutputTokens + 1; },
      (body) => { body.tools = []; },
    ];
    for (const mutate of invalid) {
      const body = structuredClone(valid);
      mutate(body);
      assert.throws(() => validateQualityRequest(body, profile.key));
    }
    assert.throws(() => validateQualityRequest(valid, 'unknown-profile'), /Unsupported model profile/);
    assert.throws(() => validateQualityRequest(valid, { ...profile, model: 'different/model' }), /Unsupported model profile/);
    assert.throws(() => adaptQualityRequest({ ...originalBody(), fallback_models: ['model'] }, profile));
    assert.throws(() => adaptQualityRequest({ ...originalBody(), plugins: [] }, profile));
    assert.throws(() => adaptQualityRequest({ ...originalBody(), model: 'different/model' }, profile));
    assert.throws(() => adaptQualityRequest({ ...originalBody(), reasoning: { effort: 'low' } }, profile));
    assert.throws(() => adaptQualityRequest({ ...originalBody(), provider: { ...originalBody().provider, sort: 'throughput' } }, profile));
    const overContext = structuredClone(valid);
    overContext.instructions = 'x'.repeat(profile.contextWindow);
    assert.throws(() => validateQualityRequest(overContext, profile.key), /context window/);
  },
}, {
  name: 'validates exact response shape and unique ids through the public codec structure seam',
  fn() {
    const records = [plainRecord('first'), plainRecord('second', 'Translate this second block.')];
    const valid = validateQualityOutput(response(records.map(({ id }) => ({ id, template: '번역된 문장입니다.' }))), records);
    assert.deepEqual(valid.translations.map(({ id, structure }) => [id, structure.status]), [
      ['first', 'safe'], ['second', 'safe'],
    ]);
    for (const output of [
      JSON.stringify({ translations: [] }),
      response([{ id: 'first', template: '번역' }]),
      response([{ id: 'first', template: '번역' }, { id: 'extra', template: '번역' }]),
      response([{ id: 'first', template: '번역' }, { id: 'first', template: '다시' }]),
      JSON.stringify({ translations: [{ id: 'first', template: '번역', extra: true }, { id: 'second', template: '번역' }] }),
      JSON.stringify({ translations: [{ id: 'first', template: 1 }, { id: 'second', template: '번역' }] }),
      JSON.stringify({ translations: [{ id: 'first', template: '번역' }, { id: 'second', template: '번역' }], extra: true }),
    ]) assert.throws(() => validateQualityOutput(output, records));
    assert.throws(() => validateQualityOutput(response([]), []), /input records/);

    const reasoning = createReasoningFixture().serialized;
    const reasoningRecord = { id: 'reasoning', template: reasoning.template, contract: reasoning.contract };
    const damaged = response([{ id: 'reasoning', template: '번역된 문장입니다.' }]);
    assert.throws(() => validateQualityOutput(damaged, [reasoningRecord]), /structure contract/);
    const repairable = validateQualityOutput(damaged, [reasoningRecord], { structure: false });
    assert.equal(repairable.translations[0].template, '번역된 문장입니다.');
    for (const invalid of [
      JSON.stringify({ translations: [{ id: 'reasoning', template: '번역', extra: true }] }),
      response([{ id: 'reasoning', template: '번역' }, { id: 'extra', template: '추가' }]),
      response([{ id: 'wrong-id', template: '번역' }]),
    ]) assert.throws(() => validateQualityOutput(invalid, [reasoningRecord], { structure: false }));
  },
}, {
  name: 'keeps protocol and broken-placeholder behavior covered through public model execution',
  async fn() {
    const settings = { model: 'fixture', reasoningEffort: 'none', targetLanguage: 'Korean', tone: 'technical' };
    const record = plainRecord();
    await assert.rejects(execute([record], settings, async () => JSON.stringify({ translations: [] })),
      (error) => error.code === 'protocol.missing_id');
    await assert.rejects(execute([record], settings, async () => response([
      { id: record.id, template: '번역' }, { id: record.id, template: '중복' },
    ])), (error) => error.code === 'protocol.duplicate_id');

    const serialized = createReasoningFixture().serialized;
    let attempts = 0;
    const [result] = await execute([{
      id: 'reasoning', template: serialized.template, atoms: serialized.atoms,
      contract: serialized.contract, repair: null,
    }], settings, async () => {
      attempts += 1;
      return response([{ id: 'reasoning', template: '번역된 문장입니다.' }]);
    });
    assert.equal(attempts, 2);
    assert.equal(result.disposition, 'reject');
    assert.equal(result.diagnostic.structure.status, 'unsafe');
  },
}];
