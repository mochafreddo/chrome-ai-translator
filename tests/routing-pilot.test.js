const assert = require('node:assert/strict');
const { MODEL, buildPlan, routeRequest, summarize, validateComparison } =
  require('./integration/routing-pilot.mjs');

function makeRecords() {
  return buildPlan().map((entry, index) => ({
    ...entry,
    success: true,
    elapsedMs: (index + 1) * 100,
    cacheHit: false,
    requests: [{
      phase: 'initial',
      model: MODEL,
      reasoning: 'none',
      provider: {
        require_parameters: true,
        data_collection: 'deny',
        zdr: true,
        ...(entry.policy === 'throughput' ? { sort: 'throughput' } : {}),
      },
      store: false,
      inputHash: `${entry.page}-${entry.flow}-${entry.repetition}`,
      maxOutputTokens: 4096,
      cost: 0.01,
    }],
  }));
}

exports.name = 'routing pilot';
exports.tests = [{
  name: 'builds the confirmed 36-run plan with alternating routing order',
  fn() {
    const plan = buildPlan();
    assert.equal(plan.length, 36);
    assert.deepEqual([...new Set(plan.map((run) => run.page))], ['technical', 'github', 'article']);
    assert.deepEqual([...new Set(plan.map((run) => run.flow))], ['inline', 'sidepanel']);
    assert.deepEqual(plan.slice(0, 4).map(({ policy, repetition }) => [policy, repetition]), [
      ['default', 1], ['throughput', 1], ['throughput', 2], ['default', 2],
    ]);
    assert.equal(new Set(plan.map((run) => run.id)).size, 36);
  },
}, {
  name: 'adds only throughput sorting to a validated copy of the request',
  fn() {
    const body = {
      model: MODEL,
      reasoning: { effort: 'none' },
      store: false,
      provider: { require_parameters: true, data_collection: 'deny', zdr: true },
      input: 'synthetic input',
    };
    const routed = routeRequest(body, 'throughput');
    assert.deepEqual(routed.provider, { ...body.provider, sort: 'throughput' });
    assert.deepEqual(body.provider, { require_parameters: true, data_collection: 'deny', zdr: true });
    assert.notEqual(routed, body);
    assert.throws(() => routeRequest({ ...body, provider: { ...body.provider, only: ['provider'] } }, 'default'));
    assert.throws(() => routeRequest({ ...body, model: 'another/model' }, 'throughput'));
  },
}, {
  name: 'validates all planned records and rejects missing or duplicate run ids',
  fn() {
    const records = makeRecords();
    assert.equal(validateComparison(records), true);
    assert.throws(() => validateComparison(records.slice(1)), /every planned run/);
    const duplicated = records.slice();
    duplicated[1] = { ...duplicated[1], id: duplicated[0].id };
    assert.throws(() => validateComparison(duplicated), /duplicated/);
  },
}, {
  name: 'rejects identical routing in both arms and a repair sent under the wrong policy',
  fn() {
    const samePolicy = makeRecords();
    const throughput = samePolicy.find((record) => record.policy === 'throughput');
    throughput.requests[0].provider = {
      require_parameters: true, data_collection: 'deny', zdr: true,
    };
    assert.throws(() => validateComparison(samePolicy), /throughput|routing/);

    const wrongRepair = makeRecords();
    const run = wrongRepair.find((record) => record.policy === 'throughput');
    run.requests.push({
      ...run.requests[0],
      phase: 'repair',
      provider: { require_parameters: true, data_collection: 'deny', zdr: true },
      inputHash: `${run.id}-repair`,
    });
    assert.throws(() => validateComparison(wrongRepair), /throughput|routing/);
  },
}, {
  name: 'compares every initial request while allowing additional differently sized repairs',
  fn() {
    const mismatched = makeRecords();
    const pair = mismatched.filter((record) => record.page === 'technical' &&
      record.flow === 'inline' && record.repetition === 1);
    const laterInitial = {
      ...pair[0].requests[0],
      inputHash: 'later-source-chunk',
      maxOutputTokens: 2048,
    };
    pair[0].requests.push(laterInitial);
    assert.throws(() => validateComparison(mismatched), /initial inputs or output limits/);

    const differingLaterInputs = makeRecords();
    const differingPair = differingLaterInputs.filter((record) => record.page === 'technical' &&
      record.flow === 'inline' && record.repetition === 1);
    differingPair[0].requests.push({
      ...differingPair[0].requests[0], inputHash: 'first-later-chunk', phase: 'initial',
    });
    differingPair[1].requests.push({
      ...differingPair[1].requests[0], inputHash: 'different-later-chunk', phase: 'initial',
    });
    assert.throws(() => validateComparison(differingLaterInputs), /initial inputs or output limits/);

    const differentLaterLimits = makeRecords();
    const limitedPair = differentLaterLimits.filter((record) => record.page === 'technical' &&
      record.flow === 'inline' && record.repetition === 1);
    limitedPair[0].requests.push({
      ...limitedPair[0].requests[0], inputHash: 'later-source-chunk', maxOutputTokens: 2048,
    });
    limitedPair[1].requests.push({
      ...limitedPair[1].requests[0], inputHash: 'later-source-chunk', maxOutputTokens: 4096,
    });
    assert.throws(() => validateComparison(differentLaterLimits), /initial inputs or output limits/);

    const differentRepairs = makeRecords();
    const throughput = differentRepairs.find((record) => record.page === 'technical' &&
      record.flow === 'inline' && record.policy === 'throughput' && record.repetition === 1);
    throughput.requests.push({
      ...throughput.requests[0],
      phase: 'repair',
      inputHash: 'different-repair-context',
      maxOutputTokens: 2048,
    });
    assert.equal(validateComparison(differentRepairs), true);
  },
}, {
  name: 'rejects cache hits and invalid request phases',
  fn() {
    const cached = makeRecords();
    cached[0].cacheHit = true;
    assert.throws(() => validateComparison(cached), /cache/);

    const invalidPhase = makeRecords();
    invalidPhase[0].requests[0].phase = 'retry';
    assert.throws(() => validateComparison(invalidPhase), /phase/);
  },
}, {
  name: 'counts failed request costs and keeps unknown cost unknown',
  fn() {
    const records = makeRecords();
    const failed = records.find((record) => record.policy === 'default');
    failed.success = false;
    failed.requests.push({
      ...failed.requests[0],
      phase: 'repair',
      inputHash: `${failed.id}-repair`,
      cost: 0.02,
    });
    const summary = summarize(records);
    const defaultInline = summary.groups.find((group) => group.flow === 'inline' && group.policy === 'default');
    assert.equal(defaultInline.attempts, 10);
    assert.equal(defaultInline.repairAttempts, 1);
    assert.equal(defaultInline.successes, 8);
    assert.equal(defaultInline.failures, 1);
    assert.ok(Math.abs(defaultInline.totalCost - 0.11) < Number.EPSILON);
    assert.ok(Math.abs(defaultInline.costPerSuccess - 0.01375) < Number.EPSILON);
    assert.equal(defaultInline.medianElapsedMs, 1650);
    assert.equal(Object.hasOwn(defaultInline, 'p95ElapsedMs'), false);

    const unknown = makeRecords();
    delete unknown.find((record) => record.policy === 'throughput').requests[0].cost;
    const throughputInline = summarize(unknown).groups.find((group) =>
      group.flow === 'inline' && group.policy === 'throughput');
    assert.equal(throughputInline.totalCost, null);
    assert.equal(throughputInline.costPerSuccess, null);
  },
}];

