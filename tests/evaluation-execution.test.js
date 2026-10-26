const assert = require('node:assert/strict');
const { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

async function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), 'evaluation-execution-'));
  try {
    const { runEvaluation } = await import('./integration/evaluation-execution.mjs');
    const { createRoutingExperiment, routeRequest, MODEL } = await import('./integration/routing-pilot.mjs');
    const { createBudget, PRICE_CAP } = await import('./integration/routing-budget.mjs');
    const experiment = createRoutingExperiment();
    const budget = createBudget({ inputTokenLimit: 1048576 });
    const output = join(root, 'output');
    const events = [];
    let callbacks;
    let active = false;
    let count = 0;
    const responses = new Map();
    const adapter = {
      live: true,
      async withTransport(execute) {
        active = true;
        try {
          return await execute(async ({ body }) => {
            assert.equal(active, true);
            assert.equal(body.model, MODEL);
            assert.ok(budget.snapshot().reservedUsd > 0);
            assert.equal(readdirSync(output).filter(name => name.startsWith('reservation-')).length, count);
            events.push('send');
            const data = { status: 'completed', usage: { cost: 0.0001, output_tokens_details: { reasoning_tokens: 0 } },
              output: [{ type: 'message', content: [{ type: 'output_text', text: '번역 결과' }] }] };
            return { status: 200, text: async () => JSON.stringify(data) };
          });
        } finally { active = false; events.push('transport-closed'); }
      },
      async prepare(value) { callbacks = value; },
      async execute(entry, record) {
        count += 1;
        const body = routeRequest({ model: MODEL, reasoning: { effort: 'none' }, store: false,
          provider: { require_parameters: true, data_collection: 'deny', zdr: true, max_price: PRICE_CAP },
          input: entry.flow === 'inline' ? JSON.stringify({ records: [{ id: 'block', template: 'The same source prose.', atoms: [], repair: null }] }) : 'The same source prose.',
          instructions: 'Translate to Korean.', max_output_tokens: 4096 }, entry.policy);
        await callbacks.request({ body, networkId: `request-${count}`,
          fulfill: async () => { events.push('fulfill'); responses.set(`request-${count}`, { valid: true }); },
          fail: async () => events.push('blocked') });
        record.success = true;
        record.elapsedMs = 1;
        record.outcomes = entry.flow === 'inline'
          ? { translated: 1, partial: 0, pending: 0, changed: 0, failed: 0 } : { documentDisplayed: true };
        return { source: 'The same source prose.', translated: '번역 결과', complete: true };
      },
      async settle() { events.push('settle'); },
      evidence() { return { requestIds: new Set(responses.keys()), responses, reasoningTokens: [] }; },
      async close() { assert.equal(active, true); events.push('browser-closed'); },
    };
    await run({ runEvaluation, experiment, budget, output, events, adapter, callbacks: () => callbacks });
  } finally { rmSync(root, { recursive: true, force: true }); }
}

