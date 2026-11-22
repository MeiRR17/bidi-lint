#!/usr/bin/env node
import { lstat, readFile, readdir } from 'node:fs/promises';
import { extname, join, relative, resolve } from 'node:path';
import { lintText, lintJson } from '../src/index.js';
import { toSarif } from '../src/sarif.js';
import { lintSummary } from '../src/summary.js';

const ACCEPTED = new Set(['.json', '.arb', '.txt', '.md', '.yaml', '.yml', '.po', '.strings']);
const JSON_EXTENSIONS = new Set(['.json', '.arb']);
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage', '.next']);
const MAX_FILES = 5000;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_REPORT_FINDINGS = 50_000;
// Decode as UTF-8 strictly: replacement characters can conceal bidi controls.
// The decoder also accepts and strips an optional leading UTF-8 BOM.
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });
const HELP = [
  'bidi-lint v0.1.0 — Find risky Unicode direction controls',
  '',
  'Usage: bidi-lint [options] <file-or-directory> [...]',
  '',
  'Options:',
  '  --json          Print one machine-readable JSON report',
  '  --sarif         Print SARIF 2.1.0 for GitHub Code Scanning',
  '  --summary-only  Print counts-only JSON; fail closed on scan errors',
  '  --strict        Treat warnings as failures (errors always fail)',
  '  --show-marks    Include informational LRM/RLM/ALM diagnostics',
  '  --include-keys  Also scan decoded JSON/ARB object keys, not only values',
  '  --help, -h      Show this help',
  '  --version       Print the version',
  '',
  'Directories: recursively scan .json, .arb, .txt, .md, .yaml, .yml,',
  '             .po and .strings; skip common dependency/build folders.',
  'Explicit file arguments can have any extension.',
  'JSON/ARB: lint decoded string values with exact JSON paths.',
  '          --include-keys adds key-name inspection (off by default).',
  'Other formats: scan raw source text with line and column numbers.',
  '',
  'Exit codes: 0 = no failures, 1 = lint failures, 2 = usage/I/O error.',
  'No files are modified. Only Node.js built-ins are required.',
  ''
].join('\n');

function argsFrom(argv) {
  const options = { json: false, sarif: false, summaryOnly: false, strict: false, showMarks: false, includeKeys: false, inputs: [] };
  let positional = false;
  for (const arg of argv) {
    if (positional) { options.inputs.push(arg); continue; }
    if (arg === '--') { positional = true; continue; }
    if (arg === '--help' || arg === '-h') return { help: true };
    if (arg === '--version') return { version: true };
    if (arg === '--json') options.json = true;
    else if (arg === '--sarif') options.sarif = true;
    else if (arg === '--summary-only') options.summaryOnly = true;
    else if (arg === '--strict') options.strict = true;
    else if (arg === '--show-marks') options.showMarks = true;
    else if (arg === '--include-keys') options.includeKeys = true;
    else if (arg.startsWith('-')) throw new Error('Unknown option: ' + arg);
    else options.inputs.push(arg);
  }
  if (Number(options.sarif) + Number(options.json) + Number(options.summaryOnly) > 1) {
    throw new Error('--sarif, --json and --summary-only are mutually exclusive.');
  }
  if (!options.inputs.length) throw new Error('Provide at least one file or directory.');
  return options;
}

async function collect(inputPath, files, seen, errors, explicit = true) {
  if (files.length >= MAX_FILES) {
    throw new Error('File limit reached (5,000). Narrow the directory selection.');
  }
  let stats;
  try {
    stats = await lstat(inputPath);
  } catch (error) {
    errors.push(inputPath + ': ' + error.message);
    return;
  }
  if (stats.isSymbolicLink()) {
    if (explicit) errors.push(inputPath + ': symbolic links are not followed.');
    return;
  }
  if (stats.isDirectory()) {
    const entries = await readdir(inputPath, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name, 'en'));
    for (const entry of entries) {
      if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
      if (entry.isDirectory()) {
        await collect(join(inputPath, entry.name), files, seen, errors, false);
      } else if (entry.isFile() && ACCEPTED.has(extname(entry.name).toLowerCase())) {
        await collect(join(inputPath, entry.name), files, seen, errors, false);
      }
    }
    return;
  }
  if (!stats.isFile()) {
    if (explicit) errors.push(inputPath + ': not a regular file.');
    return;
  }
  const absolute = resolve(inputPath);
  if (!seen.has(absolute)) {
    seen.add(absolute);
    files.push({ path: absolute, bytes: stats.size });
  }
}

