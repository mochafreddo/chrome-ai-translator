const suites = [
  require('./placeholder-tokens.test'),
  require('./inline-block.test'),
  require('./markdown-codec.test'),
  require('./openai-response.test'),
  require('./translation-validation.test'),
  require('./button-visibility.test'),
  require('./inline-translation-controls.test'),
  require('./translation-policy.test'),
  require('./default-model.test'),
  require('./translation-diagnostics.test'),
  require('./inline-diagnostics-controller.test'),
  require('./content-helpers.test'),
  require('./background-helpers.test'),
  require('./options-helpers.test'),
  require('./sidepanel-failure.test'),
  require('./sidepanel-helpers.test'),
  require('./static-assets.test'),
  require('./live-key.test'),
  require('./protected-spans.test'),
  require('./qa-issue-003.regression-1.test'),
];

(async function run() {
  let failures = 0;

  for (const suite of suites) {
    for (const test of suite.tests) {
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

  if (failures > 0) {
    process.exitCode = 1;
  }
})();
