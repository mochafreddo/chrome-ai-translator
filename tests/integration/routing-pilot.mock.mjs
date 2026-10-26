import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPlan } from './routing-pilot.mjs';
import { runPilot } from './routing-pilot-browser.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--plan') {
  console.log(JSON.stringify({ mode: 'plan-only', runs: buildPlan(), corpus: JSON.parse(readFileSync(join(ROOT, 'tests/integration/fixtures/routing-pilot/corpus.json'))) }, null, 2));
} else if (args.length === 2 && args[0] === '--output') {
  const result = await runPilot({ output: resolve(args[1]) });
  if (!result.completePlan) process.exitCode = 1;
} else {
  throw new Error('Use --plan or --output <new-private-directory>. This command supports intercepted mock responses only.');
}