exports.name = 'evaluation execution';
exports.tests = [{
  name: 'runs routing comparison through reservation evidence, transport, settlement, and private artifacts',
  async fn() {
    await fixture(async ({ runEvaluation, experiment, budget, output, events, adapter }) => {
      const result = await runEvaluation({ output, experiment, adapter, budget });
      assert.equal(result.completePlan, true);
      assert.equal(budget.snapshot().spentUsd, 0.0036);
      assert.equal(budget.snapshot().reservedUsd, 0);
      assert.equal((statSync(output).mode & 0o777), 0o700);
      for (const file of readdirSync(output)) assert.equal((statSync(join(output, file)).mode & 0o777), 0o600);
      const summary = JSON.parse(readFileSync(join(output, 'summary.json')));
      assert.equal(summary.records.length, 36);
      assert.equal(summary.comparisonEligible, true);
      assert.equal(summary.syntheticBudget, false);
      assert.equal(summary.records.every(record => record.requests[0].accounted), true);
      assert.deepEqual(events.slice(-2), ['browser-closed', 'transport-closed']);
    });
  },
}];
exports.tests.push({
  name: 'freezes an unsettled reservation even when response observation fails during cleanup',
  async fn() {
    await fixture(async ({ runEvaluation, experiment, budget, output, events, adapter }) => {
      const withTransport = adapter.withTransport;
      adapter.withTransport = execute => withTransport(() => execute(async () => { throw new Error('transport interrupted'); }));
      adapter.settle = async () => { throw new Error('observer failed'); };
      await assert.rejects(runEvaluation({ output, experiment, adapter, budget }), /observer failed/);
      assert.equal(budget.snapshot().frozen, true);
      assert.ok(budget.snapshot().reservedUsd > 0);
      assert.deepEqual(events.slice(-2), ['browser-closed', 'transport-closed']);
    });
  },
});
exports.tests.push({
  name: 'blocks transmission when reservation or reservation evidence fails and still closes resources',
  async fn() {
    for (const failure of ['reservation', 'evidence']) {
      await fixture(async ({ runEvaluation, experiment, budget, output, events, adapter }) => {
        const selectedBudget = failure === 'reservation'
          ? (await import('./integration/routing-budget.mjs')).createBudget({ limitUsd: 0.1, inputTokenLimit: 1048576 }) : budget;
        if (failure === 'evidence') adapter.writeEvidence = (path, ...args) => {
          if (path.includes('/reservation-')) throw new Error('Reservation disk write failed');
          return writeFileSync(path, ...args);
        };
        const result = await runEvaluation({ output, experiment, adapter, budget: selectedBudget });
        assert.equal(result.completePlan, false);
        assert.equal(events.includes('send'), false);
        assert.equal(events.includes('blocked'), true);
        assert.equal(selectedBudget.snapshot().frozen, failure === 'evidence');
        assert.deepEqual(events.slice(-2), ['browser-closed', 'transport-closed']);
      });
    }
  },
});
exports.tests.push({
  name: 'retains an unknown charge reservation, freezes the shared ledger, and blocks a subsequent transmission',
  async fn() {
    await fixture(async ({ runEvaluation, experiment, budget, output, events, adapter, callbacks }) => {
      const withTransport = adapter.withTransport;
      let sentBody;
      adapter.withTransport = execute => withTransport(transport => execute(async args => {
        events.push('attempted');
        sentBody = args.body;
        const response = await transport(args);
        const data = JSON.parse(await response.text());
        delete data.usage.cost;
        return { status: 200, text: async () => JSON.stringify(data) };
      }));
      const execute = adapter.execute;
      adapter.execute = async (...args) => {
        const observation = await execute(...args);
        await callbacks().request({ body: sentBody, networkId: 'after-unknown-cost',
          fulfill: async () => events.push('unexpected-fulfill'), fail: async () => events.push('later-blocked') });
        return observation;
      };
      const result = await runEvaluation({ output, experiment, adapter, budget });
      assert.equal(result.completePlan, false);
      assert.equal(budget.snapshot().frozen, true);
      assert.ok(budget.snapshot().reservedUsd > 0);
      assert.equal(budget.snapshot().spentUsd, 0);
      assert.equal(events.filter(value => value === 'attempted').length, 1);
      assert.equal(events.includes('later-blocked'), true);
      const completion = JSON.parse(readFileSync(join(output, 'completion.json')));
      assert.equal(completion.budget.frozen, true);
    });
  },
});
exports.tests.push({
  name: 'rejects a valid late request after interruption even when the ledger is still usable',
  async fn() {
    await fixture(async ({ runEvaluation, experiment, budget, output, events, adapter, callbacks }) => {
      const withTransport = adapter.withTransport;
      let sentBody;
      adapter.withTransport = execute => withTransport(transport => execute(async args => {
        events.push('attempted');
        sentBody = args.body;
        return transport(args);
      }));
      const execute = adapter.execute;
      adapter.execute = async (...args) => {
        const observation = await execute(...args);
        callbacks().halt();
        await callbacks().request({ body: sentBody, networkId: 'after-interruption',
          fulfill: async () => events.push('unexpected-fulfill'), fail: async () => events.push('later-blocked') });
        return observation;
      };
      const result = await runEvaluation({ output, experiment, adapter, budget });
      assert.equal(result.completePlan, false);
      assert.equal(budget.snapshot().frozen, false);
      assert.equal(budget.snapshot().spentUsd, 0.0001);
      assert.equal(events.filter(value => value === 'attempted').length, 1);
      assert.equal(events.includes('later-blocked'), true);
    });
  },
});
exports.tests.push({
  name: 'drains an in-flight transmission and settlement before closing its transport on execution error',
  async fn() {
    await fixture(async ({ runEvaluation, experiment, budget, output, events, adapter }) => {
      let release;
      const pending = new Promise(resolve => { release = resolve; });
      const withTransport = adapter.withTransport;
      adapter.withTransport = execute => withTransport(transport => execute(async args => {
        events.push('in-flight');
        await pending;
        return transport(args);
      }));
      const execute = adapter.execute;
      adapter.execute = async (...args) => {
        execute(...args);
        setImmediate(release);
        throw new Error('Execution interrupted');
      };
      await assert.rejects(runEvaluation({ output, experiment, adapter, budget }), /Execution interrupted/);
      assert.equal(budget.snapshot().spentUsd, 0.0001);
      assert.equal(budget.snapshot().reservedUsd, 0);
      assert.equal(budget.snapshot().frozen, false);
      assert.ok(events.indexOf('send') < events.indexOf('browser-closed'));
      assert.deepEqual(events.slice(-2), ['browser-closed', 'transport-closed']);
      assert.equal(JSON.parse(readFileSync(join(output, 'completion.json'))).completePlan, false);
    });
  },
});
exports.tests.push({
  name: 'closes browser resources and transport when initial or completion evidence cannot be written',
  async fn() {
    for (const filename of ['execution.json', 'completion.json']) {
      await fixture(async ({ runEvaluation, experiment, budget, output, events, adapter }) => {
        adapter.writeEvidence = (path, ...args) => {
          if (path.endsWith(`/${filename}`)) throw new Error('Evidence disk write failed');
          return writeFileSync(path, ...args);
        };
        await assert.rejects(runEvaluation({ output, experiment, adapter, budget }), /Evidence disk write failed/);
        assert.deepEqual(events.slice(-2), ['browser-closed', 'transport-closed']);
      });
    }
  },
});
exports.tests.push({
  name: 'preserves Side Panel displayed status at the original quality qualification stage',
  async fn() {
    for (const failure of [
      { protectedContent: false, targetLanguagePresent: true, documentDisplayed: false },
      { protectedContent: true, targetLanguagePresent: false, documentDisplayed: true },
    ]) {
      await fixture(async ({ runEvaluation, output }) => {
        const { createQualityExperiment, adaptQualityRequest } = await import('./integration/model-quality.mjs');
        const { createBudget } = await import('./integration/routing-budget.mjs');
        const experiment = createQualityExperiment({ corpus: { pages: [{ id: 'compatibility' }] },
          profileKeys: ['deepseek'], planIds: ['compatibility|sidepanel|deepseek'] });
        const budget = createBudget({ limitUsd: 5, maxBudgetUsd: 5, inputTokenLimit: 1048576 });
        let request;
        const data = { status: 'completed', usage: { cost: 0.0001, output_tokens_details: { reasoning_tokens: 0 } },
          output: [{ type: 'message', content: [{ type: 'output_text', text: '번역 결과' }] }] };
        const adapter = {
          live: true,
          withTransport: execute => execute(async () => ({ status: 200, text: async () => JSON.stringify(data) })),
          async prepare(callbacks) { request = callbacks.request; },
          async execute(entry, record) {
            const body = adaptQualityRequest({ model: 'deepseek/deepseek-v4.1-flash-1017', reasoning: { effort: 'none' },
              provider: { require_parameters: true, data_collection: 'deny', zdr: true }, store: false,
              input: 'Read `protectedCode()`.', instructions: 'Translate to Korean.', max_output_tokens: 4096 }, entry.profile);
            await request({ body, networkId: 'sidepanel-request', fulfill: async () => {},
              fail: async () => { throw new Error('Valid deterministic request was refused'); } });
            Object.assign(record, { success: true, coverage: { matched: true, expectedBlocks: 1, expectedChunks: 1 },
              protectedContent: failure.protectedContent, targetLanguagePresent: failure.targetLanguagePresent,
              outcomes: { documentDisplayed: true } });
            return { complete: true, source: 'Read `protectedCode()`.', translated: '번역 결과' };
          },
          async settle() {},
          evidence: () => ({ requestIds: new Set(['sidepanel-request']),
            responses: new Map([['sidepanel-request', { valid: true }]]), reasoningTokens: [0] }),
          async close() {},
        };
        const result = await runEvaluation({ output, experiment, adapter, budget });
        assert.equal(result.records[0].success, false);
        assert.equal(result.records[0].outcomes.documentDisplayed, failure.documentDisplayed);
        const artifact = JSON.parse(readFileSync(join(output, 'compatibility|sidepanel|deepseek.json')));
        assert.equal(artifact.success, false);
        assert.equal(artifact.outcomes.documentDisplayed, failure.documentDisplayed);
      });
    }
  },
});
