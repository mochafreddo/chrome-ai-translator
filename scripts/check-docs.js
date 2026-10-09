const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function git(root, ...args) {
  return execFileSync('git', ['-c', 'core.fsmonitor=false', ...args], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
}

const isMarkdown = (name) => /\.(?:md|markdown)$/.test(name);
const isHistorical = (name) => /^docs\/(?:design|qa|superpowers)\//.test(name) && isMarkdown(name);
const listFiles = (buffer) => buffer.toString('utf8').split('\0').filter(Boolean);

function localPath(root, target) {
  const outside = (name) => {
    const relative = path.relative(root, name);
    return relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
  };
  if (outside(target)) throw new Error('target is outside the repository');
  if (!fs.existsSync(target)) throw new Error('target is missing');
  if (outside(fs.realpathSync(target))) throw new Error('target resolves outside the repository');
}

function withoutCodeBlocks(text) {
  let fence = null;
  return text.split('\n').map((line) => {
    const match = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (match && match[1][0] === fence[0] && match[1].length >= fence.length && !match[2].trim()) fence = null;
      return '';
    }
    if (match && !(match[1][0] === '`' && match[2].includes('`'))) {
      fence = match[1];
      return '';
    }
    return /^(?: {4}|\t)/.test(line) ? '' : line;
  }).join('\n');
}

function escaped(text, index) {
  let count = 0;
  while (index > 0 && text[--index] === '\\') count += 1;
  return count % 2 === 1;
}

function maskInlineCode(text) {
  const runs = [...text.matchAll(/`+/g)];
  const chars = text.split('');
  for (let i = 0; i < runs.length; i += 1) {
    const start = runs[i];
    if (escaped(text, start.index)) continue;
    const end = runs.findIndex((candidate, j) => j > i && candidate[0].length === start[0].length);
    if (end < 0) continue;
    for (let j = start.index; j < runs[end].index + runs[end][0].length; j += 1) {
      if (chars[j] !== '\n') chars[j] = ' ';
    }
    i = end;
  }
  return chars.join('');
}

function closing(text, start, open, close) {
  let depth = 1;
  for (let i = start + 1; i < text.length; i += 1) {
    if (escaped(text, i)) continue;
    if (text[i] === open) depth += 1;
    if (text[i] === close && --depth === 0) return i;
  }
  return -1;
}

function destination(text, start) {
  let i = start + 1;
  while (/\s/.test(text[i] || '') && i < text.length) i += 1;
  const begin = i;
  let value;
  if (text[i] === '<') {
    const end = text.indexOf('>', i + 1);
    if (end < 0 || text.slice(i, end).includes('\n')) return null;
    value = text.slice(i + 1, end);
    i = end + 1;
  } else {
    let depth = 0;
    while (i < text.length) {
      if (!escaped(text, i)) {
        if (/\s/.test(text[i]) || (text[i] === ')' && depth === 0)) break;
        if (text[i] === '(') depth += 1;
        if (text[i] === ')') depth -= 1;
      }
      i += 1;
    }
    if (depth !== 0) return null;
    value = text.slice(begin, i);
  }
  const beforeSpace = i;
  while (/\s/.test(text[i] || '') && i < text.length) i += 1;
  if (i > beforeSpace && ['"', "'", '('].includes(text[i])) {
    const delimiter = text[i];
    if (delimiter === '(') i = closing(text, i, '(', ')');
    else {
      i += 1;
      while (i < text.length && (text[i] !== delimiter || escaped(text, i))) i += 1;
    }
    if (i < 0 || i >= text.length) return null;
    i += 1;
    while (/\s/.test(text[i] || '') && i < text.length) i += 1;
  }
  return text[i] === ')' ? { value: value.replace(/\\([\\()[\]<> ])/g, '$1'), end: i } : null;
}

function links(text) {
  const found = [];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== '[' || escaped(text, i)) continue;
    const end = closing(text, i, '[', ']');
    if (end < 0 || text[end + 1] !== '(') continue;
    const target = destination(text, end + 1);
    if (!target) continue;
    found.push({ target: target.value, label: text.slice(i + 1, end), start: i, end: target.end });
    i = target.end;
  }
  return found;
}

function headings(text) {
  const result = new Set();
  for (const line of withoutCodeBlocks(text).split('\n')) {
    const match = line.match(/^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$/);
    if (!match) continue;
    let label = match[1];
    for (const link of links(label).reverse()) {
      label = label.slice(0, link.start) + link.label + label.slice(link.end + 1);
    }
    label = label.replace(/<[^>]*>/g, '').replace(/[*~`]/g, '').replace(/\\([\p{P}\p{S}])/gu, '$1');
    label = label.replace(/(?<![\p{L}\p{N}])_([^_]+)_(?![\p{L}\p{N}])/gu, '$1');
    const slug = label.toLowerCase().replace(/[^\p{L}\p{N}\p{M}_\-\s]/gu, '').replace(/ /g, '-');
    let unique = slug;
    for (let n = 1; result.has(unique); n += 1) unique = `${slug}-${n}`;
    result.add(unique);
  }
  return result;
}

