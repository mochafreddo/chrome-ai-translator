import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serveFixture } from './harness.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const fixture = await serveFixture(join(root, 'tests', 'integration', 'fixtures', 'inline-inspection.html'));
try {
  const { stdout } = await promisify(execFile)(process.execPath,
    [join(root, 'scripts', 'inspect-inline-blocks.mjs'), '--url', fixture.url], { timeout: 90000 });
  const result = JSON.parse(stdout);
  assert.equal(result.syntheticProbe, true);
  assert.equal(result.blocks.length, 6);
  assert.deepEqual(result.blocks[0], { index: 0, tagName: 'LI', ok: false, errorCode: 'unsupported_block',
    localRejection: { reason: 'empty_content', tag: 'LI' } });
  assert.deepEqual(result.blocks[1], { index: 1, tagName: 'P', ok: true, sourceChars: 23, sourceProseWordCount: 4 });
  assert.equal(result.blocks[2].ok, false);
  assert.equal(result.blocks[2].localRejection.reason, 'hidden_content');
  assert.deepEqual(result.blocks[3], { index: 3, tagName: 'P', ok: true, sourceChars: 1, sourceProseWordCount: 0 });
  assert.deepEqual(result.blocks[4], { index: 4, tagName: 'P', ok: true, sourceChars: 60000, sourceProseWordCount: 30000 });
  assert.deepEqual(result.blocks[5], { index: 5, tagName: 'P', ok: true, sourceChars: 5, sourceProseWordCount: 1 });
  assert.equal(stdout.includes('Read the release notes'), false);
  assert.equal(stdout.includes(fixture.url), false);
  console.log('PASS inline inspection - parent rejection, own prose metrics and text-free output');
} finally { fixture.close(); }
