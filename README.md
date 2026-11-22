# bidi-lint

**Find risky or unbalanced right-to-left (RTL) Unicode controls before shipping translations.**

A zero-dependency Node.js command-line linter and ES-module library for JSON/ARB localization files and multilingual text. It detects visual text overrides, malformed isolates, unbalanced embeddings, and suspicious invisible characters without automatically removing valid Hebrew or Arabic formatting.

## Quick start

Requires Node.js 22+; no package installation is needed to run the CLI from a clone.

\`\`\`sh
node bin/bidi-lint.js --help
node bin/bidi-lint.js locales/
node bin/bidi-lint.js --json --strict locales/he.json
node bin/bidi-lint.js --show-marks content/he.md
node bin/bidi-lint.js --include-keys --json locales/he.json
node bin/bidi-lint.js --sarif --include-keys locales/ > bidi-lint.sarif
node bin/bidi-lint.js --summary-only --strict locales/ > bidi-summary.json
node bin/bidi-lint.js --summary-only --max-warnings 5 locales/ > bidi-budget.json
node bin/bidi-lint.js --summary-only --max-rule-warnings legacy-bidi-embedding=0 --max-rule-warnings suspicious-invisible=3 locales/ > bidi-rule-budgets.json
\`\`\`

For project usage, the package declares a \`bidi-lint\` bin executable and \`./src/index.js\` module exports.

## What it reports

| Diagnostic | Severity | Meaning |
|---|---|---|
| \`bidi-override\` | Error | LRO/RLO control can make text render in deceptive order |
| \`legacy-bidi-embedding\` | Warning | Explicit LRE/RLE embedding is used |
| \`unmatched-pdf\` | Error | PDF occurs without an active embedding |
| \`unmatched-pdi\` | Error | PDI occurs without an active isolate |
| \`unclosed-bidi-control\` | Error | Isolate or embedding is not closed |
| \`suspicious-invisible\` | Warning | Invisible ZWSP or in-text BOM detected |
| \`direction-mark\` | Info | Optional LRM/RLM/ALM annotations with \`--show-marks\` |

Balanced LRI/RLI/FSI isolates are allowed. Ordinary bidirectional text is not reported just because it mixes Hebrew, Arabic, English, and numbers. LRM/RLM/ALM marks are often intentional and are reported only when requested.

## File support

Recursively scans JSON, ARB, TXT, MD, YAML/YML, PO, and Apple .strings when passed a directory; common build and dependency folders are skipped. Explicit file arguments may use other extensions.

JSON and ARB are parsed, and **decoded string values** are linted with a stable \`jsonPath\` location. Other files are scanned as text with line and column locations. YAML/PO/.strings contents are scanned as raw text; escaped Unicode sequences are not decoded in these formats.

The tool scans files without changing them, does not follow symbolic links, and limits scanning to 5,000 files and 5 MiB per file. File bytes are decoded with **strict UTF-8**; invalid UTF-8 fails the scan rather than silently substituting replacement characters. An optional leading UTF-8 byte-order mark is accepted. File size is rechecked after reading in case it changed after discovery. The library also caps individual source strings at 5 MiB and returns at most 50,000 findings; excessive findings result in an explicit error rather than an incomplete report. The CLI separately limits the **total across all scanned files** to 50,000 findings. When that aggregate limit is exceeded, it exits with status 2 **without emitting a partial JSON, text or SARIF report**.

Exit statuses: \`0\` = no lint failures; \`1\` = errors (or warnings when \`--strict\`, or warnings above the optional \`--max-warnings\` budget); \`2\` = usage or file errors. \`--json\` emits a machine-readable report containing counts, findings, and file errors.

### Incremental warning budgets

Use `--max-warnings N` to allow **at most N warnings across the complete scan**, with `N` an integer from 0 to 50,000. Unlike `--strict` (which fails on any warning), this allows teams to ratchet down legacy warnings without letting newly introduced warnings silently grow. If warnings exceed the budget, the CLI exits **1** and writes only counts and the configured threshold to stderr; it does not change report finding order or redact new source details. A scan/read/parse error still has exit status **2**, which takes precedence over the warning budget; regular errors always fail irrespective of the budget. The `--strict` policy still fails on all warnings even when a larger budget is supplied. Both detailed `--json` and redacted `--summary-only` JSON output include `warningBudget` and `warningBudgetExceeded` when the flag is used, while SARIF retains its standard structure and reports the budget violation via the process exit status. The option does not change files or suppress findings.

### Per-rule warning budgets

Use repeatable `--max-rule-warnings RULE=N` to cap each supported **warning rule independently**. Supported names are exactly `legacy-bidi-embedding` and `suspicious-invisible`; each may be supplied at most once, with a whole-number limit from 0 to 50,000. For example, `--max-rule-warnings legacy-bidi-embedding=0` forbids all legacy embeddings while `--max-rule-warnings suspicious-invisible=3` permits up to three invisible-character warnings. Unrecognized names, duplicate rules or invalid limits cause a usage failure (exit **2**). This is intentionally **warning-only**: error-severity findings always fail and informational annotations are not budgetable.

A per-rule budget violation produces exit **1** and a rule-name/count/threshold message on stderr, without file names, source text, positions or raw values. The existing aggregate `--max-warnings N` and `--strict` options apply independently: passing the per-rule thresholds does not override a stricter global cap. JSON and `--summary-only` include `warningRuleBudgets` with fixed, enumerated rule names, observed warning counts, limits and `exceeded` flags, plus `warningRuleBudgetExceeded` when configured. SARIF retains its standard schema; the exit status and stderr disclose budget failure. Scan/read/parse errors remain exit **2**; `--summary-only` still emits no partial report when that occurs. Aggregate counts can reveal activity patterns, though they contain no file paths or text.

### Counts-only CI reporting

Use \`--summary-only\` to write a strictly **aggregate-only JSON** report with scanned-file count, totals by severity and per-rule counts. It intentionally excludes paths, JSON paths, source text, positions, messages, and individual findings. **If any file cannot be collected, read, decoded, or parsed, the command exits 2 and emits no summary**, rather than presenting partial counts as complete. Error output in this mode includes only the count of scan failures. Existing \`--strict\` changes warning-related exit status, not the summary content. The CLI output mode is mutually exclusive with \`--json\` and \`--sarif\`.

Programmatic usage: \`import { lintSummary } from './src/summary.js'\` then \`lintSummary(findings, { scannedFiles, scanErrors: 0 })\`. The helper rejects explicitly incomplete scans, caps inputs at 50,000 findings, and normalizes unfamiliar rule codes to an \`other\` count rather than exposing arbitrary strings. Aggregate counts themselves may be sensitive.

### SARIF for code scanning

Use **\`--sarif\`** to produce SARIF 2.1.0 on standard output for code scanning:

    node bin/bidi-lint.js --sarif --include-keys locales/ > bidi-lint.sarif

The output includes rule metadata, severity levels and file locations. **SARIF requires repository-relative paths**: invoke the CLI from a common containing directory and scan files beneath it. Absolute paths, parent-directory traversal (`../`), empty path segments and control characters are rejected in SARIF artifact locations rather than being presented as misleading code-scanning links. Ordinary text/JSON scanning retains its existing file-selection behavior. For ordinary TXT, Markdown, YAML and other raw-text scans, findings have source line/column coordinates. For JSON/ARB, the linter scans **decoded** values and keys; it **does not invent file line coordinates**. Such SARIF results identify the file only and include the JSON path, decoded-string offset and key/value type in their message and properties. This distinction is important for honest annotations in code-scanning interfaces.

If any files could not be scanned or parsed, SARIF records `invocations[].executionSuccessful: false` and includes bounded tool-execution notifications; a failed scan is never labeled as a complete success. The CLI still returns exit status 2. Programmatic callers can pass `toSarif(findings, {errors: ['description']})`.

\`--sarif\` and \`--json\` are mutually exclusive. The CLI retains its usual exit codes, including \`--strict\`. The SARIF generator limits output to 50,000 diagnostics rather than silently dropping findings. No source file is modified and no data is uploaded by this tool. To upload SARIF into GitHub Code Scanning, configure that separately in your workflow, with an appropriate token and repository permissions.

Programmatic use:

    import { toSarif } from './src/sarif.js';
    const sarif = toSarif([{file: 'example.md', code: 'bidi-override',
      severity: 'error', line: 1, column: 3, offset: 2,
      message: 'RLO can obscure visible content.'}]);

The published module subpath is \`bidi-lint/sarif\`. Programmatic SARIF callers must supply repository-relative `finding.file` values; optional leading `./` segments are normalized away. This is an output-location integrity restriction, not a filesystem sandbox or symlink resolver.


## Library usage

\`\`\`js
import { lintText, lintJson } from './src/index.js';

console.log(lintText('שלום\u202eabc'));
console.log(lintJson('{"welcome":"שלום"}'));
console.log(lintJson('{"welcome":"שלום"}', {includeKeys: true}));
\`\`\`

Source-line lookup is indexed once per input instead of scanning every text prefix for each diagnostic, improving performance on files containing many directionality controls. The API uses UTF-16 string offsets. JSON findings report decoded string offsets and paths, not raw source-file line positions. When `includeKeys: true`, key diagnostic offsets are relative to the decoded key itself; values continue to be reported relative to their decoded value.

## Privacy

Everything runs locally. No network requests, accounts, or third-party runtime dependencies are required.

## Author

Built by Meir Dvir · [https://github.com/MeiRR17](https://github.com/MeiRR17)
