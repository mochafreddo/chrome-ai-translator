import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { browser, launchExtensionBrowser, serveFixture, until } from './harness.mjs';
import { observeModelRequests, getResponseMetadata } from './model-request-evidence.mjs';
import { inlinePanelControlsReady } from './inline-panel-readiness.mjs';
import { buildPlan, summarize, routeRequest } from './routing-pilot.mjs';
import { withOpenRouterTransport } from './live-key.mjs';
import { createBudget, PRICE_CAP } from './routing-budget.mjs';
import { buildQualityPlan, adaptQualityRequest, validateQualityRequest, validateQualityOutput } from './model-quality.mjs';

const { createTranslationChunks } = createRequire(import.meta.url)('../../extension/translation-chunks.js');
const { renderCode, renderDestination, escapeMarkdownLinkLabel } = createRequire(import.meta.url)('../../extension/markdown-entries.js');
const { parseCompletedResponse } = createRequire(import.meta.url)('../../extension/openai-response.js');

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CORPUS = join(ROOT, 'tests/integration/fixtures/routing-pilot');
const hash = value => createHash('sha256').update(value).digest('hex');
export async function runPilot({ output, live = false, inputTokenLimit = null, budgetUsd = 2, qualityCorpus = null,
  qualityLive = false, sharedBudget = null, profileKeys = undefined, planIds = null }) {
  if (qualityCorpus && live && !qualityLive) throw new Error('Model quality preparation has no live mode.');
  if (qualityLive && (!qualityCorpus || !live || !sharedBudget || sharedBudget.snapshot().limitUsd !== 5)) {
    throw new Error('Model quality live execution requires the approved shared USD 5 ledger.');
  }
  const budget = sharedBudget || createBudget({ limitUsd: budgetUsd,
    inputTokenLimit: live ? inputTokenLimit : 1048576 });
  process.umask(0o077);
  mkdirSync(output, { mode: 0o700 });
  const save = (name, data) => writeFileSync(join(output, name), JSON.stringify(data, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  const session = `rp-${randomUUID().slice(0, 8)}`;
  save('execution.json', { session, experiment: qualityCorpus ? qualityLive ? 'model-quality-live' : 'model-quality-mock' : live ? 'routing-live' : 'routing-mock' });
  const servers = {};
  let ctx;
  let observer;
  let unsubscribe;
  let stopContexts;
  let current;
  const records = [];
  const sourceEvidence = new Set();
  const reviews = [];
  const mapping = [];
  const interceptionErrors = [];
  const tasks = new Set();
  const requestByNetwork = new Map();
  let transport;
  let stopWorker;
  let halted = false;
  let completedPlan = false;
  try {
    const corpus = qualityCorpus || JSON.parse(readFileSync(join(CORPUS, 'corpus.json')));
    const plan = qualityCorpus ? buildQualityPlan(corpus.pages.map(page => page.id), profileKeys, planIds) : buildPlan();
    for (const page of corpus.pages) {
      const filename = page.file || join(CORPUS, `${page.id}.html`);
      if (hash(readFileSync(filename)) !== page.sha256) throw new Error('Frozen corpus fingerprint mismatch.');
      servers[page.id] = await serveFixture(filename);
    }
    const firstPage = corpus.pages[0].id;
    ctx = await launchExtensionBrowser({ session, url: servers[firstPage].url, extensionDir: join(ROOT, 'extension') });
    const workerTarget = await ctx.findTarget(target => target.type === 'service_worker' && target.url.startsWith(`chrome-extension://${ctx.extension.id}/`));
    if (!workerTarget) throw new Error('Missing extension worker.');
    const worker = await ctx.attach(workerTarget.id, 'service_worker');
    stopWorker = ctx.cdp.on('Target.targetDestroyed', event => { if (event.targetId === workerTarget.id) halted = true; });
    unsubscribe = ctx.cdp.on('Fetch.requestPaused', (event, sourceSession) => {
      if (sourceSession !== worker.sessionId) return;
      const run = current;
      const task = (async () => {
        if (event.request.url === 'https://openrouter.ai/api/v1/responses' && event.request.method === 'OPTIONS') {
          const result = await ctx.cdp.send('Fetch.fulfillRequest', {
            requestId: event.requestId, responseCode: 204,
            responseHeaders: [{ name: 'Access-Control-Allow-Origin', value: '*' },
              { name: 'Access-Control-Allow-Methods', value: 'POST, OPTIONS' },
              { name: 'Access-Control-Allow-Headers', value: 'Content-Type, Authorization' }],
          }, sourceSession);
          if (result.__error || result.__timeout) interceptionErrors.push('preflight-fulfillment-failed');
          return;
        }
        if (!run || !run.acceptingRequests || event.request.url !== 'https://openrouter.ai/api/v1/responses' || event.request.method !== 'POST') {
          interceptionErrors.push('unexpected-worker-request');
          await ctx.cdp.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'BlockedByClient' }, sourceSession);
          return;
        }
        const body = JSON.parse(event.request.postData);
        const repair = run.flow === 'inline'
          ? JSON.parse(body.input).records.some(record => record.repair)
          : body.instructions.includes('The previous answer to this same input was refused:') ||
            run.initialInputs.some(input => input !== body.input && input.includes(body.input));
        const requestRecord = { model: body.model, reasoning: body.reasoning, provider: body.provider, store: body.store,
          phase: repair ? 'repair' : 'initial',
          inputHash: hash(JSON.stringify({ instructions: body.instructions, input: body.input, text: body.text })),
          maxOutputTokens: body.max_output_tokens, inputBytes: Buffer.byteLength(JSON.stringify(body)), cost: null };
        if (!repair && run.flow === 'sidepanel') run.initialInputs.push(body.input);
        run.requests.push(requestRecord);
        {
          if (qualityCorpus) {
            validateQualityRequest(body, run.profileKey);
            requestRecord.input = body.input;
            if (run.flow === 'inline') {
              requestRecord.blockKeys = JSON.parse(body.input).records.map(record => {
                if (!run.expected.blocks.some(block => block.template === record.template &&
                    JSON.stringify(block.atoms) === JSON.stringify(record.atoms))) throw new Error('Uncensused source before transport.');
                return JSON.stringify({ template: record.template, atoms: record.atoms });
              });
            }
          } else {
            const baseline = { ...body, provider: { ...body.provider } };
            if (run.policy === 'throughput') delete baseline.provider.sort;
            const expected = routeRequest(baseline, run.policy);
            if (JSON.stringify(expected) !== JSON.stringify(body) || !body.provider.max_price ||
                body.tools || body.plugins || typeof body.input !== 'string') throw new Error('Live request invariants failed.');
          }
          if (halted || !event.networkId) throw new Error('Live accounting unavailable.');
          requestRecord.ledgerId = qualityLive ? `${session}:${event.networkId}` : event.networkId;
          requestRecord.reservedUsd = budget.reserve(requestRecord.ledgerId, body.max_output_tokens);
          requestRecord.networkId = event.networkId;
          requestByNetwork.set(event.networkId, requestRecord);
          save(`reservation-${randomUUID()}.json`, { synthetic: !live, runId: run.id, budget: budget.snapshot(), request: requestRecord });
          if (live) {
            const response = await transport({ body });
            const text = await response.text();
            let data = null;
            try { data = JSON.parse(text); } catch {}
            if (qualityCorpus && run.flow === 'inline') {
              try {
                validateQualityOutput(parseCompletedResponse(data), JSON.parse(body.input).records.map(record => {
                  const source = run.expected.blocks.find(block => block.template === record.template &&
                    JSON.stringify(block.atoms) === JSON.stringify(record.atoms));
                  if (!source) throw new Error('Uncensused source record.');
                  return { ...record, contract: source.contract };
                }), { structure: false });
                requestRecord.contractAccepted = true;
              } catch { requestRecord.contractAccepted = false; }
            }
            const fulfilled = await ctx.cdp.send('Fetch.fulfillRequest', {
              requestId: event.requestId, responseCode: response.status,
              responseHeaders: [{ name: 'Content-Type', value: 'application/json' }, { name: 'Access-Control-Allow-Origin', value: '*' }],
              body: Buffer.from(text).toString('base64'),
            }, sourceSession);
            if (fulfilled.__error || fulfilled.__timeout) halted = true;
            await accountResponse(getResponseMetadata(data, event.networkId, response.status));
            return;
          }
        }
        const outputText = run.flow === 'inline'
          ? JSON.stringify({ translations: JSON.parse(body.input).records.map(record => ({ id: record.id,
            template: `모의 응답입니다. ${record.template}` })) })
          : `모의 응답입니다.\n${body.input}`;
        if (qualityCorpus && run.flow === 'inline') {
          validateQualityOutput(outputText, JSON.parse(body.input).records.map(record => {
            const source = run.expected.blocks.find(block => block.template === record.template &&
              JSON.stringify(block.atoms) === JSON.stringify(record.atoms));
            if (!source) throw new Error('Request contains an uncensused block.');
            return { ...record, contract: source.contract };
          }));
        }
        const result = await ctx.cdp.send('Fetch.fulfillRequest', {
          requestId: event.requestId, responseCode: 200,
          responseHeaders: [{ name: 'Content-Type', value: 'application/json' }, { name: 'Access-Control-Allow-Origin', value: '*' }],
          body: Buffer.from(JSON.stringify({ status: 'completed', model: body.model,
            usage: { cost: 0.0001, output_tokens_details: { reasoning_tokens: 0 } },
            output: [{ type: 'message', content: [{ type: 'output_text', text: outputText }] }] })).toString('base64'),
        }, sourceSession);
        if (result.__error || result.__timeout) interceptionErrors.push('mock-fulfillment-failed');
      })().catch(async () => {
        halted = true;
        interceptionErrors.push('request-interception-or-budget-failed');
        await ctx.cdp.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'BlockedByClient' }, sourceSession);
      }).finally(() => tasks.delete(task));
      tasks.add(task);
    });
    const enabled = await ctx.cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] }, worker.sessionId);
    if (enabled.__error || enabled.__timeout) throw new Error('Worker interception unavailable.');
    const injected = await worker.evaluate(`(() => {
      const original = globalThis.fetch;
      const adapt = ${adaptQualityRequest.toString()};
      globalThis.fetch = (url, init) => {
        if (url === 'https://openrouter.ai/api/v1/responses') {
          let body = JSON.parse(init.body);
          if (${Boolean(qualityCorpus)}) body = adapt(body, globalThis.modelQualityProfile);
          else {
            body.provider.max_price = ${JSON.stringify(PRICE_CAP)};
            if (globalThis.routingPilotPolicy === 'throughput') body.provider.sort = 'throughput';
          }
          return original.call(globalThis, url, { ...init, body: JSON.stringify(body) });
        }
        return original.call(globalThis, url, init);
      };
      return true;
    })()`);
    if (!injected) throw new Error('Disposable worker routing adapter unavailable.');
    const accountResponse = async metadata => {
        const record = requestByNetwork.get(metadata.requestId);
        if (!record) { halted = true; return; }
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
          if (live && (!qualityCorpus ? record.reasoningTokens !== 0 :
              !Number.isInteger(record.reasoningTokens) || record.reasoningTokens < 0 ||
                ((record.reasoning.effort === 'none' || record.reasoning.enabled === false) && record.reasoningTokens !== 0))) {
            record.reasoningAccepted = false;
            if (!qualityCorpus) halted = true;
          } else if (live) record.reasoningAccepted = true;
          record.httpStatus = metadata.status;
          budget.settle(record.ledgerId || metadata.requestId, cost);
          record.accounted = true;
        } catch { halted = true; try { budget.settle(record.ledgerId || metadata.requestId, null); } catch {} }
        finally {
          save(`accounting-${randomUUID()}.json`, { synthetic: !live, budget: budget.snapshot(), request: record });
        }
    };
    observer = await observeModelRequests(ctx.cdp, worker.sessionId, { reasoningUsage: true,
      onResponse: async metadata => { if (!live) await accountResponse(metadata); },
    });
    const options = ctx.page;
    await options.navigate(`chrome-extension://${ctx.extension.id}/options.html`);
    const executeEntries = async () => {
    await options.evaluate(`chrome.tabs.create({ url: ${JSON.stringify(servers[firstPage].url)}, active: true }).then(tab => tab.id)`);
    const sourceTarget = await ctx.findTarget(target => target.type === 'page' && target.url === servers[firstPage].url);
    if (!sourceTarget) throw new Error('Missing source page.');
    const page = await ctx.attach(sourceTarget.id);
    const contexts = new Set();
    const contextListeners = [
      ctx.cdp.on('Runtime.executionContextCreated', (event, sourceSession) => {
        if (sourceSession === page.sessionId && event.context.auxData?.isDefault === false) contexts.add(event.context.id);
      }),
      ctx.cdp.on('Runtime.executionContextsCleared', (_event, sourceSession) => {
        if (sourceSession === page.sessionId) contexts.clear();
      }),
      ctx.cdp.on('Runtime.executionContextDestroyed', (event, sourceSession) => {
        if (sourceSession === page.sessionId) contexts.delete(event.executionContextId);
      }),
    ];
    stopContexts = () => contextListeners.forEach(stop => stop());
    const runtime = await ctx.cdp.send('Runtime.enable', {}, page.sessionId);
    if (runtime.__error || runtime.__timeout) throw new Error('Page execution context observation unavailable.');
    const viewport = await ctx.cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1280, height: 12000, deviceScaleFactor: 1, mobile: false,
    }, page.sessionId);
    if (viewport.__error || viewport.__timeout) throw new Error('Full-corpus viewport unavailable.');
    for (const entry of plan) {
      if (halted || budget?.snapshot().frozen) break;
      current = { ...entry, success: false, cacheHit: false, requests: [], initialInputs: [], elapsedMs: 0, acceptingRequests: false };
      if (qualityCorpus) {
        const navigation = await ctx.cdp.send('Page.navigate', { url: servers[entry.page].url }, page.sessionId);
        const ready = navigation.loaderId && !navigation.errorText && await until(async () => {
          const tree = await ctx.cdp.send('Page.getFrameTree', {}, page.sessionId);
          return tree.frameTree?.frame.loaderId === navigation.loaderId && await page.evaluate(
            `document.readyState === 'complete' && Boolean(document.querySelector('article, main')) && globalThis.routingPilotDocument === undefined`);
        }, 10000, 50);
        if (!ready) {
          save('navigation-failure.json', { entry: entry.id, navigation,
            frame: (await ctx.cdp.send('Page.getFrameTree', {}, page.sessionId)).frameTree?.frame,
            state: await page.evaluate(`({ ready: document.readyState, root: Boolean(document.querySelector('article, main')),
              oldDocumentMarker: globalThis.routingPilotDocument !== undefined })`) });
          throw new Error('Fresh corpus navigation did not complete.');
        }
      } else await page.navigate(servers[entry.page].url);
      const documentId = randomUUID();
      if (!await page.evaluate(`(() => {
        if (globalThis.routingPilotDocument !== undefined) return false;
        globalThis.routingPilotDocument = ${JSON.stringify(documentId)};
        return true;
      })()`)) throw new Error('Fresh page unavailable; cache isolation is unproven.');
      const before = await page.evaluate('(document.querySelector("article") || document.querySelector("main")).innerText');
      await worker.evaluate(`globalThis.routingPilotPolicy = ${JSON.stringify(entry.policy)}`);
      if (qualityCorpus) await worker.evaluate(`globalThis.modelQualityProfile = ${JSON.stringify(entry.profile)}`);
      const tabs = await ctx.cdp.send('Target.getTargets', { filter: [{ type: 'tab' }] });
      const tab = tabs.targetInfos?.find(target => target.url === servers[entry.page].url);
      if (!tab) throw new Error('Missing translation tab.');
      const triggered = await ctx.cdp.send('Extensions.triggerAction', { id: ctx.extension.id, targetId: tab.targetId });
      if (triggered.__error || triggered.__timeout) throw new Error('Toolbar preparation failed.');
      if (!await until(() => ctx.findTarget(target => target.url === `chrome-extension://${ctx.extension.id}/sidepanel.html`), 10000, 100)) throw new Error('Missing side panel.');
      const panelTarget = await ctx.findTarget(target => target.url === `chrome-extension://${ctx.extension.id}/sidepanel.html`);
      const panel = await ctx.attach(panelTarget.id);
      if (!await until(() => inlinePanelControlsReady(panel), 10000, 100)) throw new Error('Panel controls unavailable.');
      if (entry.flow === 'sidepanel' || qualityCorpus) {
        const fixedNamespace = await until(async () => {
        for (const contextId of contexts) {
          const result = await ctx.cdp.send('Runtime.evaluate', { contextId, returnByValue: true, expression: `(() => {
          const codec = globalThis.ChromeAiTranslatorMarkdownDocument;
          const namespace = 'CAT_00000000-0000-4000-8000-000000000000';
          if (!codec || (document.querySelector('article') || document.querySelector('main')).textContent.includes(namespace)) return false;
          const wrap = module => {
            const original = module.serializeMarkdownDocument;
            module.serializeMarkdownDocument = (root, metadata, options) =>
              original(root, metadata, { ...options, namespace });
            return module;
          };
          let currentCodec = wrap(codec);
          Object.defineProperty(globalThis, 'ChromeAiTranslatorMarkdownDocument', {
            configurable: true,
            get: () => currentCodec,
            set: module => { currentCodec = wrap(module); },
          });
          return true;
        })()` }, page.sessionId);
          if (result.result?.value === true) return true;
        }
        return false;
        }, 10000, 50);
        if (!fixedNamespace) throw new Error('Paired placeholder namespace could not be fixed safely.');
      }
      let qualityContext;
      if (qualityCorpus) {
        const censusErrors = [];
        const height = await page.evaluate('document.documentElement.scrollHeight');
        const resized = await ctx.cdp.send('Emulation.setDeviceMetricsOverride', {
          width: 1280, height: Math.max(12000, Math.ceil(height) + 100), deviceScaleFactor: 1, mobile: false,
        }, page.sessionId);
        if (resized.__error || resized.__timeout) throw new Error('Whole-document mock viewport unavailable.');
        for (const contextId of contexts) {
          const result = await ctx.cdp.send('Runtime.evaluate', { contextId, awaitPromise: true, returnByValue: true,
            expression: `(async () => { const readProtectedPage = ${readProtectedPage.toString()};
              const prepareQualityPage = ${prepareQualityPage.toString()};
              const negativeChecks = ${records.length === 0} ? await (${probeQualityCensus.toString()})() : null;
              const value = await prepareQualityPage(); return value && { ...value, negativeChecks }; })()` }, page.sessionId);
          if (result.exceptionDetails) censusErrors.push(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
          if (result.__error || result.__timeout) censusErrors.push(result.__error || 'census evaluation timed out');
          if (result.result?.value?.blocks) { qualityContext = contextId; current.expected = result.result.value; break; }
        }
        if (!qualityContext) { save(`${entry.id}.census-failure.json`, { censusErrors }); throw new Error('Whole-document source census unavailable.'); }
        if (current.expected.negativeChecks) save('source-census-negative-checks.json', current.expected.negativeChecks);
        const sourceKey = `${entry.page}-${entry.flow}`;
        if (!sourceEvidence.has(sourceKey)) {
          save(`source-${sourceKey}.json`, current.expected);
          sourceEvidence.add(sourceKey);
        }
        current.expectedChunks = createTranslationChunks(current.expected.extraction.translationDocument, 12000).map(chunk => chunk.template);
        const spy = await ctx.cdp.send('Runtime.evaluate', { contextId: qualityContext, returnByValue: true, expression: `(() => {
          const codec = globalThis.ChromeAiTranslatorInlineBlock;
          const apply = codec.applyTranslatedTemplate;
          globalThis.modelQualityApplied = new Map();
          codec.applyTranslatedTemplate = (snapshot, template) => {
            const result = apply(snapshot, template);
            if (result.ok) globalThis.modelQualityApplied.set(snapshot.blockElement, snapshot);
            return result;
          };
          return true;
        })()` }, page.sessionId);
        if (spy.result?.value !== true) throw new Error('Application evidence hook unavailable.');
      }
      const started = performance.now();
      const button = entry.flow === 'inline' ? 'btnInlineTranslate' : 'btnTranslate';
      current.acceptingRequests = true;
      await panel.evaluate(`document.getElementById(${JSON.stringify(button)}).click()`);
      let complete;
      if (entry.flow === 'inline') {
        complete = await until(async () => {
          if (halted) return true;
          await page.evaluate('window.scrollTo(0, document.body.scrollHeight)');
          return await panel.evaluate(`(() => {
            const status = document.getElementById('inlineStatus').textContent;
            return status.startsWith('Visible translation on') && /Pending 0(?:\\D|$)/.test(status);
          })()`) && current.requests.length > 0 && (live || tasks.size === 0) &&
            (qualityCorpus ? coverageMatches(current) : await page.evaluate(`Array.from(document.querySelectorAll('article p, article h1, article h2, article li'))
              .filter(node => node.textContent.trim()).every(node => /[가-힣]/.test(node.textContent))`) ||
              (live && await panel.evaluate('/Failed [1-9]/.test(document.getElementById("inlineStatus").textContent)')));
        }, live ? 240000 : 20000, 100);
      } else {
        await until(async () => halted || await panel.evaluate("document.getElementById('status').textContent === 'Done' || !document.getElementById('errorBox').hidden"), live ? 240000 : 20000, 100);
        complete = await panel.evaluate("document.getElementById('status').textContent === 'Done'");
      }
      complete = complete && !halted;
      current.elapsedMs = performance.now() - started;
      if (qualityCorpus && entry.flow === 'inline' && !await until(async () => {
        const status = await panel.evaluate("document.getElementById('inlineStatus').textContent");
        const counts = Object.fromEntries(['translated', 'partial', 'pending', 'changed', 'failed'].map(label => {
          const match = new RegExp(`${label} (\\d+)`, 'i').exec(status);
          return [label, match ? Number(match[1]) : null];
        }));
        return inlineQualityCompleted(counts, current.expected.blocks.length, true);
      }, 10000, 50)) complete = false;
      current.acceptingRequests = false;
      if (!complete) {
        const terminalFailure = entry.flow === 'inline' && qualityCorpus
          ? inlineQualityTerminal(await panel.evaluate(`(() => {
              const status = document.getElementById('inlineStatus').textContent;
              return Object.fromEntries(['translated', 'partial', 'pending', 'changed', 'failed'].map(label => {
                const match = new RegExp(label + ' (\\\\d+)', 'i').exec(status);
                return [label, match ? Number(match[1]) : null];
              }));
            })()`), current.expected.blocks.length)
          : entry.flow === 'sidepanel' && await panel.evaluate("!document.getElementById('errorBox').hidden");
        if (!terminalFailure) halted = true;
        if (entry.flow === 'inline') await panel.evaluate("document.getElementById('btnInlineStop').click()");
      }
      await until(async () => {
        await Promise.all([...tasks]);
        await observer.settle();
        return (tasks.size === 0 && current.requests.every(request => request.accounted === true)) || halted || budget.snapshot().frozen;
      }, 45000, 100);
      for (const request of current.requests.filter(request => request.accounted !== true)) {
        halted = true;
        if (request.networkId) { try { budget.settle(request.ledgerId || request.networkId, null); } catch {} }
      }
      delete current.initialInputs;
      current.success = Boolean(complete);
      current.cacheHit = current.requests.length === 0;
      current.documentId = documentId;
      current.qualityAccepted = null;
      if (qualityCorpus) {
        current.coverage = { expectedBlocks: current.expected.blocks.length, expectedChunks: current.expectedChunks.length,
          census: current.expected.census,
          matched: coverageMatches(current) };
        if (entry.flow === 'inline') {
          const protectionResult = await ctx.cdp.send('Runtime.evaluate', { contextId: qualityContext, returnByValue: true,
            expression: `({ protected: (${readProtectedPage.toString()})(pickArticleRoot()),
              applied: globalThis.modelQualityExpectedNodes.every(node => node.isConnected &&
                globalThis.modelQualityApplied.has(node) && globalThis.ChromeAiTranslatorInlineBlock.matchesAppliedOwnership(
                  globalThis.modelQualityApplied.get(node))) })` }, page.sessionId);
          current.protectedContent = JSON.stringify(protectionResult.result?.value?.protected) === JSON.stringify(current.expected.protected);
          current.appliedAllBlocks = protectionResult.result?.value?.applied === true;
        } else {
          const displayed = await panel.evaluate("document.getElementById('translated').textContent");
          current.protectedContent = protectedMarkdownMatches(current.expected.extraction, displayed);
          if (!current.protectedContent) save(`${entry.id}.protected-failure.json`, {
            extraction: current.expected.extraction, displayed });
        }
        current.displayedProse = qualityLive ? null : mockDisplayedProseMatches(current.expected.census.prosePieces,
          entry.flow === 'inline' ? await page.evaluate('(document.querySelector("article") || document.querySelector("main")).innerText') :
            await panel.evaluate("document.getElementById('translated').textContent"));
        if (!current.coverage.matched || !current.protectedContent) current.success = false;
        if (!qualityLive && !current.displayedProse) current.success = false;
        if (qualityLive && current.requests.some(request => request.reasoningAccepted !== true || request.contractAccepted === false)) current.success = false;
        if (entry.flow === 'inline' && !current.appliedAllBlocks) current.success = false;
        delete current.expected;
        delete current.expectedChunks;
      }
      const status = await panel.evaluate('document.getElementById("inlineStatus").textContent');
      current.outcomes = entry.flow === 'inline' ? Object.fromEntries(
        ['Translated', 'Partial', 'Pending', 'Changed', 'Failed'].map(label => {
          const match = new RegExp(`${label} (\\d+)`).exec(status);
          return [label.toLowerCase(), match ? Number(match[1]) : null];
        })
      ) : { documentDisplayed: current.success };
      if ((live || qualityCorpus) && entry.flow === 'inline' &&
          (current.outcomes.failed || current.outcomes.changed || current.outcomes.pending)) current.success = false;
      if (qualityCorpus && entry.flow === 'inline' &&
          !inlineQualityCompleted(current.outcomes, current.coverage.expectedBlocks, current.appliedAllBlocks)) current.success = false;
      const translated = await (entry.flow === 'inline' ? page.evaluate('(document.querySelector("article") || document.querySelector("main")).innerText') : panel.evaluate('document.getElementById("translated").textContent'));
      if (qualityLive) {
        current.targetLanguagePresent = /[가-힣]/.test(translated);
        if (!current.targetLanguagePresent) current.success = false;
      }
      const reviewId = randomUUID();
      reviews.push({ reviewId, mode: live ? 'live-pending-blind-review' : 'mock-only-not-a-quality-result', page: entry.page, flow: entry.flow, source: before, translated });
      mapping.push({ reviewId, runId: entry.id });
      records.push(current);
      save(`${reviewId}.review.json`, reviews.at(-1));
      save(`${reviewId}.mapping.json`, mapping.at(-1));
      console.log(`${current.success ? 'PASS' : 'FAIL'} routing pilot ${live ? 'live' : 'mock'} ${entry.id} requests=${current.requests.length}${live ? ` spentUsd=${budget.snapshot().spentUsd}` : ''}`);
      save(`${entry.id}.json`, current);
      if (!complete || (qualityCorpus && !current.success)) {
        const state = await panel.evaluate(`({sidepanel:document.getElementById('status').textContent,
          inline:document.getElementById('inlineStatus').textContent,inlineError:document.getElementById('inlineError').textContent,
          panelError:document.getElementById('errorBox').textContent})`);
        save(`${entry.id}.failure.json`, { ...state, interceptionErrors });
        if (!live) throw new Error('Mock translation failed; partial evidence retained.');
      }
    }
    const completePlan = records.length === plan.length && !halted && !budget.snapshot().frozen && budget.snapshot().reservedUsd === 0 &&
      (!qualityCorpus || qualityLive || records.every(record => record.success));
    completedPlan = completePlan;
    let summary;
    let comparisonEligible = completePlan;
    try { summary = qualityCorpus ? summarizeQuality(records, observer, { live: qualityLive }) : completePlan ? summarize(records) : { groups: [], incomplete: true }; }
    catch (error) {
      if (qualityCorpus) { completedPlan = false; throw error; }
      comparisonEligible = false;
      try { summary = summarize(records, { allowFailedCoverage: true }); }
      catch { summary = { groups: [], incomplete: true }; }
    }
    if (qualityLive && summary.initialInputsMatched === false) comparisonEligible = false;
    if (!live && interceptionErrors.length) {
      completedPlan = false;
      throw new Error('Interception errors; mock results invalid.');
    }
    save('summary.json', { mode: live ? 'live' : 'mock-only', meaning: live ? 'Structural outcomes; semantic quality pending blinded review.' : 'No live latency, translation quality, provider selection or billing measured.',
      completePlan, comparisonEligible, syntheticBudget: !live, budget: budget.snapshot(),
      reportedReasoningTokens: live ? observer.reasoningTokens : null,
      corpus, ...summary, records, interceptionErrors,
      partialBlocks: records.filter(record => record.flow === 'inline').reduce((sum, record) => sum + record.outcomes.partial, 0),
      finalFailedBlocks: records.filter(record => record.flow === 'inline').reduce((sum, record) => sum + record.outcomes.failed, 0),
      requestInputBytes: records.flatMap(run => run.requests).reduce((sum, request) => sum + request.inputBytes, 0),
      requestedOutputTokenCaps: records.flatMap(run => run.requests).reduce((sum, request) => sum + request.maxOutputTokens, 0) });
    save('blinded-review.json', reviews.sort((a, b) => a.reviewId.localeCompare(b.reviewId)));
    save('review-mapping.json', mapping);
    };
    const executeWithSyntheticKey = async () => {
    await options.evaluate(`(() => {
      const service = document.querySelector('input[name="service"][value="openrouter"]');
      service.checked = true; service.dispatchEvent(new Event('change'));
      document.getElementById('apiKey').value = 'routing-pilot-synthetic-not-a-real-key';
      document.getElementById('targetLanguage').value = 'Korean';
      document.getElementById('tone').value = 'technical';
      document.querySelector('input[name="buttonVisibility"][value="onInvocation"]').checked = true;
      document.getElementById('btnSave').click();
    })()`);
    if (!await until(() => options.evaluate("document.getElementById('status').textContent === 'Saved.'"), 5000, 100)) throw new Error('Synthetic settings did not save.');
      await executeEntries();
    };
    if (live) {
      await withOpenRouterTransport({ envPath: join(ROOT, '.env.local') }, async selectedTransport => {
        transport = selectedTransport;
        await executeWithSyntheticKey();
      });
    } else await executeWithSyntheticKey();

  } finally {
    const interrupted = halted;
    halted = true;
    await Promise.allSettled([...tasks]);
    try {
      save('completion.json', { live, browserCredential: 'synthetic-only', budget: budget.snapshot(), halted: interrupted, completePlan: completedPlan, completedRuns: records.length });
    } finally {
      transport = null;
      stopWorker?.(); stopContexts?.(); unsubscribe?.(); observer?.close(); ctx?.close();
      await browser(['close', '--session', session], 30000).catch(() => {});
      for (const server of Object.values(servers)) server.close();
    }
  }
  return { completePlan: completedPlan, ...(qualityCorpus ? { records, budget: budget.snapshot() } : {}) };
}

