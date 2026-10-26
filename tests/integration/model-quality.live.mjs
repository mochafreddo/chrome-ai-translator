import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROFILES } from './model-quality.mjs';
import { loadQualityCorpus, loadCompatibilityCorpus } from './model-quality-corpus.mjs';
import { createBudget, PRICE_CAP } from './routing-budget.mjs';
import { runPilot } from './routing-pilot-browser.mjs';

export function compatibleProfiles(records) {
  return PROFILES.filter(profile => {
    const runs = records.filter(run => run.profileKey === profile.key);
    return runs.length === 2 && ['inline', 'sidepanel'].every(flow => runs.some(run => run.flow === flow)) &&
      runs.every(run => run.success && run.requests.length > 0 && run.requests.every(request =>
        request.accounted && Number.isFinite(request.cost) && request.reasoningAccepted === true && request.contractAccepted !== false));
  }).map(profile => profile.key);
}

export async function preflightProfiles(fetchImpl = globalThis.fetch) {
  const read = async path => {
    const response = await fetchImpl(`https://openrouter.ai/api/v1/${path}`, { redirect: 'error', signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error('Public model preflight failed.');
    return response.json();
  };
  const zdr = await read('endpoints/zdr');
  if (!Array.isArray(zdr.data)) throw new Error('Invalid public ZDR inventory.');
  const zdrKeys = new Set(zdr.data.map(endpoint => `${endpoint.model_id}|${endpoint.tag}`));
  const profiles = [];
  let inputTokenLimit = 0;
  const inventories = {};
  for (const profile of PROFILES) {
    if (profile.priceCap.prompt > PRICE_CAP.prompt || profile.priceCap.completion > PRICE_CAP.completion || profile.priceCap.request !== 0) {
      throw new Error('A profile exceeds the accounting price ceiling.');
    }
    const inventory = await read(`models/${profile.model}/endpoints`);
    inventories[profile.key] = inventory;
    const endpoints = inventory.data?.endpoints;
    if (!Array.isArray(endpoints) || !endpoints.length || endpoints.some(endpoint =>
      !Number.isSafeInteger(endpoint.context_length) || endpoint.context_length < 1 || endpoint.context_length > 1050000)) {
      throw new Error('A current model context bound cannot be established.');
    }
    inputTokenLimit = Math.max(inputTokenLimit, ...endpoints.map(endpoint => endpoint.context_length));
    const knownPrice = value => (typeof value === 'string' && value.trim() !== '' || typeof value === 'number') &&
      Number.isFinite(Number(value)) && Number(value) >= 0;
    const candidates = endpoints.filter(endpoint => endpoint.status === 0 &&
      zdrKeys.has(`${profile.model}|${endpoint.tag}`) &&
      ['structured_outputs', 'reasoning', 'response_format'].every(parameter => endpoint.supported_parameters?.includes(parameter)) &&
      knownPrice(endpoint.pricing?.prompt) && knownPrice(endpoint.pricing?.completion) &&
      Number(endpoint.pricing.prompt) * 1e6 <= profile.priceCap.prompt + 1e-12 &&
      Number(endpoint.pricing.completion) * 1e6 <= profile.priceCap.completion + 1e-12 && endpoint.max_completion_tokens >= 16000);
    if (candidates.length) profiles.push(profile.key);
  }
  return { profiles, inputTokenLimit, inventories, zdr, compatibilityProven: false };
}

export async function main(args = process.argv.slice(2)) {
  if (args.length !== 6 || args[0] !== '--output' || !args[1] || args[2] !== '--wmt-corpus' || !args[3] ||
      args[4] !== '--budget-usd' || Number(args[5]) !== 5) {
    throw new Error('Use --output <new-private-directory> --wmt-corpus <private-manifest> --budget-usd 5. Bills real OpenRouter inference.');
  }
  process.umask(0o077);
  const output = resolve(args[1]);
  mkdirSync(output, { mode: 0o700 });
  const save = (name, value) => writeFileSync(resolve(output, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  const corpus = loadQualityCorpus(resolve(args[3]));
  const preflight = await preflightProfiles();
  save('preflight.json', preflight);
  save('authorization.json', { limitUsd: 5, sharedAcross: ['compatibility', 'quality'], feesAndTaxesExcluded: true,
    profiles: PROFILES, corpusFingerprint: createHash('sha256').update(JSON.stringify(corpus)).digest('hex') });
  if (!preflight.profiles.length) throw new Error('No model has a current preflight candidate.');
  const budget = createBudget({ limitUsd: 5, maxBudgetUsd: 5, inputTokenLimit: preflight.inputTokenLimit, maxInputTokens: 1050000 });
  let probes;
  let comparison;
  try {
    probes = await runPilot({ output: resolve(output, 'compatibility'), qualityCorpus: loadCompatibilityCorpus(),
      profileKeys: preflight.profiles, live: true, qualityLive: true, sharedBudget: budget, budgetUsd: 5 });
    const qualified = compatibleProfiles(probes.records);
    save('compatibility-result.json', { completePlan: probes.completePlan, qualified,
      excluded: PROFILES.filter(profile => !qualified.includes(profile.key)).map(profile => profile.key), budget: budget.snapshot() });
    if (!probes.completePlan || budget.snapshot().frozen || !qualified.length) throw new Error('Compatibility did not establish a safe qualified comparison.');
    comparison = await runPilot({ output: resolve(output, 'quality'), qualityCorpus: corpus, profileKeys: qualified,
      live: true, qualityLive: true, sharedBudget: budget, budgetUsd: 5 });
    save('result.json', { completePlan: comparison.completePlan, qualified, budget: budget.snapshot(),
      semanticReview: 'pending blinded source-based review', comparisonRuns: comparison.records.length });
    if (!comparison.completePlan) process.exitCode = 1;
  } finally {
    save('completion.json', { budget: budget.snapshot(), compatibilityRuns: probes?.records.length ?? null,
      comparisonRuns: comparison?.records.length ?? null, completePlan: comparison?.completePlan === true,
      resumeRequiresReconciliation: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
