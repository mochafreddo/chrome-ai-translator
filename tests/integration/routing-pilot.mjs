import { createRequire } from 'node:module';
import { PRICE_CAP } from './routing-budget.mjs';

const require = createRequire(import.meta.url);
const { OPENROUTER_MODEL } = require('../../extension/default-model.js');

export const MODEL = OPENROUTER_MODEL;

const PAGES = Object.freeze(['technical', 'github', 'article']);
const FLOWS = Object.freeze(['inline', 'sidepanel']);
const POLICIES = Object.freeze(['default', 'throughput']);
const REQUIRED_PROVIDER = Object.freeze({
  require_parameters: true,
  data_collection: 'deny',
  zdr: true,
});
const ROUTING_RESTRICTIONS = Object.freeze(['sort', 'order', 'only', 'ignore', 'allow_fallbacks']);

function fail(message) {
  throw new TypeError(message);
}

function isRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertProvider(provider, policy) {
  if (!isRecord(provider)) fail('Request provider settings must be an object.');
  for (const [key, value] of Object.entries(REQUIRED_PROVIDER)) {
    if (provider[key] !== value) fail(`Request provider setting ${key} is invalid.`);
  }
  for (const key of ROUTING_RESTRICTIONS) {
    const expectedThroughputSort = key === 'sort' && policy === 'throughput';
    if (expectedThroughputSort) {
      if (provider.sort !== 'throughput') fail('Throughput routing must sort by throughput.');
    } else if (Object.hasOwn(provider, key)) {
      fail(`Request provider restriction ${key} is not allowed.`);
    }
  }
  for (const key of Object.keys(provider)) {
    if (key === 'max_price') {
      if (!isRecord(provider.max_price) || JSON.stringify(Object.entries(provider.max_price).sort()) !==
          JSON.stringify(Object.entries(PRICE_CAP).sort())) fail('Request price caps are invalid.');
      continue;
    }
    if (![...Object.keys(REQUIRED_PROVIDER), ...(policy === 'throughput' ? ['sort'] : [])].includes(key)) {
      fail(`Request provider setting ${key} is not allowed.`);
    }
  }
}

function assertBaseRequest(body) {
  if (!isRecord(body)) fail('Responses request body must be an object.');
  if (body.model !== MODEL) fail('Responses request must use the pinned OpenRouter model.');
  if (!isRecord(body.reasoning) || body.reasoning.effort !== 'none' || Object.keys(body.reasoning).length !== 1) {
    fail('Responses request must disable reasoning.');
  }
  if (body.store !== false) fail('Responses request must disable storage.');
  assertProvider(body.provider, 'default');
}

export function buildPlan() {
  const plan = [];
  for (const page of PAGES) {
    for (const flow of FLOWS) {
      for (let repetition = 1; repetition <= 3; repetition += 1) {
        const policies = repetition % 2 === 1 ? POLICIES : [...POLICIES].reverse();
        for (const policy of policies) {
          plan.push({
            id: `${page}-${flow}-${policy}-${repetition}`,
            page,
            flow,
            policy,
            repetition,
          });
        }
      }
    }
  }
  return plan;
}

export function routeRequest(body, policy) {
  if (!POLICIES.includes(policy)) fail('Routing policy is unsupported.');
  assertBaseRequest(body);
  const routed = { ...body, provider: { ...body.provider } };
  if (policy === 'throughput') routed.provider.sort = 'throughput';
  return routed;
}

function assertReasoningNone(reasoning) {
  return reasoning === 'none' || (
    isRecord(reasoning) && reasoning.effort === 'none' && Object.keys(reasoning).length === 1
  );
}

function assertRequestMetadata(request, policy, id) {
  if (!isRecord(request)) fail(`Request metadata for ${id} must be an object.`);
  for (const key of ['phase', 'model', 'reasoning', 'provider', 'store', 'inputHash', 'maxOutputTokens']) {
    if (!Object.hasOwn(request, key)) fail(`Request metadata for ${id} is missing ${key}.`);
  }
  if (!['initial', 'repair'].includes(request.phase)) fail(`Request metadata for ${id} has an invalid phase.`);
  if (request.model !== MODEL) fail(`Request metadata for ${id} uses an unexpected model.`);
  if (!assertReasoningNone(request.reasoning)) fail(`Request metadata for ${id} enables reasoning.`);
  if (request.store !== false) fail(`Request metadata for ${id} enables storage.`);
  assertProvider(request.provider, policy);
  if (typeof request.inputHash !== 'string' || request.inputHash.length === 0) {
    fail(`Request metadata for ${id} has no input hash.`);
  }
  if (!Number.isSafeInteger(request.maxOutputTokens) || request.maxOutputTokens <= 0) {
    fail(`Request metadata for ${id} has an invalid output limit.`);
  }
  if (Object.hasOwn(request, 'cost') && request.cost !== null &&
      (typeof request.cost !== 'number' || !Number.isFinite(request.cost) || request.cost < 0)) {
    fail(`Request metadata for ${id} has an invalid cost.`);
  }
}

