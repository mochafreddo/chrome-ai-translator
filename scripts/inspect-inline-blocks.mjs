import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
  const url = new URL(options['--url']);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Inspection requires HTTP(S) without URL credentials');
  }
  const selector = options['--root'] || 'main';
  const extensionDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'extension');
  const session = `inline-inspection-${randomUUID()}`;
  let context;
  try {
    context = await launchExtensionBrowser({ session, url: url.href, extensionDir });
    const ready = await until(() => context.page.evaluate(
      `Boolean(document.querySelector(${JSON.stringify(selector)}))`
    ), 20000, 250);
    if (!ready) throw new Error('Inspection root is missing or invalid');
    for (const file of ['default-model.js', 'placeholder-tokens.js', 'inline-block.js', 'inline-request.js', 'translation-settings.js', 'inline-model-execution.js']) {
      await context.page.evaluate(readFileSync(join(extensionDir, file), 'utf8'));
    }
    const result = await context.page.evaluate(
      `(${inspectBlocks.toString()})(${JSON.stringify(selector)}).catch(() => ({ error: true }))`, 60000
    );
    if (!Array.isArray(result?.blocks)) throw new Error('Inline block inspection failed');
    console.log(JSON.stringify(result, null, 2));
  } finally {
    context?.close();
    await browser(['--session', session, 'close']).catch(() => {});
  }
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
