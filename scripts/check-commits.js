const { execFileSync } = require('node:child_process');

function git(...args) {
  return execFileSync('git', ['-c', 'core.fsmonitor=false', ...args], { encoding: 'utf8' }).trim();
}

try {
  const [base = 'HEAD^', head = 'HEAD', ...extra] = process.argv.slice(2);
  if (extra.length) throw new Error('Usage: check-commits.js [base] [head]');
  const resolve = (ref) => git('rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`);
  const commits = git('rev-list', '--reverse', `${resolve(base)}..${resolve(head)}`).split('\n').filter(Boolean);
  let failed = false;
  for (const sha of commits) {
    const [subject, ...body] = git('show', '-s', '--format=%B', sha).split('\n');
    const errors = [];
    if (!/^[a-z]+\([a-z0-9][a-z0-9_\/-]*\): \S.*$/.test(subject)) {
      errors.push('subject must use type(scope): description');
    }
    if (body[0] !== '') errors.push('separate subject and body with a blank line');
    if (!body.some((line) => line.trim() && !/^(?:Closes|Refs) #\d+$/.test(line))) {
      errors.push('include an explanatory body');
    }
    if (body.some((line) => line.length > 80 && !/^https?:\/\/\S+$/.test(line))) {
      errors.push('wrap body lines at about 78 columns (maximum 80, except standalone URLs)');
    }
    for (const error of errors) console.error(`FAIL ${sha.slice(0, 7)}: ${error}`);
    failed ||= errors.length > 0;
  }
  if (failed) process.exitCode = 1;
  else console.log(`PASS commit format: ${commits.length} commits checked`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
