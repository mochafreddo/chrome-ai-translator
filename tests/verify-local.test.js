const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '../scripts/verify-local.js');

function fixture(fn) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'translator-verify-test-'));
  const root = path.join(directory, 'repository');
  fs.mkdirSync(root);
  const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null',
    '-c', 'core.fsmonitor=false', '-c', 'user.name=Test',
    '-c', 'user.email=test@example.invalid', ...args], { cwd: root, stdio: 'pipe' }).toString().trim();
  const write = (name, content) => {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), content);
  };
  const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: root, encoding: 'utf8', timeout: 30000,
  });
  try {
    git('init', '--quiet', '--initial-branch=main');
    write('package.json', '{"private":true}');
    write('scripts/check-syntax.js', 'console.log("syntax fixture");');
    write('scripts/check-docs.js', 'console.log("docs fixture");');
    write('tests/run.js', 'console.log("unit fixture");');
    write('.gitignore', '.env.local\n');
    git('add', '.');
    fn({ directory, root, git, write, run });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

exports.name = 'local verification';
exports.tests = [
  {
    name: 'reuses unchanged local inputs across a commit and rejects source or log changes',
    fn() {
      fixture(({ directory, git, write, run }) => {
        const output = path.join(directory, 'evidence');
        const summary = path.join(output, 'summary.json');
        assert.equal(run('--output', output).status, 0);
        assert.equal(run('--check-reuse', summary).status, 0);
        git('commit', '--quiet', '-m', 'test(verification): retain unchanged inputs');
        assert.equal(run('--check-reuse', summary).status, 0);
        write('scripts/check-syntax.js', 'console.log("changed syntax fixture");');
        assert.equal(run('--check-reuse', summary).status, 1);
        write('scripts/check-syntax.js', 'console.log("syntax fixture");');
        assert.equal(run('--check-reuse', summary).status, 0);
        write('new-input.js', 'const changed = true;');
        assert.equal(run('--check-reuse', summary).status, 1);
        fs.unlinkSync(path.join(directory, 'repository/new-input.js'));
        assert.equal(run('--check-reuse', summary).status, 0);
        fs.appendFileSync(path.join(output, 'unit.log'), 'tampered');
        assert.equal(run('--check-reuse', summary).status, 1);
      });
    },
  },
  {
    name: 'applies a private umask to verification subprocesses',
    fn() {
      fixture(({ directory, write, git, run }) => {
        write('tests/run.js', 'console.log(process.umask().toString(8));');
        git('add', '.');
        const output = path.join(directory, 'evidence');
        assert.equal(run('--output', output).status, 0);
        assert.equal(fs.readFileSync(path.join(output, 'unit.log'), 'utf8').trim(), '77');
      });
    },
  },
  {
    name: 'retains failed or interrupted check evidence without permitting reuse',
    fn() {
      for (const source of ['process.exit(7);', 'process.kill(process.pid, "SIGTERM");']) {
        fixture(({ directory, git, write, run }) => {
          write('scripts/check-syntax.js', source);
          git('add', '.');
          const output = path.join(directory, 'failed');
          assert.equal(run('--output', output).status, 1);
          const summaryFile = path.join(output, 'summary.json');
          const summary = JSON.parse(fs.readFileSync(summaryFile, 'utf8'));
          assert.equal(summary.success, false);
          assert.equal(summary.checks.length, 3);
          assert.equal(summary.checks[1].exitCode, 0);
          assert.equal(summary.checks[2].exitCode, 0);
          assert.equal(source.includes('exit') ? summary.checks[0].exitCode : summary.checks[0].signal,
            source.includes('exit') ? 7 : 'SIGTERM');
          assert.equal(run('--check-reuse', summaryFile).status, 1);
        });
      }
    },
  },
  {
    name: 'rejects changed inputs during checks and changed runtime conditions',
    fn() {
      fixture(({ directory, git, write, run, root }) => {
        write('tracked.txt', 'before');
        write('tests/run.js', 'require("node:fs").writeFileSync("tracked.txt", "after");');
        git('add', '.');
        const output = path.join(directory, 'changed');
        assert.equal(run('--output', output).status, 1);
        const summary = JSON.parse(fs.readFileSync(path.join(output, 'summary.json'), 'utf8'));
        assert.equal(summary.inputsUnchanged, false);
        assert.equal(summary.success, false);
        assert.equal(summary.checks.every(({ exitCode }) => exitCode === 0), true);
        write('tests/run.js', 'console.log("unit fixture");');
        const stable = path.join(directory, 'stable');
        assert.equal(run('--output', stable).status, 0);
        const reuse = spawnSync(process.execPath, [SCRIPT, '--check-reuse', path.join(stable, 'summary.json')],
          { cwd: root, encoding: 'utf8', env: { ...process.env, LANG: 'fixture_changed_locale' } });
        assert.equal(reuse.status, 1);
      });
    },
  },
  {
    name: 'preserves existing destinations and rejects linked or exposed evidence',
    fn() {
      fixture(({ directory, root, run }) => {
        const output = path.join(directory, 'evidence');
        assert.equal(run('--output', output).status, 0);
        const original = fs.readFileSync(path.join(output, 'summary.json'));
        assert.equal(run('--output', output).status, 1);
        assert.deepEqual(fs.readFileSync(path.join(output, 'summary.json')), original);
        const link = path.join(directory, 'linked');
        fs.symlinkSync(output, link);
        assert.equal(run('--output', link).status, 1);
        const log = path.join(output, 'unit.log');
        fs.chmodSync(log, 0o644);
        assert.equal(run('--check-reuse', path.join(output, 'summary.json')).status, 1);
        fs.chmodSync(log, 0o600);
        fs.unlinkSync(log);
        fs.symlinkSync(path.join(output, 'docs.log'), log);
        assert.equal(run('--check-reuse', path.join(output, 'summary.json')).status, 1);
        assert.equal(run('--output', path.join(root, 'inside')).status, 1);
        assert.equal(fs.existsSync(path.join(root, 'inside')), false);
      });
    },
  },
  {
    name: 'does not reuse runs with untracked inputs or unmanaged dependencies',
    fn() {
      for (const kind of ['untracked', 'dependency', 'ignored']) {
        fixture(({ directory, write, git, run }) => {
          if (kind === 'untracked') write('untracked.js', 'const input = true;');
          else if (kind === 'dependency') {
            write('package.json', '{"private":true,"devDependencies":{"fixture":"1.0.0"}}');
            git('add', '.');
          } else {
            write('.gitignore', '.env.local\nignored.js\n');
            git('add', '.gitignore');
            write('ignored.js', 'const input = true;');
          }
          const output = path.join(directory, 'evidence');
          assert.equal(run('--output', output).status, 0);
          assert.equal(run('--check-reuse', path.join(output, 'summary.json')).status, 1);
        });
      }
    },
  },
  {
    name: 'keeps ignored secrets out of records and refuses tracked secret sources',
    fn() {
      fixture(({ directory, write, git, run }) => {
        write('.env.local', 'SYNTHETIC_PRIVATE_VALUE=must_not_be_collected');
        const output = path.join(directory, 'evidence');
        assert.equal(run('--output', output).status, 0);
        const summary = path.join(output, 'summary.json');
        write('.env.local', 'SYNTHETIC_PRIVATE_VALUE=changed');
        assert.equal(run('--check-reuse', summary).status, 0);
        assert.doesNotMatch(fs.readFileSync(summary, 'utf8'), /must_not_be_collected|SYNTHETIC_PRIVATE_VALUE/);
        write('.env', 'SYNTHETIC_PRIVATE_VALUE=must_not_be_collected');
        git('add', '--force', '.env');
        const rejected = run('--output', path.join(directory, 'rejected'));
        assert.equal(rejected.status, 1);
        assert.doesNotMatch(rejected.stdout + rejected.stderr, /must_not_be_collected/);
        assert.equal(fs.existsSync(path.join(directory, 'rejected')), false);
      });
    },
  },
  {
    name: 'refuses default evidence output when TMPDIR points inside the checkout',
    fn() {
      fixture(({ root }) => {
        const before = fs.readdirSync(root).sort();
        const result = spawnSync(process.execPath, [SCRIPT], { cwd: root, encoding: 'utf8',
          env: { ...process.env, TMPDIR: root, TMP: root, TEMP: root }, timeout: 30000 });
        assert.equal(result.status, 1);
        assert.deepEqual(fs.readdirSync(root).sort(), before);
      });
    },
  },
  {
    name: 'rejects reuse with external Node loading even when option strings are unchanged',
    fn() {
      fixture(({ directory, root }) => {
        const hook = path.join(directory, 'hook.cjs');
        fs.writeFileSync(hook, 'void 0;');
        const output = path.join(directory, 'evidence');
        const environment = { ...process.env, NODE_OPTIONS: `--require=${hook}` };
        const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], {
          cwd: root, env: environment, encoding: 'utf8', timeout: 30000,
        });
        assert.equal(run('--output', output).status, 0);
        fs.writeFileSync(hook, 'if (process.argv[1].endsWith("/tests/run.js")) process.exit(9);');
        assert.equal(run('--check-reuse', path.join(output, 'summary.json')).status, 1);
        assert.equal(run('--output', path.join(directory, 'fresh')).status, 1);
      });
      fixture(({ directory, root }) => {
        const environment = { ...process.env, NODE_PATH: directory };
        const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], {
          cwd: root, env: environment, encoding: 'utf8', timeout: 30000,
        });
        const output = path.join(directory, 'evidence');
        assert.equal(run('--output', output).status, 0);
        assert.equal(run('--check-reuse', path.join(output, 'summary.json')).status, 1);
      });
    },
  },
  {
    name: 'rejects source changes restored before checks finish',
    fn() {
      for (const source of [
        'fs.writeFileSync("tracked.txt", "during"); fs.writeFileSync("tracked.txt", "before");',
        'fs.writeFileSync("temporary.js", "during"); fs.unlinkSync("temporary.js");',
      ]) {
        fixture(({ directory, write, git, run }) => {
          write('tracked.txt', 'before');
          write('tests/run.js', `const fs = require("node:fs"); ${source}`);
          git('add', '.');
          const output = path.join(directory, 'evidence');
          assert.equal(run('--output', output).status, 1);
          const summary = JSON.parse(fs.readFileSync(path.join(output, 'summary.json'), 'utf8'));
          assert.equal(summary.inputsUnchanged, false);
          assert.equal(summary.checks.every(({ exitCode }) => exitCode === 0), true);
        });
      }
    },
  },
  {
    name: 'rejects Git index changes restored before checks finish',
    fn() {
      fixture(({ directory, write, git, run }) => {
        write('tracked.txt', 'before');
        write('tests/run.js', `const {execFileSync} = require('node:child_process');
execFileSync('git', ['rm', '--cached', 'tracked.txt']);
execFileSync('git', ['add', 'tracked.txt']);`);
        git('add', '.');
        const output = path.join(directory, 'evidence');
        assert.equal(run('--output', output).status, 1);
        const summary = JSON.parse(fs.readFileSync(path.join(output, 'summary.json'), 'utf8'));
        assert.equal(summary.inputsUnchanged, false);
        assert.equal(summary.checks.every(({ exitCode }) => exitCode === 0), true);
      });
    },
  },
  {
    name: 'runs fixed local checks and creates private logs with completion evidence',
    fn() {
      fixture(({ directory, run }) => {
        const output = path.join(directory, 'evidence');
        const result = run('--output', output);
        assert.equal(result.status, 0, result.stdout + result.stderr);
        const summary = JSON.parse(fs.readFileSync(path.join(output, 'summary.json'), 'utf8'));
        assert.equal(summary.success, true);
        assert.deepEqual(summary.checks.map(({ name, exitCode }) => [name, exitCode]),
          [['syntax', 0], ['docs', 0], ['unit', 0]]);
        assert.equal(fs.statSync(output).mode & 0o777, 0o700);
        for (const name of ['summary.json', 'syntax.log', 'docs.log', 'unit.log']) {
          assert.equal(fs.statSync(path.join(output, name)).mode & 0o777, 0o600, name);
        }
        assert.equal(fs.readFileSync(path.join(output, 'unit.log'), 'utf8').trim(), 'unit fixture');
      });
    },
  },
];
