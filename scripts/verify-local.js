const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { createRequire, isBuiltin } = require('node:module');

const CHECKS = [
  { name: 'lint', script: 'node_modules/eslint/bin/eslint.js',
    args: ['extension', 'scripts', 'tests', 'eslint.config.mjs', '--max-warnings', '0'] },
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
  const dependencyPath = (name) => /^node_modules(?:\/|$)/.test(name);
  const hasUntrackedInputs = git(root, 'ls-files', '-z', '--others', '--exclude-standard')
    .split('\0').filter(Boolean).some((name) => !dependencyPath(name));
  const hasIgnoredInputs = git(root, 'ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory')
    .split('\0').filter(Boolean).some((name) => !dependencyPath(name) && name !== '.env.local' &&
      !/^\.(?:claude|gstack|superpowers|worktrees)(?:\/|$)/.test(name));
  const names = [...new Set(git(root, 'ls-files', '-z', '--cached')
    .split('\0').filter(Boolean))].sort();
  const source = createHash('sha256');
  const dependencies = createHash('sha256');
  const stability = createHash('sha256');
  const directories = new Set([root]);
  function observe(name) {
    const info = fs.lstatSync(name, { bigint: true });
    stability.update(JSON.stringify([name, info.dev.toString(), info.ino.toString(),
      info.size.toString(), info.mtimeNs.toString(), info.ctimeNs.toString()]));
  }
  const dependencyRoot = path.join(root, 'node_modules');
  function collectDependency(file) {
    const info = fs.lstatSync(file);
    const name = path.relative(root, file);
    if (info.isSymbolicLink()) {
      const target = fs.realpathSync(file);
      if (!inside(root, target) || (!inside(dependencyRoot, target) && !names.includes(path.relative(root, target)))) {
        throw new Error('Local verification dependency links must target collected checkout inputs.');
      }
      dependencies.update(JSON.stringify([name, 'link', info.mode & 0o7777, fs.readlinkSync(file), path.relative(root, target)]));
    } else if (info.isFile()) dependencies.update(JSON.stringify([name, 'file', info.mode & 0o7777, hash(fs.readFileSync(file))]));
    else if (info.isDirectory()) {
      dependencies.update(JSON.stringify([name, 'directory', info.mode & 0o7777]));
      for (const child of fs.readdirSync(file).sort()) collectDependency(path.join(file, child));
    } else throw new Error('Local verification dependencies must contain supported checkout files.');
    observe(file);
  }
  const dependenciesInstalled = fs.existsSync(dependencyRoot);
  if (dependenciesInstalled) collectDependency(dependencyRoot);
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
  let managedDependencies = false;
  if (dependenciesInstalled && names.includes('package-lock.json')) {
    const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
    const locked = lock.packages?.[''];
    managedDependencies = Boolean(locked) && ['dependencies', 'devDependencies', 'optionalDependencies'].every((key) =>
      JSON.stringify(Object.entries(configuration[key] || {}).sort()) === JSON.stringify(Object.entries(locked[key] || {}).sort()));
    if (managedDependencies) {
      try {
        const collectedResolution = (file) => {
          const target = fs.realpathSync(file);
          if (!inside(dependencyRoot, target)) return names.includes(path.relative(root, target));
          const segments = path.relative(root, target).split(path.sep);
          const start = segments.lastIndexOf('node_modules') + 1;
          const owner = segments.slice(0, start + (segments[start]?.startsWith('@') ? 2 : 1)).join('/');
          return Object.hasOwn(lock.packages, owner);
        };
        managedDependencies = Object.entries(lock.packages).every(([location, entry]) => {
          if (location && !dependencyPath(location)) return false;
          const directory = location ? path.join(root, location) : root;
          if (!fs.existsSync(directory)) return Boolean(entry.optional);
          if (location && !inside(dependencyRoot, fs.realpathSync(directory))) return false;
          const manifest = path.join(directory, 'package.json');
          if (location && !inside(dependencyRoot, fs.realpathSync(manifest))) return false;
          const installed = location ? JSON.parse(fs.readFileSync(manifest, 'utf8')) : configuration;
          const resolve = createRequire(manifest).resolve;
          return [entry, installed].every((declaration) =>
            ['dependencies', 'optionalDependencies', 'peerDependencies', ...(location ? [] : ['devDependencies'])].every((key) =>
              Object.keys(declaration[key] || {}).every((name) => {
                let found = false;
                let missing = true;
                for (const request of [name, `${name}/package.json`]) {
                  if (isBuiltin(request)) { found = true; continue; }
                  try {
                    if (!collectedResolution(resolve(request))) return false;
                    found = true;
                  } catch (error) {
                    if (!['MODULE_NOT_FOUND', 'ERR_PACKAGE_PATH_NOT_EXPORTED'].includes(error.code)) return false;
                    if (error.code !== 'MODULE_NOT_FOUND') missing = false;
                  }
                }
                if (!missing) {
                  const metadata = (resolve.paths(`${name}/package.json`) || [])
                    .map((directory) => path.join(directory, name, 'package.json')).find(fs.existsSync);
                  if (!metadata || !collectedResolution(metadata)) return false;
                  found = true;
                }
                const optional = key === 'optionalDependencies' || Boolean(declaration.optionalDependencies?.[name]) ||
                  (key === 'peerDependencies' && declaration.peerDependenciesMeta?.[name]?.optional === true);
                return found || (optional && missing);
              })));
        });
      } catch { managedDependencies = false; }
    }
  }
  return { stabilityHash: stability.digest('hex'), context: {
    root, checkoutIdentity: [checkout.dev, checkout.ino, gitDirectory, gitInfo.dev, gitInfo.ino],
    sourceHash: source.digest('hex'), runnerHash: hash(fs.readFileSync(__filename)),
    nodeVersion: process.version, nodePath: fs.realpathSync(process.execPath),
    gitVersion: git(root, '--version').trim(), platform: process.platform, arch: process.arch,
    osRelease: os.release(), dependencyHash: dependencies.digest('hex'), managedDependencies, hasUntrackedInputs, hasIgnoredInputs,
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
    !current.managedDependencies || !current.plainNode || current.hasUntrackedInputs || current.hasIgnoredInputs ||
    JSON.stringify(summary.inputs) !== JSON.stringify(current) ||
    !Array.isArray(summary.checks) || summary.checks.length !== CHECKS.length) {
    throw new Error('Local verification cannot be reused: inputs, conditions or successful completion differ.');
  }
  for (const [index, { name, script, args = [] }] of CHECKS.entries()) {
    const result = summary.checks[index];
    const log = path.join(directory, `${name}.log`);
    requirePrivate(log);
    if (result.name !== name || result.exitCode !== 0 || result.signal !== null || result.errorCode !== null ||
      JSON.stringify(result.command) !== JSON.stringify([process.execPath, script, ...args]) ||
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
  for (const { name, script, args = [] } of CHECKS) {
    const log = path.join(directory, `${name}.log`);
    const descriptor = fs.openSync(log, 'wx', 0o600);
    const startedAt = new Date().toISOString();
    let result;
    try {
      result = spawnSync(process.execPath, [script, ...args], {
        cwd: root, stdio: ['ignore', descriptor, descriptor], timeout: 600000,
      });
    } finally { fs.closeSync(descriptor); }
    requirePrivate(log);
    checks.push({ name, command: [process.execPath, script, ...args], startedAt,
      finishedAt: new Date().toISOString(), exitCode: result.status, signal: result.signal,
      errorCode: result.error?.code || null, log: `${name}.log`, logHash: hash(fs.readFileSync(log)) });
    console.log(`${result.status === 0 ? 'PASS' : 'FAIL'} local verification: ${name}`);
  }
  let inputsUnchanged = false;
  try { inputsUnchanged = JSON.stringify(before) === JSON.stringify(inputs(root)); }
  catch {}
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
