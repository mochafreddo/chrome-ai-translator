const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const extensionDir = path.join(process.cwd(), 'extension');
const files = fs.readdirSync(extensionDir, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith('.js'))
  .map((entry) => path.join(extensionDir, entry.name))
  .sort();

if (files.length === 0) {
  console.error(`No extension JavaScript files found in ${extensionDir}`);
  process.exitCode = 1;
} else {
  for (const file of files) {
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.error) {
      console.error(result.error.message);
      process.exitCode = 1;
      break;
    }
    if (result.status !== 0) {
      process.exitCode = 1;
      break;
    }
  }
}
