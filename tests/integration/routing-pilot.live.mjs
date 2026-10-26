import { resolve } from 'node:path';
import { runPilot } from './routing-pilot-browser.mjs';
import { MODEL } from './routing-pilot.mjs';

const args = process.argv.slice(2);
if (args.length !== 4 || args[0] !== '--output' || args[2] !== '--budget-usd' || Number(args[3]) !== 2) {
  throw new Error('Use --output <new-private-directory> --budget-usd 2. This command bills real OpenRouter inference.');
}
const response = await fetch(`https://openrouter.ai/api/v1/models/${MODEL}/endpoints`, { signal: AbortSignal.timeout(15000) });
if (!response.ok) throw new Error('Public pricing preflight failed.');
const endpoints = (await response.json()).data?.endpoints;
if (!Array.isArray(endpoints) || !endpoints.length || endpoints.some(endpoint =>
  !Number.isSafeInteger(endpoint.context_length) || endpoint.context_length < 1 || endpoint.context_length > 1048576)) {
  throw new Error('Model context bound cannot be established.');
}
const result = await runPilot({ output: resolve(args[1]), live: true, budgetUsd: 2,
  inputTokenLimit: Math.max(...endpoints.map(endpoint => endpoint.context_length)) });
if (!result.completePlan) process.exitCode = 1;
