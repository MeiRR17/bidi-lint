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

The tool scans files without changing them, does not follow symbolic links, and limits scanning to 5,000 files and 5 MiB per file.

Exit statuses: \`0\` = no lint failures; \`1\` = errors (or warnings when \`--strict\`); \`2\` = usage or file errors. \`--json\` emits a machine-readable report containing counts, findings, and file errors.

## Library usage

\`\`\`js
import { lintText, lintJson } from './src/index.js';

console.log(lintText('שלום\u202eabc'));
console.log(lintJson('{"welcome":"שלום"}'));
\`\`\`

The API uses UTF-16 string offsets. JSON findings report decoded string offsets and paths, not raw source-file line positions.

## Privacy

Everything runs locally. No network requests, accounts, or third-party runtime dependencies are required.

## Author

Built by Meir Dvir · [https://github.com/MeiRR17](https://github.com/MeiRR17)
