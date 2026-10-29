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
    write('package.json', '{"private":true,"devDependencies":{"eslint":"1.0.0"}}');
    write('package-lock.json', '{"lockfileVersion":3,"packages":{"":{"devDependencies":{"eslint":"1.0.0"}},"node_modules/eslint":{}}}');
    write('node_modules/eslint/package.json', '{"name":"eslint","version":"1.0.0","main":"bin/eslint.js"}');
    write('node_modules/eslint/bin/eslint.js', 'console.log("lint fixture");');
    write('scripts/check-syntax.js', 'console.log("syntax fixture");');
    write('scripts/check-docs.js', 'console.log("docs fixture");');
    write('tests/run.js', 'console.log("unit fixture");');
    write('.gitignore', '.env.local\nnode_modules/\n');
    git('add', '.');
    fn({ directory, root, git, write, run });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

exports.name = 'local verification';
exports.tests = [
  {
    name: 'refuses hidden-export metadata outside the checkout or owned by unlocked shadow packages',
    fn() {
      const reuseStatuses = [];
      for (const condition of ['types', 'import']) {
        for (const kind of ['external', 'shadow']) {
          fixture(({ directory, write, git, run }) => {
            const eslint = { name: 'eslint', main: 'bin/eslint.js', optionalDependencies: { fixture: '1.0.0' } };
            const entry = condition === 'types' ? 'index.d.ts' : 'index.mjs';
            const content = condition === 'types' ? 'export declare const result: string;' : 'export default "fixture dependency";';
            const metadata = JSON.stringify({ name: 'fixture', exports: { '.': { [condition]: `./${entry}` } } });
            write('node_modules/eslint/package.json', JSON.stringify(eslint));
            write('package-lock.json', JSON.stringify({ lockfileVersion: 3, packages: {
              '': { devDependencies: { eslint: '1.0.0' } },
              'node_modules/eslint': eslint,
              'node_modules/fixture': { optional: true },
            } }));
            if (kind === 'shadow') {
              write('node_modules/fixture/package.json', metadata);
              write(`node_modules/fixture/${entry}`, content);
              git('add', '.');
              const baseline = path.join(directory, 'baseline');
              assert.equal(run('--output', baseline).status, 0);
              assert.equal(run('--check-reuse', path.join(baseline, 'summary.json')).status, 0);
              write('node_modules/eslint/node_modules/fixture/package.json', metadata);
              write(`node_modules/eslint/node_modules/fixture/${entry}`, content);
            } else {
              fs.mkdirSync(path.join(directory, 'node_modules/fixture'), { recursive: true });
              fs.writeFileSync(path.join(directory, 'node_modules/fixture/package.json'), metadata);
              fs.writeFileSync(path.join(directory, `node_modules/fixture/${entry}`), content);
            }
            git('add', '.');
            const output = path.join(directory, 'evidence');
            assert.equal(run('--output', output).status, 0);
            reuseStatuses.push(run('--check-reuse', path.join(output, 'summary.json')).status);
          });
        }
      }
      assert.deepEqual(reuseStatuses, [1, 1, 1, 1]);
    },
  },
  {
    name: 'qualifies locked type-only and import-only packages with hidden metadata exports',
    fn() {
      const reuseStatuses = [];
      for (const condition of ['types', 'import']) {
        fixture(({ directory, write, git, run }) => {
          const eslint = { name: 'eslint', main: 'bin/eslint.js', dependencies: { fixture: '1.0.0' } };
          write('node_modules/eslint/package.json', JSON.stringify(eslint));
          write('node_modules/fixture/package.json', JSON.stringify({
            name: 'fixture', exports: { '.': { [condition]: condition === 'types' ? './index.d.ts' : './index.mjs' } },
          }));
          write('node_modules/fixture/index.d.ts', 'export declare const result: string;');
          write('node_modules/fixture/index.mjs', 'export default "import-only dependency";');
          write('node_modules/eslint/bin/eslint.js', condition === 'import' ?
            'import("fixture").then((result) => console.log(result.default)).catch(() => { process.exitCode = 1; });' :
            'console.log("type-only dependency metadata");');
          write('package-lock.json', JSON.stringify({ lockfileVersion: 3, packages: {
            '': { devDependencies: { eslint: '1.0.0' } },
            'node_modules/eslint': eslint,
            'node_modules/fixture': {},
          } }));
          git('add', '.');
          const output = path.join(directory, 'evidence');
          assert.equal(run('--output', output).status, 0);
          reuseStatuses.push(run('--check-reuse', path.join(output, 'summary.json')).status);
        });
      }
      assert.deepEqual(reuseStatuses, [0, 0]);
    },
  },
  {
    name: 'qualifies installed dependencies whose bare names resolve to Node builtins',
    fn() {
      fixture(({ directory, write, git, run }) => {
        const eslint = { name: 'eslint', main: 'bin/eslint.js', dependencies: { punycode: '1.0.0' } };
        write('node_modules/eslint/package.json', JSON.stringify(eslint));
        write('node_modules/eslint/bin/eslint.js', 'console.log(require("punycode").toASCII("example.com"));');
        write('node_modules/punycode/package.json', '{"name":"punycode","main":"index.js"}');
        write('node_modules/punycode/index.js', 'throw new Error("bare import must resolve to Node builtin");');
        write('package-lock.json', JSON.stringify({ lockfileVersion: 3, packages: {
          '': { devDependencies: { eslint: '1.0.0' } },
          'node_modules/eslint': eslint,
          'node_modules/punycode': {},
        } }));
        git('add', '.');
        const output = path.join(directory, 'evidence');
        assert.equal(run('--output', output).status, 0);
        assert.equal(run('--check-reuse', path.join(output, 'summary.json')).status, 0);
      });
    },
  },
  {
    name: 'refuses unlocked nested package owners that shadow locked hoisted dependencies',
    fn() {
      const reuseStatuses = [];
      for (const name of ['fixture', '@scope/fixture']) {
        for (const helperPresent of [false, true]) {
          fixture(({ directory, write, git, run }) => {
            const eslint = { name: 'eslint', main: 'bin/eslint.js', dependencies: { [name]: '1.0.0' } };
            write('node_modules/eslint/package.json', JSON.stringify(eslint));
            write(`node_modules/${name}/package.json`, JSON.stringify({ name, main: 'index.js' }));
            write(`node_modules/${name}/index.js`, 'module.exports = "locked hoisted dependency";');
            write('node_modules/eslint/bin/eslint.js', `console.log(require(${JSON.stringify(name)}));`);
            write('package-lock.json', JSON.stringify({ lockfileVersion: 3, packages: {
              '': { devDependencies: { eslint: '1.0.0' } },
              'node_modules/eslint': eslint,
              [`node_modules/${name}`]: {},
            } }));
            git('add', '.');
            const baseline = path.join(directory, 'baseline');
            assert.equal(run('--output', baseline).status, 0);
            assert.equal(run('--check-reuse', path.join(baseline, 'summary.json')).status, 0);
            write(`node_modules/eslint/node_modules/${name}/package.json`, JSON.stringify({
              name, main: 'index.js', dependencies: { helper: '1.0.0' },
            }));
            write(`node_modules/eslint/node_modules/${name}/index.js`,
              'try { module.exports = require("helper"); } catch { module.exports = "missing helper"; }');
            if (helperPresent) {
              fs.mkdirSync(path.join(directory, 'node_modules/helper'), { recursive: true });
              fs.writeFileSync(path.join(directory, 'node_modules/helper/index.js'), 'module.exports = "external helper";');
            }
            const shadow = path.join(directory, 'shadow');
            assert.equal(run('--output', shadow).status, 0);
            reuseStatuses.push(run('--check-reuse', path.join(shadow, 'summary.json')).status);
          });
        }
      }
      assert.deepEqual(reuseStatuses, [1, 1, 1, 1]);
    },
  },
  {
    name: 'allows missing optional dependencies but refuses root and transitive external resolutions',
    fn() {
      for (const owner of ['root', 'transitive']) {
        fixture(({ directory, write, git, run }) => {
          const rootPackage = { devDependencies: { eslint: '1.0.0' } };
          const eslintPackage = { name: 'eslint', main: 'bin/eslint.js' };
          (owner === 'root' ? rootPackage : eslintPackage).optionalDependencies = { fixture: '1.0.0' };
          write('package.json', JSON.stringify(rootPackage));
          write('node_modules/eslint/package.json', JSON.stringify(eslintPackage));
          write('package-lock.json', JSON.stringify({ lockfileVersion: 3, packages: {
            '': rootPackage,
            'node_modules/eslint': eslintPackage,
            'node_modules/fixture': { optional: true },
          } }));
          git('add', '.');
          const output = path.join(directory, 'evidence');
          assert.equal(run('--output', output).status, 0);
          const summary = path.join(output, 'summary.json');
          assert.equal(run('--check-reuse', summary).status, 0);
          fs.mkdirSync(path.join(directory, 'node_modules/fixture'), { recursive: true });
          fs.writeFileSync(path.join(directory, 'node_modules/fixture/index.js'), 'module.exports = 1;');
          assert.equal(run('--check-reuse', summary).status, 1);
          const external = path.join(directory, 'external');
          assert.equal(run('--output', external).status, 0);
          assert.equal(run('--check-reuse', path.join(external, 'summary.json')).status, 1);
        });
      }
    },
  },
  {
    name: 'refuses reuse when a declared dependency resolves from a parent installation',
    fn() {
      fixture(({ directory, write, git, run }) => {
        write('package.json', '{"devDependencies":{"eslint":"1.0.0","fixture":"1.0.0"}}');
        write('package-lock.json', '{"lockfileVersion":3,"packages":{"":{"devDependencies":{"eslint":"1.0.0","fixture":"1.0.0"}},"node_modules/eslint":{},"node_modules/fixture":{}}}');
        fs.mkdirSync(path.join(directory, 'node_modules/fixture'), { recursive: true });
        const external = path.join(directory, 'node_modules/fixture/index.js');
        fs.writeFileSync(external, 'module.exports = "first external dependency";');
        write('node_modules/eslint/bin/eslint.js', 'console.log(require("fixture"));');
        git('add', '.');
        const output = path.join(directory, 'evidence');
        assert.equal(run('--output', output).status, 0);
        assert.equal(run('--check-reuse', path.join(output, 'summary.json')).status, 1);
        fs.writeFileSync(external, 'module.exports = "changed external dependency";');
        assert.equal(run('--check-reuse', path.join(output, 'summary.json')).status, 1);
      });
    },
  },
  {
    name: 'rejects dependency links outside collected inputs without collecting secret contents',
    fn() {
      for (const target of ['external', 'excluded', 'missing']) {
        fixture(({ directory, root, write, run }) => {
          const output = path.join(directory, 'evidence');
          assert.equal(run('--output', output).status, 0);
          const outside = path.join(directory, 'outside.js');
          fs.writeFileSync(outside, 'SYNTHETIC_SECRET=must_not_be_collected');
          write('.env.local', 'SYNTHETIC_SECRET=must_not_be_collected');
          fs.symlinkSync(target === 'external' ? outside : target === 'excluded' ? path.join(root, '.env.local') : 'missing.js',
            path.join(root, 'node_modules/linked.js'));
          assert.equal(run('--check-reuse', path.join(output, 'summary.json')).status, 1);
          const rejected = path.join(directory, 'rejected');
          const result = run('--output', rejected);
          assert.equal(result.status, 1);
          assert.doesNotMatch(result.stdout + result.stderr, /must_not_be_collected/);
          assert.equal(fs.existsSync(rejected), false);
        });
      }
    },
  },
  {
    name: 'rejects dependency changes restored before checks finish',
    fn() {
      for (const source of [
        'fs.writeFileSync("node_modules/fixture/input.js", "during"); fs.writeFileSync("node_modules/fixture/input.js", "before");',
        'fs.writeFileSync("node_modules/fixture/temporary.js", "during"); fs.unlinkSync("node_modules/fixture/temporary.js");',
        'fs.unlinkSync("node_modules/fixture/link.js"); fs.symlinkSync("other.js", "node_modules/fixture/link.js"); fs.unlinkSync("node_modules/fixture/link.js"); fs.symlinkSync("input.js", "node_modules/fixture/link.js");',
      ]) {
        fixture(({ directory, root, write, git, run }) => {
          write('node_modules/fixture/input.js', 'before');
          write('node_modules/fixture/other.js', 'other');
          fs.symlinkSync('input.js', path.join(root, 'node_modules/fixture/link.js'));
          write('tests/run.js', `const fs = require("node:fs"); ${source}`);
          git('add', '.');
          const output = path.join(directory, 'evidence');
          assert.equal(run('--output', output).status, 1);
          const summary = JSON.parse(fs.readFileSync(path.join(output, 'summary.json'), 'utf8'));
          assert.equal(summary.inputsUnchanged, false);
          assert.equal(summary.checks.every(({ exitCode }) => exitCode === 0), true);
          assert.equal(run('--check-reuse', path.join(output, 'summary.json')).status, 1);
        });
      }
    },
  },
  {
    name: 'retains failed verification evidence when dependency links become unreadable during checks',
    fn() {
      fixture(({ directory, root, write, git, run }) => {
        write('node_modules/fixture/target.js', 'module.exports = 1;');
        fs.symlinkSync('target.js', path.join(root, 'node_modules/fixture/link.js'));
        write('tests/run.js', 'require("node:fs").unlinkSync("node_modules/fixture/target.js");');
        git('add', '.');
        const output = path.join(directory, 'evidence');
        assert.equal(run('--output', output).status, 1);
        const summary = JSON.parse(fs.readFileSync(path.join(output, 'summary.json'), 'utf8'));
        assert.equal(summary.inputsUnchanged, false);
        assert.equal(summary.success, false);
        assert.equal(summary.checks.every(({ exitCode }) => exitCode === 0), true);
        assert.equal(run('--check-reuse', path.join(output, 'summary.json')).status, 1);
      });
    },
  },
  {
    name: 'rejects dependency inventory mode and internal link changes while accepting ordinary bin links',
    fn() {
      fixture(({ directory, root, write, run }) => {
        write('node_modules/fixture/a.js', 'module.exports = 1;');
        write('node_modules/fixture/b.js', 'module.exports = 1;');
        fs.mkdirSync(path.join(root, 'node_modules/.bin'));
        const link = path.join(root, 'node_modules/.bin/fixture');
        fs.symlinkSync('../fixture/a.js', link);
        const output = path.join(directory, 'evidence');
        const result = run('--output', output);
        assert.equal(result.status, 0, result.stdout + result.stderr);
        const summary = path.join(output, 'summary.json');
        assert.equal(run('--check-reuse', summary).status, 0);
        write('node_modules/fixture/new.js', 'module.exports = 2;');
        assert.equal(run('--check-reuse', summary).status, 1);
        fs.unlinkSync(path.join(root, 'node_modules/fixture/new.js'));
        assert.equal(run('--check-reuse', summary).status, 0);
        fs.unlinkSync(path.join(root, 'node_modules/fixture/b.js'));
        assert.equal(run('--check-reuse', summary).status, 1);
        write('node_modules/fixture/b.js', 'module.exports = 1;');
        const mode = fs.statSync(path.join(root, 'node_modules/fixture/a.js')).mode & 0o777;
        for (const bit of [0o100, 0o1000]) {
          fs.chmodSync(path.join(root, 'node_modules/fixture/a.js'), mode ^ bit);
          assert.equal(run('--check-reuse', summary).status, 1);
          fs.chmodSync(path.join(root, 'node_modules/fixture/a.js'), mode);
        }
        fs.unlinkSync(link);
        fs.symlinkSync('../fixture/b.js', link);
        assert.equal(run('--check-reuse', summary).status, 1);
      });
    },
  },
  {
    name: 'reuses installed dependency inputs and rejects changed dependency content',
    fn() {
      fixture(({ directory, write, run }) => {
        const output = path.join(directory, 'evidence');
        assert.equal(run('--output', output).status, 0);
        const summary = path.join(output, 'summary.json');
        assert.equal(run('--check-reuse', summary).status, 0);
        write('node_modules/eslint/bin/eslint.js', 'console.log("changed lint fixture");');
        assert.equal(run('--check-reuse', summary).status, 1);
      });
    },
  },
  {
    name: 'records lint arguments and retains failed lint evidence while running other checks',
    fn() {
      fixture(({ directory, write, git, run }) => {
        write('node_modules/eslint/bin/eslint.js', 'console.log(JSON.stringify(process.argv.slice(2))); process.exit(8);');
        git('add', '.');
        const output = path.join(directory, 'evidence');
        assert.equal(run('--output', output).status, 1);
        const summary = JSON.parse(fs.readFileSync(path.join(output, 'summary.json'), 'utf8'));
        assert.deepEqual(summary.checks.map(({ name, exitCode }) => [name, exitCode]),
          [['lint', 8], ['syntax', 0], ['docs', 0], ['unit', 0]]);
        assert.deepEqual(summary.checks[0].command, [process.execPath, 'node_modules/eslint/bin/eslint.js',
          'extension', 'scripts', 'tests', 'eslint.config.mjs', '--max-warnings', '0']);
        assert.deepEqual(JSON.parse(fs.readFileSync(path.join(output, 'lint.log'), 'utf8')),
          ['extension', 'scripts', 'tests', 'eslint.config.mjs', '--max-warnings', '0']);
        assert.equal(run('--check-reuse', path.join(output, 'summary.json')).status, 1);
      });
    },
  },
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
          assert.equal(summary.checks.length, 4);
          assert.equal(summary.checks[0].exitCode, 0);
          assert.equal(summary.checks[2].exitCode, 0);
          assert.equal(summary.checks[3].exitCode, 0);
          assert.equal(source.includes('exit') ? summary.checks[1].exitCode : summary.checks[1].signal,
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
            write('.gitignore', '.env.local\nnode_modules/\nignored.js\n');
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
          [['lint', 0], ['syntax', 0], ['docs', 0], ['unit', 0]]);
        assert.equal(fs.statSync(output).mode & 0o777, 0o700);
        for (const name of ['summary.json', 'lint.log', 'syntax.log', 'docs.log', 'unit.log']) {
          assert.equal(fs.statSync(path.join(output, name)).mode & 0o777, 0o600, name);
        }
        assert.equal(fs.readFileSync(path.join(output, 'unit.log'), 'utf8').trim(), 'unit fixture');
      });
    },
  },
];
