import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const codec = require('../../extension/inline-block.js');

function freezeProfile(profile) {
  Object.freeze(profile.reasoning);
  Object.freeze(profile.priceCap);
  return Object.freeze(profile);
}

export const PROFILES = Object.freeze([
  freezeProfile({
    key: 'deepseek',
    model: 'deepseek/deepseek-v4.1-flash-1017',
    reasoning: { effort: 'none' },
    priceCap: { prompt: 0.30, completion: 1.20, request: 0 },
    contextWindow: 1_048_576,
    maxOutputTokens: 131_072,
    conservative: true,
  }),
  freezeProfile({
    key: 'gpt-6-luna',
    model: 'openai/gpt-6-luna',
    reasoning: { effort: 'none' },
    priceCap: { prompt: 0.11, completion: 0.55, request: 0 },
    contextWindow: 1_050_000,
    maxOutputTokens: 128_000,
  }),
  freezeProfile({
    key: 'solar-pro4',
    model: 'upstage/solar-pro4',
    reasoning: { effort: 'none' },
    priceCap: { prompt: 0.15, completion: 0.60, request: 0 },
    contextWindow: 524_288,
    maxOutputTokens: 131_072,
  }),
  freezeProfile({
    key: 'mimo-v2.6-flash',
    model: 'xiaomi/mimo-v2.6-flash',
    reasoning: { enabled: false },
    priceCap: { prompt: 0.14, completion: 0.28, request: 0 },
    contextWindow: 1_050_000,
    maxOutputTokens: 131_072,
    compatibilityPending: true,
  }),
  freezeProfile({
    key: 'claude-haiku-5.5',
    model: 'anthropic/claude-haiku-5.5',
    reasoning: { effort: 'none' },
    priceCap: { prompt: 0.11, completion: 0.55, request: 0 },
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
  }),
  freezeProfile({
    key: 'minimax-m3.1-flash',
    model: 'minimax/minimax-m3.1-flash',
    reasoning: { effort: 'low' },
    priceCap: { prompt: 0.30, completion: 1.20, request: 0 },
    contextWindow: 1_048_576,
    maxOutputTokens: 524_288,
  }),
]);

function fail(message) {
  throw new TypeError(message);
}

function sameKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
}

