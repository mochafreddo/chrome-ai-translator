const suites = [
  require('./commit-format.test'),
  require('./integration-harness.test'),
  require('./placeholder-tokens.test'),
  require('./inline-block.test'),
  require('./inline-translation-session.test'),
  require('./markdown-codec.test'),
  require('./openai-response.test'),
  require('./inline-model-execution.test'),
  require('./button-visibility.test'),
  require('./inline-translation-controls.test'),
  require('./default-model.test'),
  require('./translation-diagnostics.test'),
  require('./inline-diagnostics-controller.test'),
  require('./inline-local-diagnostic-transport.test'),
  require('./inline-translation-operation.test'),
  require('./content-helpers.test'),
  require('./inline-viewport.test'),
  require('./inline-viewport.regression-1.test'),
  require('./background-helpers.test'),
  require('./options-helpers.test'),
  require('./sidepanel-failure.test'),
  require('./sidepanel-helpers.test'),
  require('./sidepanel-tab-state.test'),
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