function pairKey(record) {
  return `${record.page}\0${record.flow}\0${record.repetition}`;
}

export function validateComparison(records, { allowFailedCoverage = false } = {}) {
  if (!Array.isArray(records)) fail('Comparison records must be an array.');
  const plan = buildPlan();
  if (records.length !== plan.length) fail('Comparison must contain every planned run exactly once.');
  const planned = new Map(plan.map((entry) => [entry.id, entry]));
  const observed = new Map();

  for (const record of records) {
    if (!isRecord(record) || typeof record.id !== 'string') fail('Every comparison record needs an id.');
    const expected = planned.get(record.id);
    if (!expected) fail(`Comparison record ${record.id} is not in the plan.`);
    if (observed.has(record.id)) fail(`Comparison record ${record.id} is duplicated.`);
    for (const key of ['page', 'flow', 'policy', 'repetition']) {
      if (record[key] !== expected[key]) fail(`Comparison record ${record.id} has mismatched ${key}.`);
    }
    if (typeof record.success !== 'boolean') fail(`Comparison record ${record.id} needs a success status.`);
    if (typeof record.elapsedMs !== 'number' || !Number.isFinite(record.elapsedMs) || record.elapsedMs < 0) {
      fail(`Comparison record ${record.id} has invalid elapsed time.`);
    }
    if (record.cacheHit !== false) fail(`Comparison record ${record.id} must prove the output cache was bypassed.`);
    if (!Array.isArray(record.requests) || record.requests.length === 0) {
      fail(`Comparison record ${record.id} must retain request metadata for every attempt.`);
    }
    for (const request of record.requests) assertRequestMetadata(request, expected.policy, record.id);
    if (!record.requests.some((request) => request.phase === 'initial')) {
      fail(`Comparison record ${record.id} must retain an initial request.`);
    }
    observed.set(record.id, record);
  }

  for (const pair of new Set(records.map(pairKey))) {
    const arms = records.filter((record) => pairKey(record) === pair);
    if (arms.length !== POLICIES.length || arms[0].policy === arms[1].policy) {
      fail('Each page, flow, and repetition must include both routing policies.');
    }
    const initialRequestSets = arms.map((record) => record.requests
      .filter((request) => request.phase === 'initial')
      .map(({ inputHash, maxOutputTokens, provider }) => JSON.stringify([inputHash, maxOutputTokens, provider.max_price || null]))
      .sort());
    if (JSON.stringify(initialRequestSets[0]) !== JSON.stringify(initialRequestSets[1])) {
      if (allowFailedCoverage && arms.some(record => !record.success)) continue;
      fail(`Routing arms for ${arms[0].page}/${arms[0].flow}/${arms[0].repetition} use different initial inputs or output limits.`);
    }
  }
  return true;
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function summarize(records, options = {}) {
  validateComparison(records, options);
  const groups = [];
  for (const flow of FLOWS) {
    for (const policy of POLICIES) {
      const runs = records.filter((record) => record.flow === flow && record.policy === policy);
      const requests = runs.flatMap((record) => record.requests);
      const knownCosts = requests.map((request) => request.cost);
      const totalCost = knownCosts.some((cost) => cost === undefined || cost === null)
        ? null
        : knownCosts.reduce((total, cost) => total + cost, 0);
      const successes = runs.filter((record) => record.success);
      groups.push({
        flow,
        policy,
        attempts: requests.length,
        repairAttempts: requests.filter((request) => request.phase === 'repair').length,
        successes: successes.length,
        failures: runs.length - successes.length,
        totalCost,
        costPerSuccess: totalCost === null || successes.length === 0 ? null : totalCost / successes.length,
        medianElapsedMs: successes.length ? median(successes.map((record) => record.elapsedMs)) : null,
      });
    }
  }
  return { groups };
}
