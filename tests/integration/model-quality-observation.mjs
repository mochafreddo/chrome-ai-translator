import { createRequire } from 'node:module';

const { renderCode, renderDestination, escapeMarkdownLinkLabel } = createRequire(import.meta.url)('../../extension/markdown-entries.js');

export function readProtectedPage(root) {
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

export async function prepareQualityPage() {
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

export async function probeQualityCensus() {
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
