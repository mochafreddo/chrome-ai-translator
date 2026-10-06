const assert = require('node:assert/strict');
const { spawnSync, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function checkMessage(message, args = ['HEAD^', 'HEAD']) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'translator-commits-'));
  const git = (...command) => execFileSync('git', [
    '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
    '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...command,
  ], { cwd, encoding: 'utf8', stdio: 'pipe' });
  try {
    git('init', '--quiet', '--initial-branch=main');
    git('commit', '--quiet', '--allow-empty', '-m', 'test(ci): establish baseline\n\nCreate a range for commit checks.');
    git('commit', '--quiet', '--allow-empty', '-m', message);
    return spawnSync(process.execPath, [path.join(__dirname, '../scripts/check-commits.js'), ...args], {
      cwd, encoding: 'utf8',
    });
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
}

exports.name = 'commit format';
exports.tests = [
  {
    name: 'accepts explained commits with issue trailers and standalone URLs',
    fn() {
      const result = checkMessage('fix(inline): preserve child ownership\n\nKeep parent and child records independent.\n\n' +
        'https://example.invalid/' + 'a'.repeat(100) + '\n\nCloses #82');
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /1 commits checked/);
    },
  },
  {
    name: 'rejects malformed subjects missing explanations and unwrapped bodies',
    fn() {
      for (const message of [
        'Merge branch main\n\nInclude the latest collector.',
        'fix: preserve ownership\n\nKeep parent records independent.',
        'fix(inline): preserve ownership',
        'fix(inline): preserve ownership\n\nCloses #82',
        'fix(inline): preserve ownership\n\n' + 'word '.repeat(20),
      ]) {
        const result = checkMessage(message);
        assert.equal(result.status, 1, message);
        assert.match(result.stderr, /FAIL/);
      }
    },
  },
  {
    name: 'fails closed on an invalid range rather than checking no commits',
    fn() {
      assert.equal(checkMessage('test(ci): check range\n\nExercise invalid input.', ['--all', 'HEAD']).status, 1);
    },
  },
  {
    name: 'CI checks rewritten tips and new branches using its actual range script',
    fn() {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'translator-ci-range-'));
      const git = (directory, ...command) => execFileSync('git', [
        '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
        '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...command,
      ], { cwd: directory, encoding: 'utf8', stdio: 'pipe' }).trim();
      try {
        git(cwd, 'init', '--bare', '--quiet', '--initial-branch=main', 'origin');
        git(cwd, 'init', '--quiet', '--initial-branch=main', 'source');
        const source = path.join(cwd, 'source');
        let sequence = 0;
        const commit = () => {
          git(source, 'commit', '--quiet', '--allow-empty', '-m',
            `test(ci): exercise range ${++sequence}\n\nCheck commits without requiring the old tip locally.`);
          return git(source, 'rev-parse', 'HEAD');
        };
        const base = commit();
        const before = commit();
        git(source, 'remote', 'add', 'origin', path.join(cwd, 'origin'));
        git(source, 'push', '--quiet', 'origin', 'main');
        git(source, 'checkout', '--quiet', '-b', 'rewritten', base);
        commit();
        git(source, 'push', '--quiet', 'origin', 'rewritten');
        const head = git(source, 'rev-parse', 'HEAD');
        git(cwd, '--git-dir=origin', 'update-ref', 'refs/heads/main', head);
        git(cwd, 'clone', '--quiet', '--no-local', path.join(cwd, 'origin'), 'checkout');
        const checkout = path.join(cwd, 'checkout');
        assert.throws(() => git(checkout, 'cat-file', '-e', `${before}^{commit}`));
        fs.copyFileSync(path.join(__dirname, '../scripts/check-commits.js'), path.join(checkout, 'check-commits.js'));
        fs.writeFileSync(path.join(checkout, 'package.json'), JSON.stringify({ scripts: {
          'check:commits': 'node check-commits.js',
        } }));
        const workflow = fs.readFileSync(path.join(__dirname, '../.github/workflows/checks.yml'), 'utf8');
        const script = workflow.match(/run: \|\n([\s\S]*?)(?=\n      -|$)/)[1];
        const run = (baseSha, headSha) => {
          const result = spawnSync('bash', ['-e', '-c', script], { cwd: checkout, encoding: 'utf8',
            env: { ...process.env, BASE_SHA: baseSha, HEAD_SHA: headSha } });
          assert.equal(result.status, 0, result.stderr);
          assert.match(result.stdout, /1 commits checked/);
        };
        run(before, head);
        git(checkout, 'checkout', '--quiet', '-b', 'new-feature');
        git(checkout, 'commit', '--quiet', '--allow-empty', '-m',
          'test(ci): exercise a new branch\n\nUse the default branch as the initial comparison.');
        run('0'.repeat(40), git(checkout, 'rev-parse', 'HEAD'));
      } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
    },
  },
];
