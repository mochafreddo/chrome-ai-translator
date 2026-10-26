import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

export function loadCompatibilityCorpus() {
  const file = join(FIXTURES, 'model-quality/compatibility.html');
  return { pages: [{ id: 'compatibility', file, sha256: hash(readFileSync(file)),
    source: 'Project-authored translation compatibility fixture.' }] };
}

export function loadQualityCorpus(wmtManifestPath) {
  if (typeof wmtManifestPath !== 'string' || !wmtManifestPath) throw new Error('A private WMT corpus manifest is required.');
  const pages = [];
  const add = (directory, id, filename, fingerprint, source) => {
    if (!/^[a-z0-9-]+$/.test(id) || typeof filename !== 'string' || basename(filename) !== filename || !filename.endsWith('.html')) {
      throw new Error('Invalid corpus page path or id.');
    }
    const file = join(directory, filename);
    if (realpathSync(dirname(file)) !== realpathSync(directory) || realpathSync(file) !== resolve(file)) throw new Error('Corpus symlinks are not supported.');
    if (!/^[a-f0-9]{64}$/.test(fingerprint) || hash(readFileSync(file)) !== fingerprint) throw new Error('Frozen corpus fingerprint mismatch.');
    pages.push({ id, file, sha256: fingerprint, source });
  };
  const regressionDir = join(FIXTURES, 'routing-pilot');
  const regression = JSON.parse(readFileSync(join(regressionDir, 'corpus.json')));
  for (const page of regression.pages) add(regressionDir, `regression-${page.id}`, `${page.id}.html`, page.sha256, page.url);
  const applicationDir = join(FIXTURES, 'model-quality');
  const application = JSON.parse(readFileSync(join(applicationDir, 'corpus.json')));
  for (const page of application.fixtures) add(applicationDir, `application-${page.id}`, page.path, page.output.sha256, page.source.url);
  const wmtFile = realpathSync(wmtManifestPath);
  const wmt = JSON.parse(readFileSync(wmtFile));
  if (wmt.source_sha256 !== '33b14dc670e28225ce742290718c513c1545c2c500d33667a4d01d776ca58dbc' || !Array.isArray(wmt.pages) || wmt.pages.length !== 6) {
    throw new Error('The confirmed six-document WMT snapshot is required.');
  }
  for (const page of wmt.pages) add(dirname(wmtFile), page.id, page.file, page.fixture_sha256, page.doc_id);
  if (pages.length !== 12 || new Set(pages.map(page => page.id)).size !== 12) throw new Error('The corpus must contain 12 unique pages.');
  return { pages, normalization: 'Frozen normalized English HTML; WMT human references are not loaded.', wmtSourceSha256: wmt.source_sha256 };
}
