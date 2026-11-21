/**
 * SARIF 2.1.0 output for GitHub Code Scanning and compatible analyzers.
 *
 * Diagnostics on decoded JSON keys/values deliberately do not invent raw
 * source line numbers. For such findings the JSON path is retained in result
 * properties and the artifact URI points at the file, without a region.
 *
 * https://docs.oasis-open.org/sarif/sarif/v2.1.0/sarif-v2.1.0.html
 */
const RULES = Object.freeze({
  'bidi-override': ['error', 'Unicode direction override can hide visible content.'],
  'legacy-bidi-embedding': ['warning', 'Legacy bidi embedding should be reviewed.'],
  'unmatched-pdf': ['error', 'Unbalanced PDF direction control.'],
  'unmatched-pdi': ['error', 'Unbalanced PDI direction control.'],
  'unclosed-bidi-control': ['error', 'Bidi control remains unclosed.'],
  'suspicious-invisible': ['warning', 'Unexpected invisible Unicode character.'],
  'direction-mark': ['note', 'Explicit direction mark may be intentional.'],
});
const LIMIT = 50_000;

function artifactUri(file) {
  if (typeof file !== 'string' || !file) throw new TypeError('Diagnostic requires a relative file name.');
  // URI-encode individual segments while retaining directory separators.
  return file.replaceAll('\\', '/').split('/').map(segment =>
    segment === '..' || segment === '.' ? segment : encodeURIComponent(segment)
  ).join('/');
}
function sarifLevel(severity) {
  return severity === 'error' ? 'error' : severity === 'warning' ? 'warning' : 'note';
}

/** Convert existing diagnostics to a SARIF 2.1.0 log without reading files. */
export function toSarif(diagnostics) {
  if (!Array.isArray(diagnostics) || diagnostics.length > LIMIT) {
    throw new RangeError('SARIF export requires at most 50,000 diagnostics.');
  }
  const knownRules = new Map();
  const results = [];
  for (const finding of diagnostics) {
    if (!finding || typeof finding !== 'object' ||
        typeof finding.code !== 'string' || typeof finding.file !== 'string') {
      throw new TypeError('Malformed linter diagnostic.');
    }
    const [defaultLevel, description] = RULES[finding.code] ??
      [sarifLevel(finding.severity), 'Unicode directionality finding.'];
    if (!knownRules.has(finding.code)) {
      knownRules.set(finding.code, {
        id: finding.code,
        shortDescription: { text: description },
        defaultConfiguration: { level: defaultLevel },
        properties: { tags: ['security', 'unicode', 'localization'] },
      });
    }
    const physicalLocation = { artifactLocation: { uri: artifactUri(finding.file) } };
    if (!finding.jsonPath) {
      // This region is in the original text file, not a decoded JSON string.
      if (!Number.isInteger(finding.line) || finding.line < 1 ||
          !Number.isInteger(finding.column) || finding.column < 1) {
        throw new TypeError('Source text finding is missing its line/column.');
      }
      physicalLocation.region = {
        startLine: finding.line,
        startColumn: finding.column,
      };
    }
    const locationName = finding.jsonPath
      ? ' (decoded JSON ' + (finding.locationKind === 'key' ? 'key' : 'value') +
        ' at ' + finding.jsonPath + ', offset ' + finding.offset + ')'
      : '';
    results.push({
      ruleId: finding.code,
      level: sarifLevel(finding.severity),
      message: { text: String(finding.message ?? description) + locationName },
      locations: [{ physicalLocation }],
      ...(finding.jsonPath ? { properties: {
        jsonPath: finding.jsonPath,
        decodedStringOffset: finding.offset,
        locationKind: finding.locationKind === 'key' ? 'key' : 'value',
      } } : {}),
    });
  }
  return {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [{
      tool: { driver: {
        name: 'bidi-lint',
        version: '0.1.0',
        informationUri: 'https://github.com/MeiRR17/bidi-lint',
        rules: [...knownRules.values()],
      } },
      results,
    }],
  };
}
