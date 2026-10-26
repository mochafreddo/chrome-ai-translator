import { resolve } from 'node:path';
import { loadQualityCorpus } from './model-quality-corpus.mjs';
import { buildQualityPlan } from './model-quality.mjs';
import { runPilot } from './routing-pilot-browser.mjs';

const args = process.argv.slice(2);
if (args[0] !== '--wmt-corpus' || !args[1] || !['--plan', '--output'].includes(args[2]) ||
    args.length !== (args[2] === '--plan' ? 3 : 4)) {
  throw new Error('Use --wmt-corpus <private-manifest> --plan or --wmt-corpus <private-manifest> --output <new-private-directory>. Mock only.');
}
const corpus = loadQualityCorpus(resolve(args[1]));
if (args[2] === '--plan') {
  console.log(JSON.stringify({ mode: 'mock-plan-only', corpus, runs: buildQualityPlan(corpus.pages.map(page => page.id)) }, null, 2));
} else {
  const result = await runPilot({ output: resolve(args[3]), qualityCorpus: corpus });
  if (!result.completePlan) process.exitCode = 1;
}
