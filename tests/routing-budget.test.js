const assert = require('node:assert/strict');
const { PRICE_CAP, createBudget } = require('./integration/routing-budget.mjs');

exports.name = 'routing budget';
exports.tests = [{
  name: 'reserves an upward-rounded bound from the public endpoint price caps',
  fn() {
    assert.deepEqual(PRICE_CAP, { prompt: 0.33, completion: 1.32, request: 0 });
    const budget = createBudget({ limitUsd: 2, inputTokenLimit: 1_000_000 });
    assert.equal(budget.reserve('request-1', 10_000), 0.3432);
    assert.deepEqual(budget.snapshot(), {
      limitUsd: 2,
      spentUsd: 0,
      reservedUsd: 0.3432,
      frozen: false,
      remainingUsd: 1.6568,
    });
  },
}, {
  name: 'opening spend reduces available admission without changing the reserved cost bound',
  fn() {
    const budget = createBudget({ limitUsd: 0.6, inputTokenLimit: 1_000_000, openingSpentUsd: 0.2568 });
    assert.deepEqual(budget.snapshot(), {
      limitUsd: 0.6,
      spentUsd: 0.2568,
      reservedUsd: 0,
      frozen: false,
      remainingUsd: 0.3432,
    });
    assert.equal(budget.reserve('continuation-request', 10_000), 0.3432);
    assert.equal(budget.snapshot().remainingUsd, 0);

    const exhausted = createBudget({ limitUsd: 0.6, inputTokenLimit: 1_000_000, openingSpentUsd: 0.256800001 });
    assert.throws(() => exhausted.reserve('too-expensive', 10_000), /Budget limit/);
    assert.equal(exhausted.snapshot().reservedUsd, 0);
  },
}, {
  name: 'gates concurrent reservations and permits another after known settlement',
  fn() {
    const budget = createBudget({ limitUsd: 0.6, inputTokenLimit: 1_000_000 });
    assert.equal(budget.reserve('request-1', 10_000), 0.3432);
    assert.throws(() => budget.reserve('request-2', 10_000), /Budget limit/);
    assert.equal(budget.snapshot().reservedUsd, 0.3432);
    budget.settle('request-1', 0.001);
    assert.deepEqual(budget.snapshot(), {
      limitUsd: 0.6,
      spentUsd: 0.001,
      reservedUsd: 0,
      frozen: false,
      remainingUsd: 0.599,
    });
    assert.equal(budget.reserve('request-2', 10_000), 0.3432);
  },
}, {
  name: 'accepts an explicitly authorized five dollar envelope with one shared mixed-model gate',
  fn() {
    const budget = createBudget({
      limitUsd: 5,
      maxBudgetUsd: 5,
      inputTokenLimit: 1_050_000,
      maxInputTokens: 1_050_000,
      openingSpentUsd: 0.237795159,
    });
    assert.equal(budget.snapshot().limitUsd, 5);
    assert.equal(budget.snapshot().spentUsd, 0.237795159);
    assert.equal(budget.reserve('openai/gpt-6-luna-initial', 1_050_000), 1.7325);
    assert.equal(budget.reserve('minimax/minimax-m3.1-flash-repair', 1_050_000), 1.7325);
    assert.throws(() => budget.reserve('deepseek/deepseek-v4.1-flash-repair', 1_050_000), /Budget limit/);
    assert.equal(budget.snapshot().reservedUsd, 3.465);
    assert.equal(budget.snapshot().remainingUsd, 1.297204841);
    budget.settle('openai/gpt-6-luna-initial', 0.01);
    assert.equal(budget.reserve('deepseek/deepseek-v4.1-flash-repair', 1_050_000), 1.7325);
  },
}, {
  name: 'freezes and retains the reservation when actual cost is unknown',
  fn() {
    for (const unknownCost of [undefined, null, Number.NaN, -0.001]) {
      const budget = createBudget({ limitUsd: 0.6, inputTokenLimit: 1_000_000 });
      budget.reserve('request-1', 10_000);
      assert.throws(() => budget.settle('request-1', unknownCost), /unknown/);
      assert.deepEqual(budget.snapshot(), {
        limitUsd: 0.6,
        spentUsd: 0,
        reservedUsd: 0.3432,
        frozen: true,
        remainingUsd: 0.2568,
      });
      assert.throws(() => budget.reserve('request-2', 10_000), /frozen/);
      assert.throws(() => budget.settle('request-1', 0.001), /unsettled/);
    }
  },
}, {
  name: 'charges a known overrun before freezing and rounds cost upward to nanodollars',
  fn() {
    const overrun = createBudget({ limitUsd: 0.6, inputTokenLimit: 1_000_000 });
    overrun.reserve('request-1', 10_000);
    assert.throws(() => overrun.settle('request-1', 0.4), /exceeded its reservation/);
    assert.deepEqual(overrun.snapshot(), {
      limitUsd: 0.6,
      spentUsd: 0.4,
      reservedUsd: 0,
      frozen: true,
      remainingUsd: 0.2,
    });

    const overspent = createBudget({ limitUsd: 0.6, inputTokenLimit: 1_000_000 });
    overspent.reserve('request-1', 10_000);
    assert.throws(() => overspent.settle('request-1', 1), /exceeded its reservation/);
    assert.equal(overspent.snapshot().spentUsd, 1);
    assert.equal(overspent.snapshot().remainingUsd, -0.4);

    const rounded = createBudget({ limitUsd: 0.6, inputTokenLimit: 1_000_000 });
    rounded.reserve('request-1', 10_000);
    rounded.settle('request-1', 0.0010000000001);
    assert.equal(rounded.snapshot().spentUsd, 0.001000001);
  },
}, {
  name: 'rejects duplicate and unknown settlements and invalid budget or token limits',
  fn() {
    const budget = createBudget({ limitUsd: 0.6, inputTokenLimit: 1_000_000 });
    budget.reserve('request-1', 10_000);
    assert.throws(() => budget.reserve('request-1', 10_000), /unique/);
    assert.throws(() => budget.settle('missing', 0), /unsettled/);
    budget.settle('request-1', 0.001);
    assert.throws(() => budget.settle('request-1', 0.001), /unsettled/);

    for (const options of [
      { limitUsd: 0 }, { limitUsd: 2.01 }, { limitUsd: 3, inputTokenLimit: 100 }, { limitUsd: Number.NaN },
      { limitUsd: 0.0000000001 }, { inputTokenLimit: 0 },
      { inputTokenLimit: 1_048_577 }, { inputTokenLimit: 1_050_000 }, { inputTokenLimit: 1.5 },
      { maxBudgetUsd: 0 }, { maxBudgetUsd: 5.01 }, { maxInputTokens: 0 }, { maxInputTokens: 1_050_001 },
      { maxInputTokens: 1_050_000, inputTokenLimit: 1_050_001 },
    ]) {
      assert.throws(() => createBudget(options));
    }
    for (const openingSpentUsd of [-0.01, Number.NaN, 0.600000001]) {
      assert.throws(() => createBudget({ limitUsd: 0.6, inputTokenLimit: 100, openingSpentUsd }));
    }
    const capped = createBudget({ limitUsd: 2, inputTokenLimit: 100 });
    assert.throws(() => capped.reserve('too-large', 101), /Output token limit/);
  },
}];
