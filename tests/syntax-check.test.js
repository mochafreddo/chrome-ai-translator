const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CHECK_SCRIPT = path.join(__dirname, '..', 'scripts', 'check-syntax.js');

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'translator-syntax-'));
  fs.mkdirSync(path.join(root, 'extension'));
  return root;
}

function runCheck(root, nodeArgs = []) {
  const result = spawnSync(process.execPath, [...nodeArgs, CHECK_SCRIPT], { cwd: root, encoding: 'utf8' });
  return { status: result.status, output: `${result.stdout || ''}${result.stderr || ''}` };
}

exports.name = 'syntax check';
exports.tests = [
  {
    name: 'checks valid extension scripts discovered from the working directory',
    fn() {
      const root = createFixture();
      try {
        const extensionDir = path.join(root, 'extension');
        fs.writeFileSync(path.join(extensionDir, 'new-script.js'), 'const value = 1;\n');
        fs.mkdirSync(path.join(extensionDir, 'nested'));
        fs.writeFileSync(path.join(extensionDir, 'nested', 'ignored.js'), 'const = ;\n');
        fs.writeFileSync(path.join(root, 'symlink-target.js'), 'const = ;\n');
        fs.symlinkSync(path.join(root, 'symlink-target.js'), path.join(extensionDir, 'linked.js'));

        assert.equal(runCheck(root).status, 0);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'reports syntax errors from newly discovered extension scripts',
    fn() {
      const root = createFixture();
      try {
        fs.writeFileSync(path.join(root, 'extension', 'z-new-invalid-script.js'), 'const = ;\n');
        fs.writeFileSync(path.join(root, 'extension', 'a-new-invalid-script.js'), 'const = ;\n');
        const preload = path.join(root, 'filesystem.cjs');
        fs.writeFileSync(preload, `const fs = require('node:fs');
const readDirectory = fs.readdirSync;
fs.readdirSync = (...args) => {
  const entries = readDirectory(...args);
  return ['z-new-invalid-script.js', 'a-new-invalid-script.js']
    .map(name => entries.find(entry => entry.name === name));
};
`);
        const result = runCheck(root, ['--require', preload]);

        assert.equal(result.status, 1);
        assert.match(result.output, /a-new-invalid-script\.js/);
        assert.equal(result.output.includes('z-new-invalid-script.js'), false);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'rejects an empty extension script set',
    fn() {
      const root = createFixture();
      try {
        const result = runCheck(root);

        assert.equal(result.status, 1);
        assert.match(result.output, /No extension JavaScript files found/);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  },
];
