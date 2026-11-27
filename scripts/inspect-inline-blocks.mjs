import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import diagnostics from '../extension/inline-diagnostics-protocol.js';
import { browser, launchExtensionBrowser, until } from '../tests/integration/harness.mjs';

async function inspectBlocks(selector) {
  const root = globalThis.document.querySelector(selector);
  if (!root) throw new Error('Inspection root is missing');
  const codec = globalThis.ChromeAiTranslatorInlineBlock;
  const candidates = [root, ...root.querySelectorAll('*')].filter(codec.isSemanticBlockElement);
  const blocks = [];
  for (const [index, block] of candidates.entries()) {
    block.scrollIntoView({ block: 'center', behavior: 'instant' });
    const serialized = codec.serializeBlock(block);
    const metadata = { index, tagName: block.tagName, ok: serialized.ok };
    if (!serialized.ok) {
      blocks.push({ ...metadata, errorCode: serialized.errorCode, localRejection: serialized.localRejection });
      continue;
    }
    const { evidence } = globalThis.ChromeAiTranslatorInlineModelExecution.assessTranslationQuality(
      serialized.template, 'inspection', 'English', serialized.contract
    );
    if (!Number.isSafeInteger(evidence.sourceChars) || !Number.isSafeInteger(evidence.sourceProseWordCount)) {
      throw new Error('Source quality evidence is unavailable');
    }
    blocks.push({ ...metadata, sourceChars: evidence.sourceChars, sourceProseWordCount: evidence.sourceProseWordCount });
  }
  return { schemaVersion: 1, syntheticProbe: true, blocks };
}

const blockTags = new Set('P LI H1 H2 H3 H4 H5 H6 BLOCKQUOTE FIGCAPTION DT DD TH TD SPAN SUMMARY'.split(' '));
const rejectionTags = new Set([...blockTags, ...(
  'A ABBR ARTICLE ASIDE AUDIO B BR BUTTON CANVAS CODE DEL DETAILS DIV DL EM FIGURE FORM I IFRAME IMG INPUT ' +
  'KBD LABEL MARK MATH NAV OL OPTION PRE S SAMP SECTION SELECT SMALL STRONG SUB SUP SVG TABLE TBODY ' +
  'TEXTAREA THEAD TIME TR U UL VIDEO WBR'
).split(' ')]);

function validatedReport(result) {
  const invalid = () => new Error('Invalid inspection metadata');
  if (result?.schemaVersion !== 1 || result.syntheticProbe !== true || !Array.isArray(result.blocks)) throw invalid();
  const blocks = result.blocks.map((block, index) => {
    if (block?.index !== index || !blockTags.has(block.tagName)) throw invalid();
    const { tagName, ok, sourceChars, sourceProseWordCount } = block;
    if (ok === true && Number.isSafeInteger(sourceChars) && sourceChars >= 0 &&
      Number.isSafeInteger(sourceProseWordCount) && sourceProseWordCount >= 0) {
      return { index, tagName, ok, sourceChars, sourceProseWordCount };
    }
    const rejection = diagnostics.serializeLocalRejection(block.localRejection);
    if (ok !== false || block.errorCode !== 'unsupported_block' || !rejection) throw invalid();
    if (!rejectionTags.has(rejection.tag)) delete rejection.tag;
    return { index, tagName, ok, errorCode: 'unsupported_block', localRejection: rejection };
  });
  return { schemaVersion: 1, syntheticProbe: true, blocks };
}

async function isolatedEvaluator({ cdp, page }) {
  const tree = await cdp.send('Page.getFrameTree', {}, page.sessionId);
  const frameId = tree.frameTree?.frame.id;
  if (!frameId) throw new Error('Inspection frame unavailable');
  const { executionContextId } = await cdp.send('Page.createIsolatedWorld', { frameId }, page.sessionId);
  if (!Number.isSafeInteger(executionContextId) || executionContextId <= 0) throw new Error('Inspection world unavailable');
  return async (expression, timeoutMs) => {
    const response = await cdp.send('Runtime.evaluate', {
      expression, contextId: executionContextId, returnByValue: true, awaitPromise: true,
    }, page.sessionId, timeoutMs);
    if (!response.result || response.exceptionDetails) throw new Error('Inspection evaluation failed');
    return response.result.value;
  };
}

async function main(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!['--url', '--root'].includes(name) || !value || value.startsWith('--') || Object.hasOwn(options, name)) {
      throw new Error('Usage: inspect:inline-blocks -- --url <http(s) URL> [--root <CSS selector>]');
    }
    options[name] = value;
  }
  if (!options['--url']) throw new Error('An inspection URL is required');
  const url = URL.parse(options['--url']);
  if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Inspection requires HTTP(S) without URL credentials');
  }
  const selector = options['--root'] || 'main';
  const extensionDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'extension');
  const session = `inline-inspection-${randomUUID()}`;
  let context;
  try {
    context = await launchExtensionBrowser({ session, url: url.href, extensionDir });
    const evaluate = await isolatedEvaluator(context);
    const ready = await until(() => evaluate(
      `Boolean(document.querySelector(${JSON.stringify(selector)}))`
    ), 20000, 250);
    if (!ready) throw new Error('Inspection root is missing or invalid');
    for (const file of ['default-model.js', 'placeholder-tokens.js', 'inline-template.js', 'inline-block.js', 'inline-request.js', 'translation-settings.js', 'inline-model-execution.js']) {
      await evaluate(readFileSync(join(extensionDir, file), 'utf8'));
    }
    const result = await evaluate(
      `(${inspectBlocks.toString()})(${JSON.stringify(selector)})`, 60000
    );
    console.log(JSON.stringify(validatedReport(result), null, 2));
  } catch {
    throw new Error('Inline block inspection failed');
  } finally {
    context?.close();
    await browser(['--session', session, 'close']).catch(() => {});
  }
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
