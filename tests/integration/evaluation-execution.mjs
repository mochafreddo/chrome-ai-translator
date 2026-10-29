import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getResponseMetadata } from './model-request-evidence.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');

export async function runEvaluation({ output, experiment, adapter, budget }) {
  const live = adapter.live;
  if (experiment.census && live && budget.snapshot().limitUsd !== 5) {
    throw new Error('Model quality live execution requires the approved shared USD 5 ledger.');
  }
  process.umask(0o077);
  mkdirSync(output, { mode: 0o700 });
  const save = (name, data) => (adapter.writeEvidence || writeFileSync)(join(output, name), JSON.stringify(data, null, 2) + '\n',
    { flag: 'wx', mode: 0o600 });
  const session = `rp-${randomUUID().slice(0, 8)}`;
  const records = [];
  const reviews = [];
  const mapping = [];
  const interceptionErrors = [];
  const tasks = new Set();
  const requestByNetwork = new Map();
  let current;
  let halted = false;
  let completedPlan = false;
  const halt = () => { halted = true; };

  return adapter.withTransport(async transport => {
    const accountResponse = async metadata => {
      const record = requestByNetwork.get(metadata.requestId);
      if (!record) { halted = true; return; }
      if (record.accounted || record.accounting) return;
      record.accounting = true;
      try {
        let cost = metadata.cost;
        let generation = null;
        if (live && metadata.responseId) {
          for (let attempt = 0; attempt < 3; attempt += 1) {
            try {
              const response = await transport({ generationId: metadata.responseId });
              if (response.ok) { generation = (await response.json()).data; break; }
              if (response.status !== 404) break;
            } catch { break; }
            await new Promise(resolve => setTimeout(resolve, 500));
          }
        }
        if (cost === null && typeof generation?.total_cost === 'number') cost = generation.total_cost;
        record.cost = live ? cost : null;
        record.actualProvider = typeof generation?.provider_name === 'string' ? generation.provider_name : metadata.provider;
        record.inputTokens = metadata.inputTokens ?? generation?.native_tokens_prompt ?? null;
        record.outputTokens = metadata.outputTokens ?? generation?.native_tokens_completion ?? null;
        record.cachedTokens = metadata.cachedTokens;
        record.reasoningTokens = metadata.reasoningTokens ?? generation?.native_tokens_reasoning ?? null;
        if (live) {
          record.reasoningAccepted = experiment.reasoningAccepted(record);
          if (!record.reasoningAccepted && experiment.haltOnReasoningFailure) halted = true;
        }
        record.httpStatus = metadata.status;
        budget.settle(record.ledgerId, cost);
        record.accounted = true;
      } catch {
        halted = true;
        try { budget.settle(record.ledgerId, null); } catch {}
      } finally {
        delete record.accounting;
      }
      try { save(`accounting-${randomUUID()}.json`, { synthetic: !live, budget: budget.snapshot(), request: record }); }
      catch (error) { halted = true; throw error; }
    };
    const request = ({ body, networkId, fulfill, fail }) => {
      const run = current;
      const task = (async () => {
        if (!run?.acceptingRequests || halted || budget.snapshot().frozen) throw new Error('Unexpected worker request.');
        const repair = run.flow === 'inline' ? JSON.parse(body.input).records.some(record => record.repair)
          : body.instructions.includes('The previous answer to this same input was refused:') ||
            run.initialInputs.some(input => input !== body.input && input.includes(body.input));
        const record = { model: body.model, reasoning: body.reasoning, provider: body.provider, store: body.store,
          phase: repair ? 'repair' : 'initial', inputHash: hash(JSON.stringify({ instructions: body.instructions, input: body.input, text: body.text })),
          maxOutputTokens: body.max_output_tokens, inputBytes: Buffer.byteLength(JSON.stringify(body)), cost: null };
        if (!repair && run.flow === 'sidepanel') run.initialInputs.push(body.input);
        run.requests.push(record);
        experiment.validateRequest(body, run, record);
        if (!networkId) throw new Error('Live accounting unavailable.');
        record.ledgerId = experiment.kind === 'model-quality' && live ? `${session}:${networkId}` : networkId;
        record.reservedUsd = budget.reserve(record.ledgerId, body.max_output_tokens);
        record.networkId = networkId;
        requestByNetwork.set(networkId, record);
        save(`reservation-${randomUUID()}.json`, { synthetic: !live, runId: run.id, budget: budget.snapshot(), request: record });
        const response = await transport({ body, flow: run.flow });
        const text = await response.text();
        let data = null;
        try { data = JSON.parse(text); } catch {}
        experiment.validateResponse(data, body, run, record, { live });
        const fulfilled = await fulfill({ status: response.status, text });
        if (fulfilled?.__error || fulfilled?.__timeout) {
          if (live) halted = true;
          else interceptionErrors.push('mock-fulfillment-failed');
        }
        if (live) await accountResponse(getResponseMetadata(data, networkId, response.status));
      })().catch(async () => {
        halted = true;
        interceptionErrors.push('request-interception-or-budget-failed');
        await fail();
      }).finally(() => tasks.delete(task));
      tasks.add(task);
      return task;
    };
    const drain = async () => {
      try {
        await Promise.allSettled([...tasks]);
        await adapter.settle(() => [...requestByNetwork.values()].every(record => record.accounted === true) || halted || budget.snapshot().frozen);
        await Promise.allSettled([...tasks]);
      } finally {
        for (const record of requestByNetwork.values()) {
          if (record.accounted !== true) {
            halted = true;
            try { budget.settle(record.ledgerId, null); } catch {}
          }
        }
      }
    };
    try {
      save('execution.json', { session, experiment: `${experiment.kind}-${live ? 'live' : 'mock'}` });
      await adapter.prepare({ experiment, session, save, request, accountResponse, halt,
        isHalted: () => halted, hasPendingRequests: () => tasks.size > 0,
        interceptionErrors, records, settleRequests: drain });
      for (const entry of experiment.plan) {
        if (halted || budget.snapshot().frozen) break;
        current = { ...entry, success: false, cacheHit: false, requests: [], initialInputs: [], elapsedMs: 0, acceptingRequests: false };
        current.acceptingRequests = true;
        const observation = await adapter.execute(entry, current);
        current.acceptingRequests = false;
        await drain();
        delete current.initialInputs;
        current.cacheHit = current.requests.length === 0;
        current.qualityAccepted = null;
        experiment.qualify(current, { live });
        const reviewId = randomUUID();
        reviews.push({ reviewId, mode: live ? 'live-pending-blind-review' : 'mock-only-not-a-quality-result',
          page: entry.page, flow: entry.flow, source: observation.source, translated: observation.translated });
        mapping.push({ reviewId, runId: entry.id });
        records.push(current);
        save(`${reviewId}.review.json`, reviews.at(-1));
        save(`${reviewId}.mapping.json`, mapping.at(-1));
        console.log(`${current.success ? 'PASS' : 'FAIL'} routing pilot ${live ? 'live' : 'mock'} ${entry.id} requests=${current.requests.length}${live ? ` spentUsd=${budget.snapshot().spentUsd}` : ''}`);
        save(`${entry.id}.json`, current);
        if (!observation.complete || experiment.census && !current.success) {
          save(`${entry.id}.failure.json`, { ...observation.failure, interceptionErrors });
          if (!live) throw new Error('Mock translation failed; partial evidence retained.');
        }
      }
      const completePlan = records.length === experiment.plan.length && !halted && !budget.snapshot().frozen && budget.snapshot().reservedUsd === 0 &&
        (!experiment.census || live || records.every(record => record.success));
      const observer = adapter.evidence();
      const summary = experiment.summarize(records, observer, { live, completePlan });
      if (!live && interceptionErrors.length) throw new Error('Interception errors; mock results invalid.');
      completedPlan = completePlan;
      save('summary.json', { mode: live ? 'live' : 'mock-only', meaning: live ? 'Structural outcomes; semantic quality pending blinded review.' : 'No live latency, translation quality, provider selection or billing measured.',
        completePlan, syntheticBudget: !live, budget: budget.snapshot(), reportedReasoningTokens: live ? observer.reasoningTokens : null,
        corpus: experiment.corpus, ...summary, records, interceptionErrors,
        partialBlocks: records.filter(record => record.flow === 'inline').reduce((sum, record) => sum + record.outcomes.partial, 0),
        finalFailedBlocks: records.filter(record => record.flow === 'inline').reduce((sum, record) => sum + record.outcomes.failed, 0),
        requestInputBytes: records.flatMap(run => run.requests).reduce((sum, record) => sum + record.inputBytes, 0),
        requestedOutputTokenCaps: records.flatMap(run => run.requests).reduce((sum, record) => sum + record.maxOutputTokens, 0) });
      save('blinded-review.json', reviews.sort((a, b) => a.reviewId.localeCompare(b.reviewId)));
      save('review-mapping.json', mapping);
      return { completePlan: completedPlan, ...(experiment.census ? { records, budget: budget.snapshot() } : {}) };
    } finally {
      const interrupted = halted;
      halted = true;
      if (current) current.acceptingRequests = false;
      try { await drain(); }
      finally {
        try {
          save('completion.json', { live, browserCredential: 'synthetic-only', budget: budget.snapshot(), halted: interrupted,
            completePlan: completedPlan, completedRuns: records.length });
        } finally { await adapter.close(); }
      }
    }
  });
}
