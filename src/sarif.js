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
  if (typeof file !== 'string' || !file) {
    throw new TypeError('SARIF diagnostics require a repository-relative file path.');
  }
  const normalized = file.replaceAll('\\', '/');
  // Code scanning interprets artifact locations relative to the checkout.
  // Never emit an absolute path or parent traversal as a misleading relative
  // link; the CLI must be run from a common containing project directory.
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized) ||
      /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new RangeError('SARIF artifact paths must be relative and must not contain control characters.');
  }
  const segments = normalized.split('/');
  if (segments.some(segment => !segment || segment === '..')) {
    throw new RangeError('SARIF artifact paths must not traverse outside the working directory.');
  }
  const canonical = segments.filter(segment => segment !== '.');
  if (!canonical.length) throw new RangeError('SARIF artifact requires a file path.');
  return canonical.map(encodeURIComponent).join('/');
}
function sarifLevel(severity) {
  return severity === 'error' ? 'error' : severity === 'warning' ? 'warning' : 'note';
}

/** Convert existing diagnostics to SARIF 2.1.0; record failed scans explicitly. */
export function toSarif(diagnostics, { errors = [] } = {}) {
  if (!Array.isArray(diagnostics) || diagnostics.length > LIMIT) {
    throw new RangeError('SARIF export requires at most 50,000 diagnostics.');
  }
  if (!Array.isArray(errors) || errors.some(error => typeof error !== 'string')) {
    throw new TypeError('SARIF scan errors must be an array of messages.');
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
      invocations: [{
        executionSuccessful: errors.length === 0,
        ...(errors.length ? { toolExecutionNotifications: [
          ...errors.slice(0, 500).map(error => ({
            level: 'error',
            message: { text: error.slice(0, 2000) },
          })),
          ...(errors.length > 500 ? [{
            level: 'error',
            message: { text: String(errors.length - 500) +
              ' additional scan errors omitted from SARIF notifications.' },
          }] : []),
        ] } : {}),
      }],
    }],
  };
}
