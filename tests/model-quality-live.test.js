const assert = require('node:assert/strict');
const { mkdtempSync, existsSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

let liveModule;
let qualityModule;
async function live() {
  liveModule ||= await import('./integration/model-quality.live.mjs');
  return liveModule;
}
async function quality() {
  qualityModule ||= await import('./integration/model-quality.mjs');
  return qualityModule;
}

function inventoryFor(profile, overrides = {}) {
  return {
    data: { endpoints: [{
      tag: 'stable',
      status: 0,
      context_length: profile.contextWindow,
      max_completion_tokens: 16000,
      supported_parameters: ['structured_outputs', 'reasoning', 'response_format'],
      pricing: { prompt: String(profile.priceCap.prompt / 1e6), completion: String(profile.priceCap.completion / 1e6) },
      ...overrides,
    }] },
  };
}

function fakeFetch(profileOverrides = {}, zdr = null) {
  return async url => {
    const path = new URL(url).pathname.replace('/api/v1/', '');
    if (path === 'endpoints/zdr') return { ok: true, json: async () => zdr || ({
      data: (await quality()).PROFILES.map(profile => ({ model_id: profile.model, tag: 'stable' })),
    }) };
    const profile = (await quality()).PROFILES.find(item => path === `models/${item.model}/endpoints`);
    if (!profile) throw new Error(`Unexpected synthetic endpoint path: ${path}`);
    const override = profileOverrides[profile.key] || {};
    if (override.malformed) return { ok: true, json: async () => override.malformed };
    return { ok: true, json: async () => inventoryFor(profile, override.endpoint || {}) };
  };
}

function compatibilityRun(profileKey, flow, overrides = {}) {
  return {
    profileKey,
    flow,
    success: true,
    requests: [{ accounted: true, cost: 0.001, reasoningAccepted: true, contractAccepted: true }],
    ...overrides,
  };
}

exports.name = 'model quality live preparation';
exports.tests = [{
  name: 'module import is inert and the live main rejects invalid budgets before creating output',
  async fn() {
    const root = mkdtempSync(join(tmpdir(), 'model-quality-live-'));
    const output = join(root, 'must-not-exist');
    try {
      const exitCode = process.exitCode;
      const args = process.argv.slice();
      const { main } = await live();
      assert.deepEqual(process.argv, args);
      assert.equal(process.exitCode, exitCode);
      await assert.rejects(main(['--output', output, '--wmt-corpus', join(root, 'missing.json'), '--budget-usd', '4']), /budget-usd 5/);
      assert.equal(existsSync(output), false);
      await assert.rejects(main(['--output', output, '--wmt-corpus', join(root, 'missing.json'), '--budget-usd', '5', '--extra']), /budget-usd 5/);
      assert.equal(existsSync(output), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
}, {
  name: 'preflight accepts only current ZDR endpoints with matching price, parameters, status, and context ceiling',
  async fn() {
    const { PROFILES } = await quality();
    const { preflightProfiles } = await live();
    const result = await preflightProfiles(fakeFetch());
    assert.deepEqual(result.profiles, PROFILES.map(profile => profile.key));
    assert.equal(result.inputTokenLimit, 1_050_000);
    assert.equal(result.compatibilityProven, false);
    assert.equal(Object.keys(result.inventories).length, PROFILES.length);

    const rejectedCases = [
      { endpoint: { pricing: { prompt: '0.00000031', completion: '0.00000001' } } },
      { endpoint: { pricing: { prompt: null, completion: '0.00000001' } } },
      { endpoint: { pricing: { prompt: '', completion: '0.00000001' } } },
      { endpoint: { pricing: { prompt: '-0.00000001', completion: '0.00000001' } } },
      { endpoint: { pricing: { prompt: '0.00000001', completion: null } } },
      { endpoint: { pricing: { prompt: '0.00000001', completion: '' } } },
      { endpoint: { pricing: { prompt: '0.00000001', completion: '-0.00000001' } } },
      { endpoint: { status: 1 } },
      { endpoint: { supported_parameters: ['structured_outputs', 'response_format'] } },
      { zdr: { data: [] } },
    ];
    for (const testCase of rejectedCases) {
      const candidate = testCase.zdr
        ? await preflightProfiles(fakeFetch({}, testCase.zdr))
        : await preflightProfiles(fakeFetch(Object.fromEntries(PROFILES.map(profile => [profile.key, testCase]))));
      assert.deepEqual(candidate.profiles, []);
    }
  },
}, {
  name: 'preflight rejects malformed inventories and contexts above the study limit',
  async fn() {
    const { PROFILES } = await quality();
    const { preflightProfiles } = await live();
    const malformed = Object.fromEntries(PROFILES.map(profile => [profile.key, { malformed: { data: { endpoints: [] } } }]));
    await assert.rejects(preflightProfiles(fakeFetch(malformed)), /context bound/);
    const overContext = Object.fromEntries(PROFILES.map(profile => [profile.key, { endpoint: { context_length: 1_050_001 } }]));
    await assert.rejects(preflightProfiles(fakeFetch(overContext)), /context bound/);
    await assert.rejects(preflightProfiles(fakeFetch({}, { data: {} })), /ZDR inventory/);
  },
}, {
  name: 'all frozen profile price caps fit within the shared budget ceiling',
  async fn() {
    const { PROFILES } = await quality();
    for (const profile of PROFILES) {
      assert.ok(profile.priceCap.prompt <= 0.33);
      assert.ok(profile.priceCap.completion <= 1.32);
      assert.equal(profile.priceCap.request, 0);
    }
  },
}, {
  name: 'only profiles with exactly two successful, accounted, contract-safe flows qualify',
  async fn() {
    const { PROFILES, compatibleProfiles } = await quality();
    const all = PROFILES.flatMap(profile => [
      compatibilityRun(profile.key, 'inline'),
      compatibilityRun(profile.key, 'sidepanel'),
    ]);
    assert.deepEqual(compatibleProfiles(all), PROFILES.map(profile => profile.key));

    const cases = [
      [all.filter(run => !(run.profileKey === PROFILES[0].key && run.flow === 'inline')), PROFILES[0].key],
      [all.map(run => run.profileKey === PROFILES[1].key ? { ...run, success: false } : run), PROFILES[1].key],
      [all.map(run => run.profileKey === PROFILES[2].key && run.flow === 'sidepanel' ? { ...run, flow: 'inline' } : run), PROFILES[2].key],
      [all.map(run => run.profileKey === PROFILES[0].key && run.flow === 'sidepanel' ? { ...run, flow: 'background' } : run), PROFILES[0].key],
      [all.map(run => run.profileKey === PROFILES[3].key ? { ...run, requests: [{ ...run.requests[0], cost: null }] } : run), PROFILES[3].key],
      [all.map(run => run.profileKey === PROFILES[4].key ? { ...run, requests: [{ ...run.requests[0], reasoningAccepted: false }] } : run), PROFILES[4].key],
      [all.map(run => run.profileKey === PROFILES[5].key ? { ...run, requests: [{ ...run.requests[0], contractAccepted: false }] } : run), PROFILES[5].key],
    ];
    for (const [records, excludedKey] of cases) {
      assert.deepEqual(compatibleProfiles(records), PROFILES.filter(profile => profile.key !== excludedKey).map(profile => profile.key));
    }
  },
}, {
  name: 'qualified profile subsets produce 24 runs each across twelve pages and reject invalid keys',
  async fn() {
    const { PROFILES, buildQualityPlan } = await quality();
    const keys = PROFILES.slice(0, 2).map(profile => profile.key);
    const plan = buildQualityPlan(Array.from({ length: 12 }, (_, index) => `page-${index + 1}`), keys);
    assert.equal(plan.length, 48);
    for (const key of keys) assert.equal(plan.filter(run => run.profileKey === key).length, 24);
    assert.throws(() => buildQualityPlan(['page-1'], ['unknown-profile']), /Unsupported model profile/);
    assert.throws(() => buildQualityPlan(['page-1'], [keys[0], keys[0]]), /unique and nonempty/);
  },
}];
