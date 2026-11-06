const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const run = (...args) => spawnSync(process.execPath, [path.join(__dirname, 'run.js'), ...args], {
  encoding: 'utf8', timeout: 30000,
});

exports.name = 'unit runner';
exports.tests = [{
  name: 'exits unsuccessfully when a selected test never settles',
  fn() {
    const result = spawnSync(process.execPath, ['-e', `
      require('./default-model.test').tests[0].fn = () => new Promise(() => {});
      process.argv = [process.execPath, 'run.js', '--suite', 'default-model'];
      require('./run.js');
    `], { cwd: __dirname, encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /did not settle/);
  },
}, {
  name: 'selects a suite by its exact file stem',
  fn() {
    const result = run('--suite', 'default-model');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim().split('\n').length, require('./default-model.test').tests.length);
    assert.ok(result.stdout.trim().split('\n').every((line) => line.startsWith('PASS default model - ')));
  },
}, {
  name: 'selects an exact test alone or within a suite',
  fn() {
    const name = 'agrees with the settings the worker stores when the reader has chosen none';
    for (const args of [[], ['--suite', 'default-model']]) {
      const result = run(...args, '--test', name);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, `PASS default model - ${name}\n`);
    }
  },
}, {
  name: 'fails on empty selections and invalid options without running checks',
  fn() {
    for (const args of [
      ['--suite', 'default'], ['--test', 'agrees'],
      ['--suite', 'default-model', '--test', 'missing'],
      ['--unknown', 'value'], ['--suite'], ['--test', '--suite', 'default-model'],
      ['--suite', 'default-model', '--suite', 'runner'],
    ]) {
      const result = run(...args);
      assert.equal(result.status, 1, JSON.stringify(args));
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /Usage:|No tests matched/);
    }
  },
}];
