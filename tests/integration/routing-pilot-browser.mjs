import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { browser, launchExtensionBrowser, serveFixture, until } from './harness.mjs';
import { observeModelRequests } from './model-request-evidence.mjs';
import { inlinePanelControlsReady } from './inline-panel-readiness.mjs';
import { readProtectedPage, prepareQualityPage, probeQualityCensus, coverageMatches,
  inlineQualityCompleted, inlineQualityTerminal, protectedMarkdownMatches, mockDisplayedProseMatches } from './model-quality-observation.mjs';

const { createTranslationChunks } = createRequire(import.meta.url)('../../extension/translation-chunks.js');
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CORPUS = join(ROOT, 'tests/integration/fixtures/routing-pilot');
const hash = value => createHash('sha256').update(value).digest('hex');

export function createBrowserAdapter({ transport }) {
  const live = transport.live;
  const servers = {};
  const sourceEvidence = new Set();
  const preflights = new Set();
  const contexts = new Set();
  let ctx, worker, page, options, observer, unsubscribe, stopWorker, stopContexts;
  let experiment, session, save, request, accountResponse, halt, isHalted, hasPendingRequests, interceptionErrors, records, settleRequests;
  let qualityCorpus, qualityLive;
  return {
    live,
    withTransport: transport.run,
    async prepare(callbacks) {
      ({ experiment, session, save, request, accountResponse, halt, isHalted, hasPendingRequests, interceptionErrors, records, settleRequests } = callbacks);
      qualityCorpus = experiment.census;
      qualityLive = qualityCorpus && live;
      const corpus = experiment.corpus;
      for (const page of corpus.pages) {
        const filename = page.file || join(CORPUS, `${page.id}.html`);
        if (hash(readFileSync(filename)) !== page.sha256) throw new Error('Frozen corpus fingerprint mismatch.');
        servers[page.id] = await serveFixture(filename);
      }
      const firstPage = corpus.pages[0].id;
      ctx = await launchExtensionBrowser({ session, url: servers[firstPage].url, extensionDir: join(ROOT, 'extension') });
      const workerTarget = await ctx.findTarget(target => target.type === 'service_worker' && target.url.startsWith(`chrome-extension://${ctx.extension.id}/`));
      if (!workerTarget) throw new Error('Missing extension worker.');
      worker = await ctx.attach(workerTarget.id, 'service_worker');
      stopWorker = ctx.cdp.on('Target.targetDestroyed', event => { if (event.targetId === workerTarget.id) halt(); });
      unsubscribe = ctx.cdp.on('Fetch.requestPaused', (event, sourceSession) => {
        if (sourceSession !== worker.sessionId) return;
        if (event.request.url === 'https://openrouter.ai/api/v1/responses' && event.request.method === 'OPTIONS') {
          const task = ctx.cdp.send('Fetch.fulfillRequest', {
            requestId: event.requestId, responseCode: 204,
            responseHeaders: [{ name: 'Access-Control-Allow-Origin', value: '*' },
              { name: 'Access-Control-Allow-Methods', value: 'POST, OPTIONS' },
              { name: 'Access-Control-Allow-Headers', value: 'Content-Type, Authorization' }],
          }, sourceSession).then(result => {
            if (result.__error || result.__timeout) interceptionErrors.push('preflight-fulfillment-failed');
          }).catch(() => { halt(); interceptionErrors.push('preflight-fulfillment-failed'); })
            .finally(() => preflights.delete(task));
          preflights.add(task);
          return;
        }
        const fail = () => ctx.cdp.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'BlockedByClient' }, sourceSession);
        if (event.request.url !== 'https://openrouter.ai/api/v1/responses' || event.request.method !== 'POST') {
          interceptionErrors.push('unexpected-worker-request');
          fail().catch(halt);
          return;
        }
        let body;
        try { body = JSON.parse(event.request.postData); }
        catch { halt(); fail().catch(halt); return; }
        request({ body, networkId: event.networkId, fail,
          fulfill: ({ status, text }) => ctx.cdp.send('Fetch.fulfillRequest', {
            requestId: event.requestId, responseCode: status,
            responseHeaders: [{ name: 'Content-Type', value: 'application/json' }, { name: 'Access-Control-Allow-Origin', value: '*' }],
            body: Buffer.from(text).toString('base64'),
          }, sourceSession) });
      });
      const enabled = await ctx.cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] }, worker.sessionId);
      if (enabled.__error || enabled.__timeout) throw new Error('Worker interception unavailable.');
      const injected = await worker.evaluate(`(() => {
        const original = globalThis.fetch;
        globalThis.fetch = (url, init) => {
          if (url === 'https://openrouter.ai/api/v1/responses') {
            let body = JSON.parse(init.body);
            ${experiment.workerAdapter}
            return original.call(globalThis, url, { ...init, body: JSON.stringify(body) });
          }
          return original.call(globalThis, url, init);
        };
        return true;
      })()`);
      if (!injected) throw new Error('Disposable worker routing adapter unavailable.');
      observer = await observeModelRequests(ctx.cdp, worker.sessionId, { reasoningUsage: true,
        onResponse: async metadata => { if (!live) await accountResponse(metadata); },
      });
      options = ctx.page;
      await options.navigate(`chrome-extension://${ctx.extension.id}/options.html`);
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
      await options.evaluate(`chrome.tabs.create({ url: ${JSON.stringify(servers[firstPage].url)}, active: true }).then(tab => tab.id)`);
      const sourceTarget = await ctx.findTarget(target => target.type === 'page' && target.url === servers[firstPage].url);
      if (!sourceTarget) throw new Error('Missing source page.');
      page = await ctx.attach(sourceTarget.id);
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
    },
    async execute(entry, current) {
      current.acceptingRequests = false;
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
      await worker.evaluate(experiment.entrySettings(entry));
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
          if (isHalted()) return true;
          await page.evaluate('window.scrollTo(0, document.body.scrollHeight)');
          return await panel.evaluate(`(() => {
            const status = document.getElementById('inlineStatus').textContent;
            return status.startsWith('Visible translation on') && /Pending 0(?:\\D|$)/.test(status);
          })()`) && current.requests.length > 0 && (live || !hasPendingRequests()) &&
            (qualityCorpus ? coverageMatches(current) : await page.evaluate(`Array.from(document.querySelectorAll('article p, article h1, article h2, article li'))
              .filter(node => node.textContent.trim()).every(node => /[가-힣]/.test(node.textContent))`) ||
              (live && await panel.evaluate('/Failed [1-9]/.test(document.getElementById("inlineStatus").textContent)')));
        }, live ? 240000 : 20000, 100);
      } else {
        await until(async () => isHalted() || await panel.evaluate("document.getElementById('status').textContent === 'Done' || !document.getElementById('errorBox').hidden"), live ? 240000 : 20000, 100);
        complete = await panel.evaluate("document.getElementById('status').textContent === 'Done'");
      }
      complete = complete && !isHalted();
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
        if (!terminalFailure) halt();
        if (entry.flow === 'inline') await panel.evaluate("document.getElementById('btnInlineStop').click()");
      }
      await settleRequests();
      current.success = Boolean(complete);
      current.documentId = documentId;
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
      const translated = await (entry.flow === 'inline' ? page.evaluate('(document.querySelector("article") || document.querySelector("main")).innerText') : panel.evaluate('document.getElementById("translated").textContent'));
      if (qualityLive) {
        current.targetLanguagePresent = /[가-힣]/.test(translated);
      }
      const failure = !complete || qualityCorpus ? await panel.evaluate(`({sidepanel:document.getElementById('status').textContent,
        inline:document.getElementById('inlineStatus').textContent,inlineError:document.getElementById('inlineError').textContent,
        panelError:document.getElementById('errorBox').textContent})`) : undefined;
      return { complete, source: before, translated, failure };
    },
    async settle(isSettled) {
      await Promise.allSettled([...preflights]);
      await until(async () => {
        await observer?.settle();
        return isSettled();
      }, 45000, 100);
    },
    evidence() { return observer; },
    async close() {
      for (const stop of [stopWorker, stopContexts, unsubscribe, () => observer?.close(), () => ctx?.close()]) {
        try { await stop?.(); } catch {}
      }
      await browser(['close', '--session', session], 30000).catch(() => {});
      for (const server of Object.values(servers)) {
        try { server.close(); } catch {}
      }
    },
  };
}