exports.tests.push({
  name: 'prints a fingerprinted corpus plan without launching a browser and refuses live mode',
  fn() {
    const fs = require('node:fs');
    const path = require('node:path');
    const { createHash } = require('node:crypto');
    const { execFileSync, spawnSync } = require('node:child_process');
    const root = path.resolve(__dirname, '..');
    const command = 'tests/integration/routing-pilot.mock.mjs';
    const plan = JSON.parse(execFileSync(process.execPath, [command, '--plan'], { cwd: root, encoding: 'utf8' }));
    assert.equal(plan.mode, 'plan-only');
    assert.equal(plan.runs.length, 36);
    assert.deepEqual(plan.corpus.pages.map(page => page.id).sort(), ['article', 'github', 'technical']);
    for (const page of plan.corpus.pages) {
      const bytes = fs.readFileSync(path.join(root, 'tests/integration/fixtures/routing-pilot', `${page.id}.html`));
      assert.equal(createHash('sha256').update(bytes).digest('hex'), page.sha256);
    }
    const refused = spawnSync(process.execPath, [command, '--live'], { cwd: root, encoding: 'utf8' });
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /intercepted mock responses only/);
  },
});

exports.tests.push({
  name: 'requires identical price caps and retains costs when failed coverage is explicitly reported',
  fn() {
    const { PRICE_CAP } = require('./integration/routing-budget.mjs');
    const records = makeRecords();
    for (const record of records) record.requests[0].provider.max_price = { ...PRICE_CAP };
    assert.equal(validateComparison(records), true);
    delete records[0].requests[0].provider.max_price;
    assert.throws(() => validateComparison(records), /different initial inputs/);
    records[0].requests[0].provider.max_price = { ...PRICE_CAP };
    records[0].success = false;
    records[1].requests.push({ ...records[1].requests[0], inputHash: 'unreached-later-chunk' });
    assert.throws(() => summarize(records), /different initial inputs/);
    const reported = summarize(records, { allowFailedCoverage: true });
    assert.equal(reported.groups[0].failures, 1);
    assert.ok(reported.groups[0].totalCost > 0);
  },
});
