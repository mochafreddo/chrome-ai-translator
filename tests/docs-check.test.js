const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { checkDocs, checkHistory, headings } = require('../scripts/check-docs.js');

function repository(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'translator-docs-'));
  const git = (...args) => execFileSync('git', [
    '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
    '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args,
  ], { cwd: root, encoding: 'utf8', stdio: 'pipe' }).trim();
  const write = (name, value) => {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), value);
  };
  const run = (...args) => spawnSync(process.execPath, [path.join(__dirname, '../scripts/check-docs.js'), ...args], {
    cwd: root, encoding: 'utf8', timeout: 30000,
  });
  try {
    git('init', '--quiet', '--initial-branch=main');
    fn({ root, git, write, run });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

exports.name = 'documentation checks';
exports.tests = [
  {
    name: 'rejects document and history symlinks outside the repository before reading their content',
    fn() {
      repository(({ root, git, write }) => {
        const external = fs.mkdtempSync(path.join(os.tmpdir(), 'translator-outside-'));
        try {
          const record = 'docs/design/record.md';
          const content = '# Record\n\nObserved 3 blocks.\n';
          write('docs/README.md', '# Docs\n[Record](design/record.md)\n');
          write(record, content);
          git('add', '.');
          git('commit', '--quiet', '-m', 'test(docs): retain baseline\n\nCheck reads stay inside the repository.');
          const base = git('rev-parse', 'HEAD');
          const outside = path.join(external, 'record.md');
          fs.writeFileSync(outside, content);
          fs.unlinkSync(path.join(root, record));
          fs.symlinkSync(outside, path.join(root, record));
          assert.ok(checkDocs(root).errors.some((error) => error.includes('resolves outside the repository')));
          assert.ok(checkHistory(root, base).errors.some((error) => error.includes('resolves outside the repository')));
          fs.unlinkSync(path.join(root, record));
          write('retained.txt', content);
          fs.symlinkSync(path.join(root, 'retained.txt'), path.join(root, record));
          assert.deepEqual(checkDocs(root).errors, []);
          assert.deepEqual(checkHistory(root, base).errors, []);
        } finally { fs.rmSync(external, { recursive: true, force: true }); }
      });
    },
  },
  {
    name: 'checks tracked local links and heading anchors while excluding code and external URLs',
    fn() {
      repository(({ root, git, write, run }) => {
        write('docs/README.md', '# Docs\n\n[Guide](guide.md#api-get--state)\n');
        write('docs/guide.md', '# API `get()` & **State**\n\n[Home](../README.md "User guide")\n');
        write('README.md', '# Home\n\n[Guide](docs/guide.md#api-get--state)\n' +
          '[Encoded](docs/a%20file.md) [Angle](<docs/a file.md> "A file")\n' +
          '[Nested [label]](docs/a\\(b\\).md) [Balanced](docs/a(b).md)\n' +
          '[Remote](https://example.invalid/never-requested) [Mail](mailto:test@example.invalid)\n' +
          '`[Ignore](missing-inline.md)`\n' +
          '```md\n[Ignore](missing-fence.md)\n```\n' +
          '~~~~\n[Ignore](missing-tilde.md)\n~~~\n[Still ignore](missing-short-close.md)\n~~~~\n' +
          '    [Ignore](missing-indented.md)\n' +
          '\\[Ignore](missing-escaped.md)\n');
        write('docs/a file.md', '# A file\n');
        write('docs/a(b).md', '# Parentheses\n');
        write('docs/README.md', '# Docs\n[Guide](guide.md) [Spaces](<a file.md>) [Parentheses](a(b).md)\n');
        write('.gitignore', 'ignored.md\n');
        write('ignored.md', '[Missing](missing-ignored.md)\n');
        git('add', '.');
        write('untracked.md', '[Missing](missing-untracked.md)\n');
        assert.deepEqual(checkDocs(root).errors, []);
        assert.equal(checkDocs(root).files, 5);
        const result = run();
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /5 tracked Markdown files/);
      });
    },
  },
  {
    name: 'detects missing targets missing anchors and documents omitted from the index',
    fn() {
      repository(({ root, git, write, run }) => {
        write('docs/README.md', '# Docs\n[Guide](guide.md#missing)\n');
        write('docs/guide.md', '# Guide\n[Broken](../missing.js)\n');
        write('docs/orphan.markdown', '# Orphan\n');
        git('add', '.');
        const errors = checkDocs(root).errors;
        assert.equal(errors.length, 3);
        assert.ok(errors.some((error) => error.includes('heading anchor is missing')));
        assert.ok(errors.some((error) => error.includes('target is missing')));
        assert.ok(errors.some((error) => error.includes('docs/orphan.markdown')));
        assert.equal(run().status, 1);
        write('docs/README.md', '# Docs\n[Guide](guide.md#guide) [Orphan](orphan.markdown)\n');
        write('docs/guide.md', '# Guide\n');
        assert.equal(run().status, 0);
        fs.unlinkSync(path.join(root, 'docs/guide.md'));
        assert.ok(checkDocs(root).errors.some((error) => error.includes('tracked document is missing')));
      });
    },
  },
  {
    name: 'generates distinct formatted Unicode heading anchors and ignores code headings',
    fn() {
      assert.deepEqual([...headings('# API `get()` & **State**\n# 한국어 _용어_\n# Name\n# Name\n# Name-1\n# Name\n' +
        '# [Linked](target.md) name\n# under_score\n```md\n# Hidden\n```\n')], [
        'api-get--state', '한국어-용어', 'name', 'name-1', 'name-1-1', 'name-2', 'linked-name', 'under_score',
      ]);
    },
  },
  {
    name: 'requires a fixed available commit for history checking and rejects malformed CLI arguments',
    fn() {
      repository(({ git, write, run }) => {
        write('docs/design/record.md', '# Record\n\nObserved 3 blocks.\n');
        git('add', '.');
        git('commit', '--quiet', '-m', 'test(docs): record baseline\n\nCreate an immutable comparison.');
        for (const args of [
          ['--history'], ['--history', '--base', 'HEAD'], ['--history', '--base', 'main'],
          ['--history', '--base', git('rev-parse', '--short', 'HEAD')],
          ['--history', '--base', '0'.repeat(40)], ['--history', '--base', '--history'],
          ['--history', '--history'], ['--unknown'], ['--base', git('rev-parse', 'HEAD')],
          ['--history', '--base', git('rev-parse', 'HEAD'), '--base', git('rev-parse', 'HEAD')],
        ]) {
          const result = run(...args);
          assert.equal(result.status, 1, JSON.stringify(args));
          assert.equal(result.stdout, '');
        }
        const result = run('--history', '--base', git('rev-parse', 'HEAD'));
        assert.equal(result.status, 0, result.stderr);
        git('tag', '-a', 'baseline-tag', '-m', 'Fixed tag object');
        assert.equal(run('--history', '--base', git('rev-parse', 'baseline-tag')).status, 1);
      });
    },
  },
  {
    name: 'preserves original bytes against the same fixed baseline before and after a context commit',
    fn() {
      repository(({ root, git, write, run }) => {
        const name = 'docs/qa/record.md';
        write(name, '# Record\n\nObserved 3 blocks.\n');
        git('add', '.');
        git('commit', '--quiet', '-m', 'test(docs): record baseline\n\nRetain the original evidence.');
        const base = git('rev-parse', 'HEAD');
        const wrapped = '# Record\n\n## Record context\n\nCurrent links.\n\n## Original record\n\nObserved 3 blocks.\n';
        write(name, wrapped);
        assert.equal(run('--history', '--base', base).status, 0);
        git('add', '.');
        git('commit', '--quiet', '-m', 'test(docs): add context\n\nLink current guidance without changing evidence.');
        assert.equal(run('--history', '--base', base).status, 0);
        const annotatedBase = git('rev-parse', 'HEAD');
        write(name, wrapped.replace('Current links.', 'Updated links.'));
        assert.deepEqual(checkHistory(root, annotatedBase).errors, []);
        write(name, wrapped.replace('Observed 3', 'Observed 4'));
        assert.match(run('--history', '--base', base).stderr, /original title or body changed/);
        write(name, wrapped.replace('# Record\n', '# Changed title\n'));
        assert.equal(run('--history', '--base', base).status, 1);
        write(name, wrapped.replace('Observed 3 blocks.\n', 'Observed 3 blocks.\r\n'));
        assert.equal(run('--history', '--base', base).status, 1);
        fs.unlinkSync(path.join(root, name));
        assert.match(run('--history', '--base', base).stderr, /historical record was deleted/);
        write(name, wrapped);
        git('rm', '--quiet', name);
        assert.equal(run('--history', '--base', base).status, 1);
        write(name, wrapped);
        git('add', name);
        write('docs/design/new.md', '# New record\n');
        git('add', '.');
        assert.ok(checkHistory(root, base).errors.some((error) => error.includes('no historical record at the baseline')));
      });
    },
  },
  {
    name: 'fails rather than passing when there are no tracked documents or historical records',
    fn() {
      repository(({ root, git, run }) => {
        git('commit', '--quiet', '--allow-empty', '-m', 'test(docs): establish empty baseline\n\nExercise missing scope.');
        assert.equal(run().status, 1);
        assert.match(run('--history', '--base', git('rev-parse', 'HEAD')).stderr, /No historical Markdown records/);
        assert.throws(() => checkDocs(root), /No tracked Markdown/);
      });
    },
  },
  {
    name: 'wires documentation commands into package scripts and CI without adding history enforcement',
    fn() {
      const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8'));
      assert.equal(packageJson.scripts['check:docs'], 'node scripts/check-docs.js');
      assert.equal(packageJson.scripts['check:docs:history'], 'node scripts/check-docs.js --history');
      const workflow = fs.readFileSync(path.join(__dirname, '../.github/workflows/checks.yml'), 'utf8');
      assert.match(workflow, /- run: npm run check:docs\s*\n\s*if: \$\{\{ !cancelled\(\) \}\}/);
      assert.doesNotMatch(workflow, /check:docs:history/);
    },
  },
];
