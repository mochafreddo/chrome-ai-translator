const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

exports.name = 'inline inspection';
exports.tests = [{
  name: 'rejects missing, duplicate and credential-bearing inputs before opening a browser',
  fn() {
    for (const [args, message] of [
      [[], 'An inspection URL is required'],
      [['--url', 'file:///tmp/article.html'], 'Inspection requires HTTP(S) without URL credentials'],
      [['--url', 'https://user:password@example.org'], 'Inspection requires HTTP(S) without URL credentials'],
      [['--url', 'https://example.org', '--url', 'https://example.org'], 'Usage: inspect:inline-blocks'],
      [['--unknown', 'value'], 'Usage: inspect:inline-blocks'],
    ]) {
      const result = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'inspect-inline-blocks.mjs'), ...args], { encoding: 'utf8' });
      assert.equal(result.status, 1);
      assert.equal(result.stdout, '');
      assert.ok(result.stderr.includes(message), result.stderr);
      assert.equal(result.stderr.includes('password'), false);
    }
  },
}];