function checkDocs(root) {
  root = fs.realpathSync(root);
  const files = listFiles(git(root, 'ls-files', '-z', '--', '*.md', '*.markdown'));
  if (!files.length) throw new Error('No tracked Markdown files to check.');
  const errors = [];
  const indexed = new Set();
  let count = 0;
  for (const name of files) {
    const source = path.join(root, name);
    if (!fs.existsSync(source)) { errors.push(`${name}: tracked document is missing`); continue; }
    try { localPath(root, source); }
    catch (error) { errors.push(`${name}: ${error.message}`); continue; }
    const text = withoutCodeBlocks(fs.readFileSync(source, 'utf8'));
    for (const link of links(maskInlineCode(text))) {
      if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(link.target)) continue;
      count += 1;
      const line = text.slice(0, link.start).split('\n').length;
      try {
        const hash = link.target.indexOf('#');
        const pathname = decodeURIComponent((hash < 0 ? link.target : link.target.slice(0, hash)).split('?')[0]);
        const fragment = hash < 0 ? '' : decodeURIComponent(link.target.slice(hash + 1));
        const target = pathname ? path.resolve(path.dirname(source), pathname) : source;
        const relative = path.relative(root, target);
        localPath(root, target);
        if (name === 'docs/README.md') indexed.add(relative.split(path.sep).join('/'));
        if (fragment && isMarkdown(target) && !headings(fs.readFileSync(target, 'utf8')).has(fragment)) throw new Error('heading anchor is missing');
      } catch (error) { errors.push(`${name}:${line}: ${link.target}: ${error.message}`); }
    }
  }
  for (const name of files.filter((name) => name.startsWith('docs/') && name !== 'docs/README.md')) {
    if (!indexed.has(name)) errors.push(`docs/README.md: document is not indexed: ${name}`);
  }
  return { errors, files: files.length, links: count };
}

function originalRecord(buffer) {
  const separator = Buffer.from('\n## Original record\n');
  const boundary = buffer.indexOf(separator);
  if (boundary < 0) return buffer;
  const titleEnd = buffer.indexOf('\n');
  return Buffer.concat([buffer.subarray(0, titleEnd + 1), buffer.subarray(boundary + separator.length)]);
}

function checkHistory(root, base) {
  root = fs.realpathSync(root);
  if (!/^[a-f0-9]{40}$/.test(base || '')) throw new Error('History checking requires --base <full 40-character commit hash>; moving refs are not allowed.');
  try { if (git(root, 'cat-file', '-t', base).toString('utf8').trim() !== 'commit') throw new Error('Not a commit'); }
  catch { throw new Error(`History baseline is not an available commit: ${base}`); }
  const historical = (names) => names.filter(isHistorical);
  const previous = historical(listFiles(git(root, 'ls-tree', '-r', '--name-only', '-z', base)));
  const current = historical(listFiles(git(root, 'ls-files', '-z')));
  const errors = [];
  for (const name of new Set([...previous, ...current])) {
    if (!previous.includes(name)) errors.push(`${name}: no historical record at the baseline`);
    else if (!current.includes(name) || !fs.existsSync(path.join(root, name))) errors.push(`${name}: historical record was deleted`);
    else {
      try {
        localPath(root, path.join(root, name));
        if (!originalRecord(git(root, 'show', `${base}:${name}`)).equals(originalRecord(fs.readFileSync(path.join(root, name))))) errors.push(`${name}: original title or body changed`);
      } catch (error) { errors.push(`${name}: ${error.message}`); }
    }
  }
  if (!previous.length && !current.length) errors.push('No historical Markdown records to compare.');
  return { errors, files: current.length, base };
}

function main(args) {
  let history = false;
  let base;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--history' && !history) history = true;
    else if (args[i] === '--base' && base === undefined && args[i + 1] && !args[i + 1].startsWith('--')) base = args[++i];
    else throw new Error('Usage: check-docs.js [--history --base <full-commit-hash>]');
  }
  if (!history && base !== undefined) throw new Error('--base is only valid with --history.');
  const root = git(process.cwd(), 'rev-parse', '--show-toplevel').toString('utf8').trim();
  const result = history ? checkHistory(root, base) : checkDocs(root);
  for (const error of result.errors) console.error(`FAIL ${error}`);
  if (result.errors.length) process.exitCode = 1;
  else console.log(history
    ? `PASS historical titles and original bodies: ${result.files} records against ${base}`
    : `PASS documentation: ${result.files} tracked Markdown files, ${result.links} local links; anchors and index coverage checked`);
}

module.exports = { checkDocs, checkHistory, headings, links, originalRecord };
if (require.main === module) {
  try { main(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