async function main() {
  let args;
  try {
    args = argsFrom(process.argv.slice(2));
  } catch (error) {
    process.stderr.write('bidi-lint: ' + error.message + '\nRun bidi-lint --help for usage.\n');
    process.exitCode = 2;
    return;
  }

  if (args.help) { process.stdout.write(HELP); return; }
  if (args.version) { process.stdout.write('0.1.0\n'); return; }

  const files = [];
  const errors = [];
  const seen = new Set();
  try {
    for (const input of args.inputs) await collect(resolve(input), files, seen, errors);
  } catch (error) {
    errors.push(error.message);
  }

  const results = [];
  let findingCount = 0;
  for (const file of files) {
    const path = relative(process.cwd(), file.path) || file.path;
    if (file.bytes > MAX_FILE_BYTES) {
      errors.push(path + ': file exceeds 5 MiB.');
      continue;
    }
    try {
      // Bound the actual read as well as the earlier stat. Files can grow
      // between collection and scanning; never silently scan a partial file.
      const bytes = await readFile(file.path);
      if (bytes.length > MAX_FILE_BYTES) {
        errors.push(path + ': file exceeds 5 MiB after collection.');
        continue;
      }
      const source = UTF8_DECODER.decode(bytes);
      const parsed = JSON_EXTENSIONS.has(extname(file.path).toLowerCase());
      const diagnostics = parsed
        ? lintJson(source, { showMarks: args.showMarks, includeKeys: args.includeKeys })
        : lintText(source, { showMarks: args.showMarks });
      if (findingCount + diagnostics.length > MAX_REPORT_FINDINGS) {
        process.stderr.write('bidi-lint: report exceeds 50,000 findings across files. ' +
          'Narrow the selection; no incomplete report was generated.\n');
        process.exitCode = 2;
        return;
      }
      findingCount += diagnostics.length;
      results.push({ file: path, diagnostics });
    } catch (error) {
      errors.push(path + ': ' + error.message);
    }
  }

  const all = results.flatMap(entry =>
    entry.diagnostics.map(diagnostic => ({ file: entry.file, ...diagnostic }))
  );
  const counts = {
    errors: all.filter(d => d.severity === 'error').length,
    warnings: all.filter(d => d.severity === 'warning').length,
    info: all.filter(d => d.severity === 'info').length
  };

  if (args.summaryOnly) {
    if (errors.length) {
      process.stderr.write('bidi-lint: incomplete scan (' + errors.length +
        ' file or parse errors). No summary was generated.\n');
      process.exitCode = 2;
      return;
    }
    process.stdout.write(JSON.stringify(lintSummary(all, {
      scannedFiles: results.length, scanErrors: 0,
    }), null, 2) + '\n');
  } else if (args.sarif) {
    process.stdout.write(JSON.stringify(toSarif(all, { errors }), null, 2) + '\n');
    for (const error of errors) process.stderr.write('bidi-lint: ' + error + '\n');
  } else if (args.json) {
    process.stdout.write(JSON.stringify({
      tool: 'bidi-lint', version: '0.1.0',
      scannedFiles: results.length, counts,
      diagnostics: all, errors
    }, null, 2) + '\n');
  } else {
    for (const d of all) {
      const spot = d.jsonPath
        ? d.jsonPath + ' (' + (d.locationKind === 'key' ? 'key' : 'value') + ' offset ' + d.offset + ')'
        : d.line + ':' + d.column;
      process.stdout.write(d.file + ':' + spot + ' [' + d.severity + '] ' +
        d.code + ': ' + d.message + '\n');
    }
    for (const error of errors) process.stderr.write('bidi-lint: ' + error + '\n');
    process.stdout.write(
      results.length + ' files scanned · ' +
      counts.errors + ' errors · ' +
      counts.warnings + ' warnings · ' +
      counts.info + ' info\n'
    );
  }

  if (errors.length) process.exitCode = 2;
  else if (counts.errors || (args.strict && counts.warnings)) process.exitCode = 1;
}

await main().catch(error => {
  process.stderr.write('bidi-lint: ' + (error instanceof Error ? error.message : String(error)) + '\n');
  process.exitCode = 2;
});
