const suiteFiles = [
  'runner',
  'commit-format',
  'integration-harness',
  'placeholder-tokens',
  'inline-block',
  'inline-translation-session',
  'markdown-codec',
  'sidepanel-translation-execution',
  'openai-response',
  'inline-model-execution',
  'button-visibility',
  'inline-translation-controls',
  'default-model',
  'translation-diagnostics',
  'inline-diagnostics-controller',
  'inline-local-diagnostic-transport',
  'inline-translation-operation',
  'content-helpers',
  'inline-viewport',
  'inline-viewport.regression-1',
  'background-helpers',
  'options-helpers',
  'sidepanel-failure',
  'sidepanel-helpers',
  'sidepanel-tab-state',
  'static-assets',
  'live-key',
  'protected-spans',
  'qa-issue-003.regression-1',
];

(async function run() {
  let failures = 0;
  const options = {};
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 2) {
    const option = args[i];
    const value = args[i + 1];
    if (!['--suite', '--test'].includes(option) || !value || value.startsWith('--') || options[option]) {
      throw new Error('Usage: node tests/run.js [--suite <file-stem>] [--test <exact-name>]');
    }
    options[option] = value;
  }
  const files = suiteFiles.filter((file) => !options['--suite'] || file === options['--suite']);
  let selected = 0;

  for (const file of files) {
    const suite = require(`./${file}.test`);
    for (const test of suite.tests) {
      if (options['--test'] && test.name !== options['--test']) continue;
      selected += 1;
      try {
        await test.fn();
        console.log(`PASS ${suite.name} - ${test.name}`);
      } catch (error) {
        failures += 1;
        console.error(`FAIL ${suite.name} - ${test.name}`);
        console.error(error?.stack || error);
      }
    }
  }

  if (selected === 0) throw new Error('No tests matched the selection');

  if (failures > 0) {
    process.exitCode = 1;
  }
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
