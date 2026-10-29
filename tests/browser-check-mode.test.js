const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

module.exports = {
  name: 'browser-check-mode',
  tests: [{
    name: 'selects both checks by default or exactly one requested mode',
    async fn() {
      const { parseBrowserCheckMode } = await import('./integration/browser-check-mode.mjs');
      assert.deepEqual(parseBrowserCheckMode([]), { fixture: true, reported: true });
      assert.deepEqual(parseBrowserCheckMode(['--fixture-only']), { fixture: true, reported: false });
      assert.deepEqual(parseBrowserCheckMode(['--reported-only']), { fixture: false, reported: true });
      for (const args of [['--unknown'], ['--fixture-only', '--fixture-only'],
        ['--reported-only', '--reported-only'], ['--fixture-only', '--reported-only'],
        ['--reported-only', '--fixture-only'], ['--fixture-only', 'extra']]) {
        assert.throws(() => parseBrowserCheckMode(args), /Usage/);
      }
    },
  }, {
    name: 'browser check entry points validate arguments before launching the selected page',
    fn() {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-check-mode-'));
      try {
        const effects = path.join(dir, 'effects.jsonl');
        const preload = path.join(dir, 'http-preload.cjs');
        fs.writeFileSync(preload, `
const http = require('node:http');
http.createServer = () => ({
  listen(_port, _host, callback) { callback(); },
  address() { return { port: 12345 }; },
  close() {},
});
`);
        fs.writeFileSync(path.join(dir, 'agent-browser'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.BROWSER_MODE_EFFECTS, JSON.stringify(args) + '\\n');
if (args.includes('open')) process.exit(1);
`, { mode: 0o700 });
        for (const [file, reportedUrl] of [
          ['inline-button.test.mjs', 'https://aiforui.dev/'],
          ['heading-permalink.test.mjs', 'https://code.claude.com/docs/en/advisor'],
        ]) {
          const run = (args) => {
            fs.writeFileSync(effects, '');
            const result = spawnSync(process.execPath, ['--require', preload, path.join(__dirname, 'integration', file), ...args], {
              env: { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH}`, BROWSER_MODE_EFFECTS: effects },
              encoding: 'utf8', timeout: 10000,
            });
            assert.ifError(result.error);
            const calls = fs.readFileSync(effects, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
            return { result, calls };
          };
          for (const args of [['--unknown'], ['--fixture-only', '--fixture-only'],
            ['--reported-only', '--reported-only'], ['--fixture-only', '--reported-only']]) {
            const { result, calls } = run(args);
            assert.equal(result.status, 1);
            assert.match(result.stderr, /Usage/);
            assert.deepEqual(calls, []);
          }
          for (const args of [[], ['--fixture-only'], ['--reported-only']]) {
            const { result, calls } = run(args);
            assert.equal(result.status, 1);
            const open = calls.find((call) => call.includes('open'));
            assert.ok(open, `${file} ${args.join(' ')}: ${result.stderr}`);
            const target = open[open.indexOf('open') + 1];
            if (args.includes('--reported-only')) assert.equal(target, reportedUrl);
            else assert.match(target, /^http:\/\/127\.0\.0\.1:\d+\/$/);
          }
        }
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  }],
};
