const assert = require('node:assert/strict');
const { mkdtempSync, writeFileSync, chmodSync, symlinkSync, rmSync, statSync, existsSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { createHash } = require('node:crypto');
const { loadQualityCorpus } = require('./integration/model-quality-corpus.mjs');
const { coverageMatches, summarizeQuality, runPilot, inlineQualityCompleted, inlineQualityTerminal, protectedMarkdownMatches, mockDisplayedProseMatches } = require('./integration/routing-pilot-browser.mjs');

const WMT_SOURCE_SHA256 = '33b14dc670e28225ce742290718c513c1545c2c500d33667a4d01d776ca58dbc';
const hash = value => createHash('sha256').update(value).digest('hex');

function withTemporaryWmt(test) {
  const root = mkdtempSync(join(tmpdir(), 'model-quality-preparation-'));
  chmodSync(root, 0o700);
  const fixtureDir = root;
  const pages = [];
  for (let index = 1; index <= 6; index += 1) {
    const filename = `synthetic-${index}.html`;
    const contents = `<!doctype html><html><body><p>Synthetic fixture ${index}.</p></body></html>`;
    writeFileSync(join(fixtureDir, filename), contents, { flag: 'wx', mode: 0o600 });
    pages.push({
      id: `synthetic-${index}`,
      file: filename,
      fixture_sha256: hash(contents),
      doc_id: `synthetic-doc-${index}`,
      reference_file: `reference-must-not-be-read-${index}.txt`,
    });
  }
  const manifestPath = join(root, 'wmt-manifest.json');
  const manifest = { source_sha256: WMT_SOURCE_SHA256, pages };
  writeFileSync(manifestPath, JSON.stringify(manifest), { flag: 'wx', mode: 0o600 });
  try {
    return test({ root, fixtureDir, pages, manifest, manifestPath });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function makeRecord(profileKey, inputHash, networkId, flow = 'inline') {
  return {
    id: `${profileKey}-${flow}`,
    page: 'technical',
    flow,
    profileKey,
    profile: { priceCap: { prompt: 0.3, completion: 1.2, request: 0 } },
    success: true,
    requests: [{
      networkId,
      phase: 'initial',
      inputHash,
      maxOutputTokens: 4096,
      inputBytes: 200,
    }],
  };
}

function makeObserver(records) {
  const ids = records.flatMap(record => record.requests.map(request => request.networkId));
  return {
    requestIds: new Set(ids),
    responses: new Map(ids.map(id => [id, { valid: true }])),
  };
}

exports.name = 'model quality preparation';
exports.tests = [{
  name: 'loads the frozen 3 regression, 3 application, and 6 synthetic WMT fixtures without references',
  fn() {
    let temporaryRoot;
    withTemporaryWmt(({ fixtureDir, manifestPath, pages }) => {
      temporaryRoot = fixtureDir;
      assert.equal((statSync(fixtureDir).mode & 0o777), 0o700);
      assert.equal((statSync(manifestPath).mode & 0o777), 0o600);
      for (const page of pages) {
        assert.equal((statSync(join(fixtureDir, page.file)).mode & 0o777), 0o600);
        assert.equal(existsSync(join(fixtureDir, page.reference_file)), false);
      }
      const corpus = loadQualityCorpus(manifestPath);
      assert.equal(corpus.pages.length, 12);
      assert.equal(corpus.pages.filter(page => page.id.startsWith('regression-')).length, 3);
      assert.equal(corpus.pages.filter(page => page.id.startsWith('application-')).length, 3);
      assert.equal(corpus.pages.filter(page => page.id.startsWith('synthetic-')).length, 6);
      assert.equal(new Set(corpus.pages.map(page => page.id)).size, 12);
      assert.equal(corpus.wmtSourceSha256, WMT_SOURCE_SHA256);
      assert.equal(corpus.pages.some(page => 'reference_file' in page), false);
    });
    assert.equal(existsSync(temporaryRoot), false);
  },
}, {
  name: 'rejects a changed frozen fixture hash',
  fn() {
    withTemporaryWmt(({ fixtureDir, manifestPath, pages }) => {
      writeFileSync(join(fixtureDir, pages[2].file), '<html>changed</html>', { mode: 0o600 });
      assert.throws(() => loadQualityCorpus(manifestPath), /fingerprint mismatch/);
    });
  },
}, {
  name: 'rejects traversal, symlinks, and duplicate synthetic page ids',
  fn() {
    withTemporaryWmt(({ fixtureDir, manifestPath, manifest, pages }) => {
      const original = pages[0].file;
      pages[0].file = '../outside.html';
      writeFileSync(manifestPath, JSON.stringify(manifest), { mode: 0o600 });
      assert.throws(() => loadQualityCorpus(manifestPath), /Invalid corpus page path/);
      pages[0].file = original;

      const alias = 'synthetic-alias.html';
      symlinkSync(join(fixtureDir, original), join(fixtureDir, alias));
      pages[0].file = alias;
      writeFileSync(manifestPath, JSON.stringify(manifest), { mode: 0o600 });
      assert.throws(() => loadQualityCorpus(manifestPath), /symlinks are not supported/);
      rmSync(join(fixtureDir, alias));
      pages[0].file = original;

      pages[1].id = pages[0].id;
      writeFileSync(manifestPath, JSON.stringify(manifest), { mode: 0o600 });
      assert.throws(() => loadQualityCorpus(manifestPath), /12 unique pages/);
    });
  },
}, {
  name: 'matches Inline blocks as a multiset and Side Panel initial chunks in order',
  fn() {
    const duplicate = JSON.stringify({ template: 'same block', atoms: [] });
    const other = JSON.stringify({ template: 'other block', atoms: [{ token: '⟦ATOM⟧' }] });
    const inline = {
      flow: 'inline',
      expected: { blocks: [
        { template: 'same block', atoms: [] },
        { template: 'same block', atoms: [] },
        { template: 'other block', atoms: [{ token: '⟦ATOM⟧' }] },
      ] },
      requests: [
        { phase: 'initial', blockKeys: [other, duplicate] },
        { phase: 'repair', blockKeys: ['uncensused repair input'] },
        { phase: 'initial', blockKeys: [duplicate] },
      ],
    };
    assert.equal(coverageMatches(inline), true);
    inline.requests[2].blockKeys = [];
    assert.equal(coverageMatches(inline), false);

    const sidepanel = {
      flow: 'sidepanel',
      expectedChunks: ['first chunk', 'second chunk'],
      requests: [
        { phase: 'initial', input: 'first chunk' },
        { phase: 'repair', input: 'repair request is ignored' },
        { phase: 'initial', input: 'second chunk' },
      ],
    };
    assert.equal(coverageMatches(sidepanel), true);
    sidepanel.requests.reverse();
    assert.equal(coverageMatches(sidepanel), false);
  },
}, {
  name: 'requires an observed completion for every request and matching initial inputs across profiles',
  fn() {
    const records = [makeRecord('candidate-a', 'same-input', 'network-a'), makeRecord('candidate-b', 'same-input', 'network-b')];
    const observer = makeObserver(records);
    assert.equal(summarizeQuality(records, observer).groups.length, 2);

    const unmatched = { ...observer, requestIds: new Set([...observer.requestIds, 'orphan-request']) };
    assert.throws(() => summarizeQuality(records, unmatched), /completion evidence/);
    const failedResponse = { ...observer, responses: new Map(observer.responses) };
    failedResponse.responses.set('network-b', { valid: false });
    assert.throws(() => summarizeQuality(records, failedResponse), /completion evidence/);

    const mismatched = [records[0], { ...records[1], requests: [{ ...records[1].requests[0], inputHash: 'different-input' }] }];
    assert.throws(() => summarizeQuality(mismatched, makeObserver(mismatched)), /initial inputs differ/);
  },
}, {
  name: 'rejects missing source prose, serializer refusals, and an empty Side Panel chunk set',
  fn() {
    const inline = { flow: 'inline', expected: { blocks: [{ template: 'source', atoms: [] }],
      census: { inlineMissing: ['missing source paragraph'], rejectedBlocks: [], sidepanelMissing: [] } },
      requests: [{ phase: 'initial', blockKeys: [JSON.stringify({ template: 'source', atoms: [] })] }] };
    assert.equal(coverageMatches(inline), false);
    inline.expected.census.inlineMissing = [];
    inline.expected.census.rejectedBlocks = [{ tag: 'P', code: 'unsupported' }];
    assert.equal(coverageMatches(inline), false);
    assert.equal(coverageMatches({ flow: 'sidepanel', expectedChunks: [], requests: [] }), false);
    assert.equal(coverageMatches({ flow: 'sidepanel', expected: { census: { sidepanelMissing: ['lost paragraph'] } },
      expectedChunks: ['known chunk'], requests: [{ phase: 'initial', input: 'known chunk' }] }), false);
  },
}, {
  name: 'requires every mock block to be applied with no pending, changed, or failed outcomes',
  fn() {
    const outcomes = { translated: 1, partial: 2, pending: 0, changed: 0, failed: 0 };
    assert.equal(inlineQualityCompleted(outcomes, 3, true), true);
    assert.equal(inlineQualityCompleted(outcomes, 3, false), false);
    assert.equal(inlineQualityCompleted(outcomes, 4, true), false);
    for (const key of ['pending', 'changed', 'failed']) {
      assert.equal(inlineQualityCompleted({ ...outcomes, [key]: 1 }, 3, true), false);
    }
  },
}, {
  name: 'distinguishes known terminal outcomes from pending or incomplete mock work',
  fn() {
    assert.equal(inlineQualityTerminal({ translated: 1, partial: 0, changed: 1, failed: 1, pending: 0 }, 3), true);
    assert.equal(inlineQualityTerminal({ translated: 0, partial: 0, changed: 0, failed: 2, pending: 0 }, 2), true);
    const invalid = [
      [{ translated: 1, partial: 0, changed: 0, failed: 0, pending: 0 }, 2],
      [{ translated: 1, partial: 0, changed: 0, failed: 0, pending: 1 }, 1],
      [{ translated: 1, partial: 0, changed: -1, failed: 0, pending: 0 }, 0],
      [{ translated: 1, partial: 0, failed: 0, pending: 0 }, 1],
      [{ translated: 1, partial: 0, changed: 0, failed: 0 }, 1],
      [{ translated: 1, partial: 0, changed: 0, failed: 0, pending: 0 }, 0],
      [{ translated: 1, partial: 0, changed: 0, failed: 0, pending: 0 }, -1],
      [{ translated: 1, partial: 0, changed: 0, failed: 0, pending: 0 }, 1.5],
    ];
    for (const [outcomes, expectedBlocks] of invalid) assert.equal(inlineQualityTerminal(outcomes, expectedBlocks), false);
  },
}, {
  name: 'checks protected Markdown snippets and their counts without expecting rendered HTML',
  fn() {
    const extraction = { contentMarkdown: 'Use ```value()``` and [guide](<https://example.org/>).',
      translationDocument: { entries: [{ kind: 'code', display: 'inline', value: 'value()' },
        { kind: 'link', destination: 'https://example.org/' }] } };
    assert.equal(protectedMarkdownMatches(extraction, '모의 응답.\nUse ```value()``` and [guide](<https://example.org/>).'), true);
    assert.equal(protectedMarkdownMatches(extraction, 'Use ```changed()``` and [guide](<https://example.org/>).'), false);
    assert.equal(protectedMarkdownMatches(extraction, 'Use ```value()``` and [guide](<https://other.example/>).'), false);
    assert.equal(protectedMarkdownMatches(extraction, extraction.contentMarkdown + ' ```value()```'), false);
  },
}, {
  name: 'rejects a lost or reused displayed prose occurrence while allowing synthetic prefixes',
  fn() {
    const pieces = ['The first sentence.', 'Repeated sentence.', 'Repeated sentence.'];
    assert.equal(mockDisplayedProseMatches(pieces, '모의 응답입니다. The first sentence. Repeated sentence. 모의 응답입니다. Repeated sentence.'), true);
    assert.equal(mockDisplayedProseMatches(pieces, 'The first sentence. Repeated sentence. ```code()```'), false);
    assert.equal(mockDisplayedProseMatches(pieces, 'Repeated sentence. Repeated sentence. ```code()```'), false);
  },
}, {
  name: 'uses protected entry source text when original Markdown collapses inline-code whitespace',
  fn() {
    const extraction = { contentMarkdown: 'Use ```method(self, args)```.', translationDocument: {
      entries: [{ kind: 'code', display: 'inline', value: 'method(self,\nargs)' }] } };
    assert.equal(protectedMarkdownMatches(extraction, 'Use ```method(self,\nargs)```.'), true);
    assert.equal(protectedMarkdownMatches(extraction, 'Use ```method(self, args)```.'), false);
  },
}, {
  name: 'rejects quality live mode before preparing browser or credential state',
  async fn() {
    await assert.rejects(runPilot({ qualityCorpus: {}, live: true }), /no live mode/);
  },
}];
