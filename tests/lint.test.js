const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');

const root = path.resolve(__dirname, '..');
const executable = path.join(root, 'node_modules/eslint/bin/eslint.js');

function lint(filename, input) {
  return spawnSync(process.execPath, [executable, '--stdin', '--stdin-filename', filename,
    '--format', 'json', '--max-warnings', '0'], { cwd: root, input, encoding: 'utf8' });
}

exports.name = 'lint';
exports.tests = [
  {
    name: 'accepts classic extension globals and guarded CommonJS exports',
    fn() {
      const result = lint('extension/content.js',
        "if (typeof module !== 'undefined' && module.exports) module.exports = { read: () => document.title }; chrome.runtime.getURL('options.html');");
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.deepEqual(JSON.parse(result.stdout)[0].messages, []);
    },
  },
  {
    name: 'distinguishes worker, page, CommonJS and ESM runtime globals',
    fn() {
      for (const [filename, source] of [
        ['extension/background.js', "importScripts('module.js'); chrome.runtime.getURL('options.html');"],
        ['scripts/example.js', "const fs = require('node:fs'); module.exports = () => fs.existsSync(process.cwd());"],
        ['scripts/example.cjs', 'module.exports = process.platform;'],
        ['scripts/example.mjs', 'export const platform = process.platform;'],
        ['tests/integration/example.mjs', "import { readFileSync } from 'node:fs'; export const read = () => readFileSync(import.meta.filename);"],
        ['tests/integration/data-as-paragraph.test.mjs', 'captureDomTree(document.body); createViewportProbe(ChromeAiTranslatorInlineTranslationSession.createInlineTranslationSession());'],
      ]) {
        const result = lint(filename, source);
        assert.equal(result.status, 0, result.stdout + result.stderr);
      }
      for (const [filename, source, ruleId] of [
        ['extension/background.js', 'document.title;', 'no-undef'],
        ['extension/content.js', 'process.exit(0);', 'no-undef'],
        ['scripts/example.js', 'document.title;', 'no-undef'],
        ['scripts/example.mjs', 'unknownName();', 'no-undef'],
        ['scripts/example.mjs', "require('node:fs');", 'no-undef'],
        ['scripts/example.mjs', 'console.log(__dirname, __filename);', 'no-undef'],
        ['tests/integration/example.mjs', 'module.exports = {};', 'no-undef'],
        ['tests/example.test.js', 'chrome.runtime.getURL("options.html");', 'no-undef'],
        ['extension/content.js', 'import fs from "node:fs"; fs.readFileSync("example");', null],
      ]) {
        const result = lint(filename, source);
        assert.equal(result.status, 1, result.stdout + result.stderr);
        assert.ok(JSON.parse(result.stdout)[0].messages.some(message => message.ruleId === ruleId));
      }
    },
  },
  {
    name: 'rejects recommended-rule errors and accepts deliberate catch and rest patterns without style rules',
    fn() {
      for (const [source, ruleId] of [
        ['unknownName();', 'no-undef'],
        ['const unused = 1;', 'no-unused-vars'],
        ['if (true) {}', 'no-empty'],
      ]) {
        const result = lint('scripts/example.js', source);
        assert.equal(result.status, 1, result.stdout + result.stderr);
        assert.ok(JSON.parse(result.stdout)[0].messages.some(message => message.ruleId === ruleId));
      }
      const result = lint('scripts/example.js',
        'try { JSON.parse("invalid"); } catch {}\nconst { diagnostic, ...result } = { diagnostic: 1, value: 2 };\n console.log(result)');
      assert.equal(result.status, 0, result.stdout + result.stderr);
    },
  },
  {
    name: 'reports a real file error without modifying the input',
    fn() {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'translator-lint-test-'));
      try {
        const file = path.join(directory, 'extension/content.js');
        fs.mkdirSync(path.dirname(file));
        const original = '  unknownName( "value" )\r\n';
        fs.writeFileSync(file, original);
        const result = spawnSync(process.execPath, [executable, '--config', path.join(root, 'eslint.config.mjs'),
          'extension/content.js', '--format', 'json', '--max-warnings', '0'], { cwd: directory, encoding: 'utf8' });
        assert.equal(result.status, 1, result.stdout + result.stderr);
        assert.ok(JSON.parse(result.stdout)[0].messages.some(message => message.ruleId === 'no-undef'));
        assert.equal(fs.readFileSync(file, 'utf8'), original);
      } finally { fs.rmSync(directory, { recursive: true, force: true }); }
    },
  },
];
