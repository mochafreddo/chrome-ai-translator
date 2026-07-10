const suites = [
  require('./inline-block.test'),
  require('./content-helpers.test'),
  require('./background-helpers.test'),
  require('./options-helpers.test'),
  require('./sidepanel-helpers.test'),
  require('./static-assets.test'),
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
