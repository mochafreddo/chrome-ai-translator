import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import background from '../../extension/background.js';
import domTree from '../dom-tree.js';
import { parseBrowserCheckMode } from './browser-check-mode.mjs';
import { browser, createChecks, launchExtensionBrowser, serveFixture, until } from './harness.mjs';

const mode = parseBrowserCheckMode(process.argv.slice(2));
const HERE = dirname(fileURLToPath(import.meta.url));
const EXTENSION_DIR = join(HERE, '..', '..', 'extension');
const SESSION = 'chrome-ai-translator-release-accounts';
const PAGE_URL = 'https://github.com/mattpocock/skills/releases/tag/v1.3.2';
const { check, failures, finish } = createChecks('GitHub release accounts');

async function exercise(block) {
  if (!block) throw new Error('Contributor paragraph is missing');
  block.scrollIntoView({ block: 'center', behavior: 'instant' });
  const codec = globalThis.ChromeAiTranslatorInlineBlock;
  const graph = globalThis.captureDomTree(block);
  const elements = [block, ...block.querySelectorAll('*')];
  const attributes = elements.map((element) => JSON.stringify([...element.attributes].map(({ name, value }) => [name, value])));
  const accounts = [...block.querySelectorAll('a')].filter((link) => /^@/.test(link.textContent));
  const names = accounts.map((link) => link.textContent);
  const serialized = codec.serializeBlock(block);
  if (!serialized.ok) throw new Error(`Serialization refused: ${serialized.errorCode}`);
  const record = { id: 'contributors', template: serialized.template, atoms: serialized.atoms,
    contract: serialized.contract, repair: null };
  const translated = record.template.replace('Read the release notes.', '릴리스 노트를 읽어보세요.')
    .replaceAll('Thanks ', '감사합니다 ')
    .replace(' no longer labels maps or tickets ', '는 지도나 티켓에 더 이상 다음 라벨을 붙이지 않습니다: ')
    .replace('writes cross-references only with real issue ids', '실제 이슈 번호로만 상호 참조를 작성합니다')
    .replace('opens no PR from research branches', '연구 브랜치에서 풀 리퀘스트를 열지 않습니다')
    .replace('and resolves each ticket as the type its label names', '각 티켓을 해당 라벨에 지정된 유형에 맞게 해결합니다')
    .replace(' and ', ' 및 ');
  const settings = { targetLanguage: 'Korean', tone: 'technical', model: 'gpt-6-luna', reasoningEffort: 'none' };
  let calls = 0;
  const [complete] = await globalThis.ChromeAiTranslatorInlineModelExecution.execute([record], settings, async (request) => {
    calls += 1;
    const [input] = JSON.parse(request.input).records;
    if (input.id !== record.id || names.some((name) =>
      !input.atoms.some((atom) => atom.label === name && atom.preserveText))) {
      throw new Error('Account labels were not preserved in model input');
    }
    return JSON.stringify({ translations: [{ id: record.id, template: translated }] });
  });
  const applied = codec.applyTranslatedTemplate(serialized.snapshot, complete.template);
  const preserved = applied.ok && names.length >= 4 && accounts.every((link, index) =>
    block.contains(link) && link.textContent === names[index]) && elements.every((element, index) =>
    block.contains(element) && JSON.stringify([...element.attributes].map(({ name, value }) => [name, value])) === attributes[index]);
  const restored = codec.restoreBlock(serialized.snapshot).ok && graph.matches();
  const [partial] = await globalThis.ChromeAiTranslatorInlineModelExecution.execute([record], settings, async () =>
    JSON.stringify({ translations: [{ id: record.id, template: record.template.replaceAll('Thanks ', '감사합니다 ') }] }));
  return {
    complete: complete.disposition === 'apply' && complete.diagnostic.quality.status === 'complete' && calls === 1,
    preserved,
    restored,
    genuineResidue: partial.disposition === 'apply_with_warning' && partial.terminalCode === 'quality.english_residue' && partial.attemptCount === 2,
  };
}

async function verify(page, label, reported) {
  for (const file of [...background.getInlineContentScriptFiles(), 'translation-settings.js', 'inline-model-execution.js']) {
    await page.evaluate(readFileSync(join(EXTENSION_DIR, file), 'utf8'));
  }
  await page.evaluate(`globalThis.captureDomTree = ${domTree.captureDomTree.toString()}`);
  const selector = reported
    ? "[...document.querySelectorAll('main p')].find(block => block.textContent.includes('no longer labels maps or tickets'))"
    : "document.querySelector('#contributors')";
  const result = await page.evaluate(`(${exercise.toString()})(${selector}).catch(error => ({ error: error.message }))`);
  for (const name of ['complete', 'preserved', 'restored', 'genuineResidue']) {
    check(`${label}: ${name}`, result?.[name] === true, JSON.stringify(result));
  }
}

let context;
let fixture;
try {
  fixture = await serveFixture(join(HERE, 'fixtures', 'github-skill-page.html'));
  context = await launchExtensionBrowser({ session: SESSION, url: fixture.url, extensionDir: EXTENSION_DIR });
  if (!context.page || !context.extension) throw new Error('Extension or fixture page is missing');
  if (mode.fixture) {
    await context.page.evaluate(`document.body.innerHTML = '<main><p id="contributors">Read the release notes. Thanks <a href="/alice">@alice</a>, <a href="/bob">@bob</a>, <a href="/carol">@carol</a> and <a href="/dev_1-name"><span>@dev_1-name</span></a>.</p></main>'`);
    await verify(context.page, 'fixture', false);
  }
  if (mode.reported) {
    await context.page.navigate(PAGE_URL);
    const ready = await until(() => context.page.evaluate(
      `Boolean([...document.querySelectorAll('main p')].find(block => block.textContent.includes('no longer labels maps or tickets')))`
    ), 20000, 250);
    if (check('reported: contributor paragraph is present', ready === true)) {
      await verify(context.page, 'reported', true);
    }
  }
} catch (error) {
  failures.push('harness');
  console.error(`FAIL GitHub release accounts - ${error?.message || error}`);
} finally {
  context?.close();
  fixture?.close();
  await browser(['--session', SESSION, 'close']).catch(() => {});
}
finish();
