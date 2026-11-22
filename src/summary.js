/**
 * Redacted, aggregate-only summary of a complete Unicode bidi lint scan.
 * Never include source paths, JSON paths, raw text, offsets or messages.
 * The caller must fail closed rather than publish incomplete results.
 */
const CODES = Object.freeze([
  'bidi-override', 'legacy-bidi-embedding', 'unmatched-pdf',
  'unmatched-pdi', 'unclosed-bidi-control', 'suspicious-invisible',
  'direction-mark', 'other',
]);
const SEVERITIES = Object.freeze(['error', 'warning', 'info']);

export function lintSummary(diagnostics, { scannedFiles, scanErrors = 0 } = {}) {
  if (!Array.isArray(diagnostics) || diagnostics.length > 50_000 ||
      !Number.isSafeInteger(scannedFiles) || scannedFiles < 0 || scannedFiles > 5000 ||
      !Number.isSafeInteger(scanErrors) || scanErrors < 0) {
    throw new TypeError('Expected a bounded Unicode lint scan.');
  }
  if (scanErrors) {
    throw new Error('The scan is incomplete; no counts-only report was generated.');
  }
  const bySeverity = Object.fromEntries(SEVERITIES.map(level => [level, 0]));
  const byRule = Object.fromEntries(CODES.map(code => [code, 0]));
  for (const finding of diagnostics) {
    if (!finding || typeof finding !== 'object' ||
        !SEVERITIES.includes(finding.severity)) {
      throw new TypeError('Invalid bidi finding severity.');
    }
    bySeverity[finding.severity]++;
    const code = typeof finding.code === 'string' && CODES.includes(finding.code)
      ? finding.code : 'other';
    byRule[code]++;
  }
  return {
    format: 'bidi-lint-summary-v1',
    complete: true,
    scannedFiles,
    totalFindings: diagnostics.length,
    bySeverity,
    byRule,
    advisory: 'Aggregate counts only. No source text, paths, JSON paths, or finding positions are included.',
  };
}
