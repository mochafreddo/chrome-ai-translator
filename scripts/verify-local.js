const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');

const CHECKS = [
  { name: 'syntax', script: 'scripts/check-syntax.js' },
  { name: 'docs', script: 'scripts/check-docs.js' },
  { name: 'unit', script: 'tests/run.js' },
];

const hash = (value) => createHash('sha256').update(value).digest('hex');
const inside = (parent, target) => target === parent || target.startsWith(parent + path.sep);

function git(root, ...args) {
  return execFileSync('git', ['-c', 'core.fsmonitor=false', ...args], {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function requirePrivate(file, directory = false) {
  const info = fs.lstatSync(file);
  if ((directory ? !info.isDirectory() : !info.isFile()) ||
    (info.mode & 0o777) !== (directory ? 0o700 : 0o600) || info.uid !== process.getuid()) {
    throw new Error('Verification evidence must be owned by the current user and private.');
  }
}

function inputs(root) {
  const checkout = fs.statSync(root);
  const gitDirectory = fs.realpathSync(git(root, 'rev-parse', '--absolute-git-dir').trim());
  const gitInfo = fs.statSync(gitDirectory);
  const hasUntrackedInputs = Boolean(git(root, 'ls-files', '-z', '--others', '--exclude-standard').length);
  const hasIgnoredInputs = git(root, 'ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory')
    .split('\0').filter(Boolean).some((name) => name !== '.env.local' &&
      !/^\.(?:claude|gstack|superpowers|worktrees)(?:\/|$)/.test(name));
  const names = [...new Set(git(root, 'ls-files', '-z', '--cached')
    .split('\0').filter(Boolean))].sort();
  const source = createHash('sha256');
  const stability = createHash('sha256');
  const directories = new Set([root]);
  function observe(name) {
    const info = fs.statSync(name, { bigint: true });
    stability.update(JSON.stringify([name, info.dev.toString(), info.ino.toString(),
      info.size.toString(), info.mtimeNs.toString(), info.ctimeNs.toString()]));
  }
  for (const name of names) {
    if (/(?:^|\/)(?:\.env(?:\.|$)|\.aws\/|\.ssh\/|\.npmrc$)|\.(?:pem|key|p12|pfx)$/i.test(name)) {
      throw new Error('Secret-bearing source paths are outside local verification input collection.');
    }
    const file = path.join(root, name);
    if (fs.realpathSync(file) !== file || !fs.lstatSync(file).isFile()) {
      throw new Error('Local verification inputs must be regular files inside the checkout.');
    }
    source.update(JSON.stringify([name, fs.statSync(file).mode & 0o777, hash(fs.readFileSync(file))]));
    observe(file);
    for (let parent = path.dirname(file); parent !== root; parent = path.dirname(parent)) directories.add(parent);
  }
  for (const directory of [...directories].sort()) observe(directory);
  if (names.length) observe(path.resolve(root, git(root, 'rev-parse', '--git-path', 'index').trim()));
  const configuration = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const dependencyFree = !fs.existsSync(path.join(root, 'node_modules')) &&
    ['dependencies', 'devDependencies', 'optionalDependencies'].every((key) =>
      Object.keys(configuration[key] || {}).length === 0);
  return { stabilityHash: stability.digest('hex'), context: {
    root, checkoutIdentity: [checkout.dev, checkout.ino, gitDirectory, gitInfo.dev, gitInfo.ino],
    sourceHash: source.digest('hex'), runnerHash: hash(fs.readFileSync(__filename)),
    nodeVersion: process.version, nodePath: fs.realpathSync(process.execPath),
    gitVersion: git(root, '--version').trim(), platform: process.platform, arch: process.arch,
    osRelease: os.release(), dependencyFree, hasUntrackedInputs, hasIgnoredInputs,
    plainNode: !process.execArgv.length && !process.env.NODE_OPTIONS && !process.env.NODE_PATH,
    conditionsHash: hash(JSON.stringify({ flags: process.execArgv, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      environment: ['PATH', 'TZ', 'LANG', 'LC_ALL', 'LC_CTYPE', 'NODE_OPTIONS', 'NODE_PATH', 'CI']
        .map((name) => [name, process.env[name] || '']) })) } };
}

function checkReuse(root, requested) {
  const target = path.resolve(requested);
  if (path.basename(target) !== 'summary.json') throw new Error('Reuse requires a summary.json record.');
  const directory = fs.realpathSync(path.dirname(target));
  requirePrivate(directory, true);
  const file = path.join(directory, 'summary.json');
  requirePrivate(file);
  let summary;
  try { summary = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { throw new Error('Invalid verification record.'); }
  const current = inputs(root).context;
  if (summary.schemaVersion !== 1 || summary.success !== true || summary.inputsUnchanged !== true ||
    !current.dependencyFree || !current.plainNode || current.hasUntrackedInputs || current.hasIgnoredInputs ||
    JSON.stringify(summary.inputs) !== JSON.stringify(current) ||
    !Array.isArray(summary.checks) || summary.checks.length !== CHECKS.length) {
    throw new Error('Local verification cannot be reused: inputs, conditions or successful completion differ.');
  }
  for (const [index, { name, script }] of CHECKS.entries()) {
    const result = summary.checks[index];
    const log = path.join(directory, `${name}.log`);
    requirePrivate(log);
    if (result.name !== name || result.exitCode !== 0 || result.signal !== null || result.errorCode !== null ||
      JSON.stringify(result.command) !== JSON.stringify([process.execPath, script]) ||
      result.log !== `${name}.log` || result.logHash !== hash(fs.readFileSync(log))) {
      throw new Error('Local verification cannot be reused: check completion or log integrity differs.');
    }
  }
  console.log(`PASS unchanged local verification: ${file}`);
}

function outputDirectory(root, requested) {
  let directory;
  if (requested) {
    const target = path.resolve(requested);
    directory = path.join(fs.realpathSync(path.dirname(target)), path.basename(target));
    const temporaryRoots = [os.tmpdir(), '/tmp'].filter(fs.existsSync).map((name) => fs.realpathSync(name));
    if (!temporaryRoots.some((parent) => inside(parent, directory)) || inside(root, directory)) {
      throw new Error('Verification output must be a new temporary directory outside the repository.');
    }
    fs.mkdirSync(directory, { mode: 0o700 });
  } else {
    if (inside(root, fs.realpathSync(os.tmpdir()))) {
      throw new Error('The system temporary directory must be outside the repository.');
    }
    directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'translator-verify-')));
  }
  requirePrivate(directory, true);
  return directory;
}

function main(args) {
  process.umask(0o077);
  if (args.length && (args.length !== 2 || !['--output', '--check-reuse'].includes(args[0]) || !args[1])) {
    throw new Error('Usage: verify-local.js [--output <new-temporary-directory> | --check-reuse <summary.json>]');
  }
  const root = fs.realpathSync(git(process.cwd(), 'rev-parse', '--show-toplevel').trim());
  if (args[0] === '--check-reuse') return checkReuse(root, args[1]);
  const before = inputs(root);
  const directory = outputDirectory(root, args[1]);
  const checks = [];
  for (const { name, script } of CHECKS) {
    const log = path.join(directory, `${name}.log`);
    const descriptor = fs.openSync(log, 'wx', 0o600);
    const startedAt = new Date().toISOString();
    let result;
    try {
      result = spawnSync(process.execPath, [script], {
        cwd: root, stdio: ['ignore', descriptor, descriptor], timeout: 600000,
      });
    } finally { fs.closeSync(descriptor); }
    requirePrivate(log);
    checks.push({ name, command: [process.execPath, script], startedAt,
      finishedAt: new Date().toISOString(), exitCode: result.status, signal: result.signal,
      errorCode: result.error?.code || null, log: `${name}.log`, logHash: hash(fs.readFileSync(log)) });
    console.log(`${result.status === 0 ? 'PASS' : 'FAIL'} local verification: ${name}`);
  }
  const inputsUnchanged = JSON.stringify(before) === JSON.stringify(inputs(root));
  const success = inputsUnchanged && checks.every((check) => check.exitCode === 0 && !check.signal && !check.errorCode);
  const summary = path.join(directory, 'summary.json');
  fs.writeFileSync(summary, JSON.stringify({ schemaVersion: 1, success, inputs: before.context, inputsUnchanged, checks }, null, 2) + '\n',
    { flag: 'wx', mode: 0o600 });
  requirePrivate(summary);
  console.log(`Verification record: ${summary}`);
  process.exitCode = success ? 0 : 1;
}

try { main(process.argv.slice(2)); }
catch (error) { console.error(error.message); process.exitCode = 1; }