function sameValue(left, right) {
  if (left === right) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object' ||
      Array.isArray(left) !== Array.isArray(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length && leftKeys.every((key, index) =>
    key === rightKeys[index] && sameValue(left[key], right[key]));
}

function resolveProfile(profileOrKey) {
  if (typeof profileOrKey === 'string') {
    const profile = PROFILES.find((candidate) => candidate.key === profileOrKey);
    if (profile) return profile;
    fail('Unsupported model profile.');
  }
  if (!profileOrKey || typeof profileOrKey !== 'object' || Array.isArray(profileOrKey)) {
    fail('Unsupported model profile.');
  }
  const profile = PROFILES.find((candidate) => candidate.key === profileOrKey.key);
  if (!profile || !sameValue(profile, profileOrKey)) fail('Unsupported model profile.');
  return profile;
}

function inputRecordCount(body) {
  if (typeof body.input !== 'string' || !body.input) fail('Request input must be serialized JSON.');
  let parsed;
  try {
    parsed = JSON.parse(body.input);
  } catch {
    fail('Request input must be serialized JSON.');
  }
  if (!sameKeys(parsed, ['records']) || !Array.isArray(parsed.records) || parsed.records.length === 0) {
    fail('Request input must contain records.');
  }
  const ids = new Set();
  for (const record of parsed.records) {
    if (!record || typeof record !== 'object' || Array.isArray(record) ||
        !sameKeys(record, ['id', 'template', 'atoms', 'repair']) ||
        typeof record.id !== 'string' || !record.id || typeof record.template !== 'string' ||
        !Array.isArray(record.atoms) || ids.has(record.id)) {
      fail('Request input record is invalid.');
    }
    ids.add(record.id);
  }
  return parsed.records.length;
}

function assertSchema(schema, count, boundsRequired) {
  if (!sameKeys(schema, ['type', 'additionalProperties', 'properties', 'required']) ||
      schema.type !== 'object' || schema.additionalProperties !== false ||
      !Array.isArray(schema.required) || schema.required.length !== 1 || schema.required[0] !== 'translations' ||
      !sameKeys(schema.properties, ['translations'])) fail('Inline translation schema is invalid.');
  const translations = schema.properties.translations;
  const translationKeys = boundsRequired
    ? ['type', 'minItems', 'maxItems', 'items']
    : ['type', 'items'];
  if (!sameKeys(translations, translationKeys) || translations.type !== 'array' ||
      (boundsRequired && (translations.minItems !== count || translations.maxItems !== count))) {
    fail('Inline translation schema bounds are invalid.');
  }
  const item = translations.items;
  if (!sameKeys(item, ['type', 'additionalProperties', 'properties', 'required']) ||
      item.type !== 'object' || item.additionalProperties !== false ||
      !sameKeys(item.properties, ['id', 'template']) ||
      !sameKeys(item.properties.id, ['type']) || item.properties.id.type !== 'string' ||
      !sameKeys(item.properties.template, ['type']) || item.properties.template.type !== 'string' ||
      !Array.isArray(item.required) || item.required.length !== 2 ||
      item.required[0] !== 'id' || item.required[1] !== 'template') {
    fail('Inline translation schema fields are invalid.');
  }
}

function assertFormat(body, count, boundsRequired) {
  if (!sameKeys(body.text, ['format']) ||
      !sameKeys(body.text.format, ['type', 'name', 'strict', 'schema']) ||
      body.text.format.type !== 'json_schema' ||
      body.text.format.name !== 'inline_block_translations' ||
      body.text.format.strict !== true) fail('Inline response format is invalid.');
  assertSchema(body.text.format.schema, count, boundsRequired);
}

function assertProfileValues(profile) {
  if (!profile || typeof profile.model !== 'string' || !profile.model ||
      !profile.reasoning || typeof profile.reasoning !== 'object' || Array.isArray(profile.reasoning) ||
      !profile.priceCap || !sameKeys(profile.priceCap, ['prompt', 'completion', 'request']) ||
      !Number.isFinite(profile.priceCap.prompt) || profile.priceCap.prompt <= 0 ||
      !Number.isFinite(profile.priceCap.completion) || profile.priceCap.completion <= 0 ||
      profile.priceCap.request !== 0 ||
      !Number.isSafeInteger(profile.contextWindow) || profile.contextWindow <= 0 ||
      !Number.isSafeInteger(profile.maxOutputTokens) || profile.maxOutputTokens <= 0) {
    fail('Model profile limits are invalid.');
  }
}

function assertContext(body, profile) {
  if (!Number.isSafeInteger(body.max_output_tokens) || body.max_output_tokens <= 0 ||
      body.max_output_tokens > profile.maxOutputTokens) fail('Request output limit exceeds the model profile.');
  if (typeof body.input !== 'string' || !body.input ||
      typeof body.instructions !== 'string' || !body.instructions) fail('Request input or instructions are missing.');
  const byteCount = new TextEncoder().encode(`${body.instructions}\n${body.input}`).length;
  if (byteCount + body.max_output_tokens > profile.contextWindow) {
    fail('Request exceeds the model profile context window.');
  }
}

export function buildQualityPlan(pageIds, profileKeys = PROFILES.map(profile => profile.key), runIds = null) {
  if (!Array.isArray(pageIds) || pageIds.length === 0 || pageIds.some((page) =>
    typeof page !== 'string' || page.trim() === '') || new Set(pageIds).size !== pageIds.length) {
    fail('Page ids must be a nonempty list of unique strings.');
  }
  const runs = [];
  if (!Array.isArray(profileKeys) || !profileKeys.length || new Set(profileKeys).size !== profileKeys.length) fail('Profile keys must be unique and nonempty.');
  const profiles = profileKeys.map(resolveProfile);
  for (const page of pageIds) {
    for (const flow of ['inline', 'sidepanel']) {
      for (const profile of profiles) {
        runs.push({
          id: `${encodeURIComponent(page)}|${flow}|${profile.key}`,
          page,
          flow,
          profileKey: profile.key,
          profile,
        });
      }
    }
  }
  if (new Set(runs.map((run) => run.id)).size !== runs.length) fail('Quality plan ids must be unique.');
  if (runIds === null) return runs;
  if (!Array.isArray(runIds) || !runIds.length || runIds.some(id => typeof id !== 'string' || id.length === 0) ||
      new Set(runIds).size !== runIds.length) fail('Run ids must be unique, nonempty strings.');
  const byId = new Map(runs.map(run => [run.id, run]));
  if (runIds.some(id => !byId.has(id))) fail('Run ids must belong to the canonical quality plan.');
  return runIds.map(id => byId.get(id));
}

export function adaptQualityRequest(body, profile) {
  function reject(message) { throw new Error(message); }
  function keys(value, expected) {
    return value && typeof value === 'object' && !Array.isArray(value) &&
      Object.keys(value).sort().join('\0') === [...expected].sort().join('\0');
  }
  function exact(left, right) {
    if (left === right) return true;
    if (!left || !right || typeof left !== 'object' || typeof right !== 'object' ||
        Array.isArray(left) !== Array.isArray(right)) return false;
    const a = Object.keys(left).sort(), b = Object.keys(right).sort();
    return a.length === b.length && a.every((key, i) => key === b[i] && exact(left[key], right[key]));
  }
  function inputCount(value) {
    let parsed;
    try { parsed = JSON.parse(value); } catch { reject('Request input must be serialized JSON.'); }
    if (!keys(parsed, ['records']) || !Array.isArray(parsed.records) || parsed.records.length === 0) reject('Request input must contain records.');
    const ids = new Set();
    for (const record of parsed.records) {
      if (!record || typeof record !== 'object' || Array.isArray(record) ||
          !keys(record, ['id', 'template', 'atoms', 'repair']) || typeof record.id !== 'string' ||
          !record.id || typeof record.template !== 'string' || !Array.isArray(record.atoms) || ids.has(record.id)) {
        reject('Request input record is invalid.');
      }
      ids.add(record.id);
    }
    return parsed.records.length;
  }
  function schemaValid(schema, count) {
    const required = ['type', 'additionalProperties', 'properties', 'required'];
    if (!keys(schema, required) || schema.type !== 'object' || schema.additionalProperties !== false ||
        !Array.isArray(schema.required) || schema.required.length !== 1 || schema.required[0] !== 'translations' ||
        !keys(schema.properties, ['translations'])) reject('Original inline schema is invalid.');
    const entries = schema.properties.translations;
    if (!keys(entries, ['type', 'minItems', 'maxItems', 'items']) || entries.type !== 'array' ||
        entries.minItems !== count || entries.maxItems !== count) reject('Original inline schema bounds are invalid.');
    const item = entries.items;
    if (!keys(item, required) || item.type !== 'object' || item.additionalProperties !== false ||
        !keys(item.properties, ['id', 'template']) || !keys(item.properties.id, ['type']) ||
        item.properties.id.type !== 'string' || !keys(item.properties.template, ['type']) ||
        item.properties.template.type !== 'string' || !Array.isArray(item.required) ||
        item.required.length !== 2 || item.required[0] !== 'id' || item.required[1] !== 'template') {
      reject('Original inline schema fields are invalid.');
    }
  }
  const inline = Boolean(body && typeof body === 'object' && Object.hasOwn(body, 'text'));
  const bodyKeys = ['model', 'reasoning', 'provider', 'store', 'input', 'instructions', 'max_output_tokens',
    ...(inline ? ['text'] : [])];
  if (!body || typeof body !== 'object' || Array.isArray(body) || !keys(body, bodyKeys)) {
    reject('Original request contains unsupported configuration.');
  }
  if (body.model !== 'deepseek/deepseek-v4.1-flash-1017' ||
      !exact(body.reasoning, { effort: 'none' }) || body.store !== false ||
      !exact(body.provider, { require_parameters: true, data_collection: 'deny', zdr: true })) {
    reject('Original request does not match the pinned DeepSeek privacy settings.');
  }
  if (typeof body.input !== 'string' || !body.input || typeof body.instructions !== 'string' || !body.instructions ||
      !Number.isSafeInteger(body.max_output_tokens) || body.max_output_tokens <= 0) {
    reject('Original request fields are invalid.');
  }
  if (inline) {
    const count = inputCount(body.input);
    if (!keys(body.text, ['format']) || !keys(body.text.format, ['type', 'name', 'strict', 'schema']) ||
        body.text.format.type !== 'json_schema' || body.text.format.name !== 'inline_block_translations' ||
        body.text.format.strict !== true) reject('Original inline response format is invalid.');
    schemaValid(body.text.format.schema, count);
  }
  if (!profile || typeof profile.model !== 'string' || !profile.model ||
      !profile.reasoning || typeof profile.reasoning !== 'object' || Array.isArray(profile.reasoning) ||
      !keys(profile.priceCap, ['prompt', 'completion', 'request']) ||
      !Number.isFinite(profile.priceCap.prompt) || profile.priceCap.prompt <= 0 ||
      !Number.isFinite(profile.priceCap.completion) || profile.priceCap.completion <= 0 ||
      profile.priceCap.request !== 0 || !Number.isSafeInteger(profile.contextWindow) ||
      profile.contextWindow <= 0 || !Number.isSafeInteger(profile.maxOutputTokens) ||
      profile.maxOutputTokens <= 0 || body.max_output_tokens > profile.maxOutputTokens) {
    reject('Target model profile is invalid.');
  }
  if (new TextEncoder().encode(`${body.instructions}\n${body.input}`).length + body.max_output_tokens > profile.contextWindow) {
    reject('Original request exceeds the target model context window.');
  }
  const adapted = JSON.parse(JSON.stringify(body));
  adapted.model = profile.model;
  adapted.reasoning = JSON.parse(JSON.stringify(profile.reasoning));
  adapted.provider = {
    require_parameters: true,
    data_collection: 'deny',
    zdr: true,
    max_price: {
      prompt: profile.priceCap.prompt,
      completion: profile.priceCap.completion,
      request: 0,
    },
  };
  if (inline) {
    delete adapted.text.format.schema.properties.translations.minItems;
    delete adapted.text.format.schema.properties.translations.maxItems;
  }
  return adapted;
}

export function validateQualityRequest(body, profileKeyOrProfile) {
  const profile = resolveProfile(profileKeyOrProfile);
  assertProfileValues(profile);
  const inline = Boolean(body && typeof body === 'object' && Object.hasOwn(body, 'text'));
  const bodyKeys = ['model', 'reasoning', 'provider', 'store', 'input', 'instructions', 'max_output_tokens',
    ...(inline ? ['text'] : [])];
  if (!sameKeys(body, bodyKeys) ||
      body.model !== profile.model || !sameValue(body.reasoning, profile.reasoning) || body.store !== false) {
    fail('Observed request does not match the selected model profile.');
  }
  if (!sameKeys(body.provider, ['require_parameters', 'data_collection', 'zdr', 'max_price']) ||
      body.provider.require_parameters !== true || body.provider.data_collection !== 'deny' ||
      body.provider.zdr !== true || !sameValue(body.provider.max_price, profile.priceCap)) {
    fail('Observed request privacy or price cap is invalid.');
  }
  if (inline) {
    const count = inputRecordCount(body);
    assertFormat(body, count, false);
  } else if (typeof body.input !== 'string' || !body.input) {
    fail('Observed Side Panel input is missing.');
  }
  assertContext(body, profile);
  return true;
}

export function validateQualityOutput(outputText, inputRecords, { structure = true } = {}) {
  if (!Array.isArray(inputRecords) || inputRecords.length === 0) fail('Quality output requires input records.');
  const expected = new Map();
  for (const record of inputRecords) {
    if (!record || typeof record.id !== 'string' || !record.id || expected.has(record.id) ||
        typeof record.template !== 'string' || !record.contract) fail('Quality input record is invalid.');
    expected.set(record.id, record);
  }
  let parsed;
  try {
    parsed = JSON.parse(outputText);
  } catch {
    fail('Model output is not valid JSON.');
  }
  if (!sameKeys(parsed, ['translations']) || !Array.isArray(parsed.translations) ||
      parsed.translations.length !== expected.size) fail('Model output has an invalid response shape.');
  const returned = new Map();
  for (const item of parsed.translations) {
    if (!sameKeys(item, ['id', 'template']) || typeof item.id !== 'string' || !item.id ||
        typeof item.template !== 'string' || !expected.has(item.id) || returned.has(item.id)) {
      fail('Model output has an invalid translation item.');
    }
    returned.set(item.id, item.template);
  }
  if (returned.size !== expected.size || [...expected.keys()].some((id) => !returned.has(id))) {
    fail('Model output ids do not match request records.');
  }
  const translations = [];
  for (const [id, template] of returned) {
    const record = expected.get(id);
    const validation = structure ? codec.validateTranslatedTemplate(template, record.contract) : { ok: true };
    if (!validation.ok) fail(`Model output violates the structure contract (${validation.errorCode}).`);
    translations.push({
      id,
      template,
      structure: {
        status: 'safe',
        codes: validation.droppedWrappers?.length ? ['structure.emphasis_dropped'] : [],
      },
    });
  }
  return { translations };
}