function readProtectedPage(root) {
  if (!root) return null;
  return {
    links: [...root.querySelectorAll('a[href]')].map(node => node.href).sort(),
    code: [...root.querySelectorAll('pre, code')].filter(node => node.tagName === 'PRE' || !node.closest('pre'))
      .map(node => node.tagName === 'PRE' ? node.textContent.replace(/\r\n/g, '\n').trimEnd() : node.textContent).sort(),
    codeEntries: [...root.querySelectorAll('pre, code')].filter(node => node.tagName === 'PRE' || !node.closest('pre')).map(node =>
      JSON.stringify({ value: node.tagName === 'PRE' ? node.textContent.replace(/\r\n/g, '\n').trimEnd() : node.textContent,
        display: node.tagName === 'PRE' ? 'block' : 'inline' })).sort(),
  };
}

async function prepareQualityPage() {
  if (typeof pickArticleRoot !== 'function' || typeof buildArticleExtraction !== 'function' ||
      !globalThis.ChromeAiTranslatorInlineViewport || !globalThis.ChromeAiTranslatorInlineBlock) return null;
  const root = pickArticleRoot();
  const codec = globalThis.ChromeAiTranslatorInlineBlock;
  const blocks = new Map();
  const admitted = new Map();
  const frozenRoot = document.querySelector('article') || document.querySelector('main');
  if (!frozenRoot || !(root === frozenRoot || root.contains(frozenRoot)) || frozenRoot.textContent.includes('모의 응답입니다.')) return null;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let textNodes = 0;
  while (walker.nextNode()) textNodes += 1;
  const scansNeeded = Math.ceil(textNodes / 1200) + 1;
  await new Promise((resolve, reject) => {
    let scans = 0;
    const scanner = globalThis.ChromeAiTranslatorInlineViewport.createInlineViewport({
      session: { operationId: 1, status: 'active', isCurrent: () => true, resetQueue() {},
        admit(node) {
          if (admitted.has(node)) return;
          const value = codec.serializeBlock(node);
          admitted.set(node, value);
          if (value.ok && value.contract.requiresText) blocks.set(node, {
            template: value.template, atoms: value.atoms, contract: value.contract,
          });
        } },
      onScan() {
        scans += 1;
        queueMicrotask(() => {
          if (scans >= scansNeeded) { clearTimeout(timer); scanner.stop(); resolve(); }
          else scanner.rescan();
        });
      },
    });
    const timer = setTimeout(() => { scanner.stop(); reject(new Error('Source census timed out.')); }, 10000);
    scanner.start(root);
  });
  const extraction = buildArticleExtraction(root, { title: document.title, url: location.href,
    langHint: document.documentElement.lang || '' });
  const normalize = value => String(value).replace(/⟦[^⟧]+⟧/g, '').replace(/\\([\\`*{}\[\]()#+\-.!_>])/g, '$1').replace(/\s+/g, ' ').trim();
  const markdown = normalize(extraction.contentMarkdown);
  const inventory = document.createTreeWalker(frozenRoot, NodeFilter.SHOW_TEXT);
  const protectedSource = readProtectedPage(frozenRoot);
  const entries = extraction.translationDocument.entries;
  const extractedLinks = entries.filter(entry => entry.destination).map(entry => entry.destination).sort();
  const extractedCode = entries.filter(entry => entry.kind === 'code').map(entry => JSON.stringify({
    value: entry.display === 'block' ? entry.value.replace(/\r\n/g, '\n').trimEnd() : entry.value,
    display: entry.display })).sort();
  const codeRemaining = [...extractedCode];
  const codeMinted = protectedSource.codeEntries.every(value => {
    const index = codeRemaining.indexOf(value);
    if (index < 0) return false;
    codeRemaining.splice(index, 1);
    return true;
  });
  const census = { proseNodes: 0, prosePieces: [], protectedNodes: 0, sourceSyntaxNodes: 0, inlineMissing: [], sidepanelMissing: [],
    protectedMinted: codeMinted && JSON.stringify(protectedSource.links) === JSON.stringify(extractedLinks),
    rejectedBlocks: [...admitted].filter(([, value]) => !value.ok).map(([node, value]) => ({ tag: node.tagName, error: value.error })) };
  const positions = new Map();
  let markdownPosition = 0;
  while (inventory.nextNode()) {
    const node = inventory.currentNode;
    const value = normalize(node.nodeValue);
    if (!/[A-Za-z]/.test(value)) continue;
    if (node.parentElement.closest('pre,code,kbd,samp,script,style')) { census.protectedNodes += 1; continue; }
    if (codec.isCodeLikeInlineText(value)) { census.sourceSyntaxNodes += 1; continue; }
    census.proseNodes += 1;
    census.prosePieces.push(value);
    const block = node.parentElement.closest('p,h1,h2,h3,h4,h5,h6,li,blockquote,figcaption,dt,dd,th,td,summary');
    const serialized = admitted.get(block);
    if (serialized?.ok && !serialized.contract.requiresText) census.protectedNodes += 1;
    else {
      const position = serialized?.ok ? normalize(serialized.template).indexOf(value, positions.get(block) || 0) : -1;
      if (position >= 0) positions.set(block, position + value.length);
      else if (!serialized?.atoms?.some(atom => atom.preserveText && normalize(atom.label).includes(value))) census.inlineMissing.push(value);
    }
    const markdownIndex = markdown.indexOf(value, markdownPosition);
    if (markdownIndex < 0) census.sidepanelMissing.push(value);
    else markdownPosition = markdownIndex + value.length;
  }
  globalThis.modelQualityExpectedNodes = [...blocks.keys()];
  return { blocks: [...blocks.values()], protected: readProtectedPage(root), extraction, census, textNodes, scansNeeded };
}

export function coverageMatches(record) {
  const census = record.expected?.census;
  if (census && (record.flow === 'inline' ? census.inlineMissing.length || census.rejectedBlocks.length :
      census.sidepanelMissing.length || census.protectedMinted === false)) return false;
  const initial = record.requests.filter(request => request.phase === 'initial');
  if (record.flow === 'sidepanel') return record.expectedChunks.length > 0 &&
    JSON.stringify(initial.map(request => request.input)) === JSON.stringify(record.expectedChunks);
  const expected = record.expected.blocks.map(block => JSON.stringify({ template: block.template, atoms: block.atoms })).sort();
  const observed = initial.flatMap(request => request.blockKeys || []).sort();
  return expected.length > 0 && JSON.stringify(expected) === JSON.stringify(observed);
}

export function inlineQualityCompleted(outcomes, expectedBlocks, appliedAllBlocks) {
  return appliedAllBlocks === true && expectedBlocks > 0 && outcomes.pending === 0 && outcomes.failed === 0 &&
    outcomes.changed === 0 && outcomes.translated + outcomes.partial === expectedBlocks;
}

export function inlineQualityTerminal(outcomes, expectedBlocks) {
  return Number.isSafeInteger(expectedBlocks) && expectedBlocks > 0 && outcomes.pending === 0 &&
    ['translated', 'partial', 'changed', 'failed'].every(key => Number.isSafeInteger(outcomes[key]) && outcomes[key] >= 0) &&
    outcomes.translated + outcomes.partial + outcomes.changed + outcomes.failed === expectedBlocks;
}

async function probeQualityCensus() {
  const root = document.querySelector('article') || document.querySelector('main');
  const codec = globalThis.ChromeAiTranslatorInlineBlock;
  const originalSerialize = codec.serializeBlock;
  const originalExtract = buildArticleExtraction;
  const node = document.createElement('p');
  const repeated = 'Census repeated source sentence.';
  node.append(document.createTextNode(repeated), document.createTextNode(repeated));
  root.append(node);
  const checks = {};
  try {
    const baseline = await prepareQualityPage();
    if (baseline.census.inlineMissing.length || baseline.census.sidepanelMissing.length || !baseline.census.protectedMinted) {
      throw new Error(`Census negative-control baseline failed: ${JSON.stringify(baseline.census)}`);
    }
    codec.serializeBlock = element => {
      const value = originalSerialize(element);
      return element === node && value.ok ? { ...value, template: value.template.replace(repeated, '') } : value;
    };
    checks.inlineDuplicate = (await prepareQualityPage()).census.inlineMissing.includes(repeated);
    codec.serializeBlock = originalSerialize;
    buildArticleExtraction = (...args) => {
      const value = originalExtract(...args);
      value.contentMarkdown = value.contentMarkdown.replace(repeated, '');
      return value;
    };
    checks.sidepanelDuplicate = (await prepareQualityPage()).census.sidepanelMissing.includes(repeated);
    buildArticleExtraction = originalExtract;
    node.replaceChildren();
    const code = document.createElement('code'); code.textContent = 'uniqueCensusCode()';
    const link = document.createElement('a'); link.href = 'https://example.invalid/census-source'; link.textContent = 'Census link';
    node.append(code, document.createTextNode(' and '), link);
    if (!(await prepareQualityPage()).census.protectedMinted) throw new Error('Protected census baseline failed.');
    buildArticleExtraction = (...args) => {
      const value = originalExtract(...args);
      value.translationDocument.entries = value.translationDocument.entries.filter(entry => entry.value !== code.textContent);
      return value;
    };
    checks.missingCode = !(await prepareQualityPage()).census.protectedMinted;
    buildArticleExtraction = (...args) => {
      const value = originalExtract(...args);
      value.translationDocument.entries = value.translationDocument.entries.filter(entry => entry.destination !== link.href);
      return value;
    };
    checks.missingLink = !(await prepareQualityPage()).census.protectedMinted;
    if (Object.values(checks).some(value => value !== true)) throw new Error('A source census negative control survived.');
    return checks;
  } finally {
    codec.serializeBlock = originalSerialize;
    buildArticleExtraction = originalExtract;
    node.remove();
  }
}

export function protectedMarkdownMatches(extraction, output) {
  const fragments = extraction.translationDocument.entries.flatMap(entry =>
    entry.kind === 'code' ? [Object.hasOwn(entry, 'destination') ?
      `[${escapeMarkdownLinkLabel(entry.value)}](${renderDestination(entry.destination)})` : renderCode(entry)] :
      entry.destination ? [renderDestination(entry.destination)] : []);
  const snippets = new Set([...fragments, ...extraction.translationDocument.entries.filter(entry => entry.destination)
    .map(entry => renderDestination(entry.destination))]);
  return [...snippets].every(value => {
    const count = text => text.split(value).length - 1;
    return Math.max(count(extraction.contentMarkdown), fragments.reduce((sum, fragment) => sum + count(fragment), 0)) === count(output);
  });
}

export function mockDisplayedProseMatches(pieces, output) {
  const normalize = value => String(value).replace(/\\([\\`*{}\[\]()#+\-.!_>])/g, '$1').replace(/\s+/g, ' ').trim();
  const displayed = normalize(output);
  let position = 0;
  return pieces.length > 0 && pieces.every(piece => {
    const value = normalize(piece);
    const at = displayed.indexOf(value, position);
    if (at < 0) return false;
    position = at + value.length;
    return true;
  });
}

export function summarizeQuality(records, observer, { live = false } = {}) {
  const observed = new Set(records.flatMap(record => record.requests.map(request => request.networkId)));
  if (observer.requestIds.size !== observed.size || [...observer.requestIds].some(id => !observed.has(id)) ||
      [...observed].some(id => live ? !observer.responses.has(id) : observer.responses.get(id)?.valid !== true)) throw new Error('An inference request lacks intercepted completion evidence.');
  const paired = new Map();
  let initialInputsMatched = true;
  for (const record of records) {
    const key = `${record.page}|${record.flow}`;
    const hashes = JSON.stringify(record.requests.filter(request => request.phase === 'initial')
      .map(request => [request.inputHash, request.maxOutputTokens]));
    if (paired.has(key) && paired.get(key) !== hashes) {
      if (!live) throw new Error('Candidate initial inputs differ.');
      initialInputsMatched = false;
    }
    paired.set(key, hashes);
  }
  return { experiment: live ? 'model-quality-live' : 'model-quality-mock', initialInputsMatched,
    groups: [...new Set(records.map(record => record.profileKey))].map(key => {
    const runs = records.filter(record => record.profileKey === key);
    const requests = runs.flatMap(run => run.requests);
    const cap = runs[0].profile.priceCap;
    return { profileKey: key, runs: runs.length, successes: runs.filter(run => run.success).length,
      initialRequests: requests.filter(request => request.phase === 'initial').length,
      repairRequests: requests.filter(request => request.phase === 'repair').length,
      requestInputBytes: requests.reduce((sum, request) => sum + request.inputBytes, 0),
      outputTokenCaps: requests.reduce((sum, request) => sum + request.maxOutputTokens, 0),
      byteInputAndFullOutputScenarioUsd: requests.reduce((sum, request) => sum +
        (request.inputBytes * cap.prompt + request.maxOutputTokens * cap.completion) / 1000000, 0),
      qualityAccepted: null, actualCostUsd: live && requests.every(request => Number.isFinite(request.cost)) ?
        requests.reduce((sum, request) => sum + request.cost, 0) : null,
      compatibilityPending: !live };
  }) };
}
