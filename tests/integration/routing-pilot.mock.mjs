import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPlan, createRoutingExperiment } from './routing-pilot.mjs';
import { createBrowserAdapter } from './routing-pilot-browser.mjs';
import { runEvaluation } from './evaluation-execution.mjs';
import { createMockTransport } from './evaluation-transport.mjs';
import { createBudget } from './routing-budget.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--plan') {
  console.log(JSON.stringify({ mode: 'plan-only', runs: buildPlan(), corpus: JSON.parse(readFileSync(join(ROOT, 'tests/integration/fixtures/routing-pilot/corpus.json'))) }, null, 2));
} else if (args.length === 2 && args[0] === '--output') {
  const result = await runEvaluation({ output: resolve(args[1]), experiment: createRoutingExperiment(),
    adapter: createBrowserAdapter({ transport: createMockTransport() }), budget: createBudget({ inputTokenLimit: 1048576 }) });
  if (!result.completePlan) process.exitCode = 1;
} else {
  throw new Error('Use --plan or --output <new-private-directory>. This command supports intercepted mock responses only.');
}
