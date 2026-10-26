import { resolve } from 'node:path';
import { loadQualityCorpus } from './model-quality-corpus.mjs';
import { buildQualityPlan, createQualityExperiment } from './model-quality.mjs';
import { createBrowserAdapter } from './routing-pilot-browser.mjs';
import { runEvaluation } from './evaluation-execution.mjs';
import { createMockTransport } from './evaluation-transport.mjs';
import { createBudget } from './routing-budget.mjs';

const args = process.argv.slice(2);
if (args[0] !== '--wmt-corpus' || !args[1] || !['--plan', '--output'].includes(args[2]) ||
    args.length !== (args[2] === '--plan' ? 3 : 4)) {
  throw new Error('Use --wmt-corpus <private-manifest> --plan or --wmt-corpus <private-manifest> --output <new-private-directory>. Mock only.');
}
const corpus = loadQualityCorpus(resolve(args[1]));
if (args[2] === '--plan') {
  console.log(JSON.stringify({ mode: 'mock-plan-only', corpus, runs: buildQualityPlan(corpus.pages.map(page => page.id)) }, null, 2));
} else {
  const result = await runEvaluation({ output: resolve(args[3]), experiment: createQualityExperiment({ corpus }),
    adapter: createBrowserAdapter({ transport: createMockTransport() }), budget: createBudget({ inputTokenLimit: 1048576 }) });
  if (!result.completePlan) process.exitCode = 1;
}
