/**
 * Find risky or malformed Unicode bidirectional controls in text and JSON.
 * Unlike a blanket "strip bidi characters" rule, this linter permits
 * legitimate LRM/RLM/ALM marks and reports balanced isolates as valid.
 *
 * A diagnostic's offset and column are UTF-16 positions (1-based columns).
 * JSON diagnostics use jsonPath and offset *within the decoded string*;
 * they are not raw file byte offsets.
 */

const OPENERS = new Map([
  [0x202a, ['embedding', 'LRE']],
  [0x202b, ['embedding', 'RLE']],
  [0x202d, ['embedding', 'LRO']],
  [0x202e, ['embedding', 'RLO']],
  [0x2066, ['isolate', 'LRI']],
  [0x2067, ['isolate', 'RLI']],
  [0x2068, ['isolate', 'FSI']]
]);
const PDF = 0x202c;
const PDI = 0x2069;
const SAFE_MARKS = new Map([
  [0x061c, 'ALM'],
  [0x200e, 'LRM'],
  [0x200f, 'RLM']
]);
const INVISIBLE = new Map([
  [0x200b, 'ZERO WIDTH SPACE'],
  [0xfeff, 'ZERO WIDTH NO-BREAK SPACE / BOM']
]);

function location(text, offset) {
  const prefix = text.slice(0, offset);
  const lastBreak = prefix.lastIndexOf('\n');
  return {
    line: (prefix.match(/\n/g) ?? []).length + 1,
    column: offset - lastBreak
  };
}

function diagnostic(text, offset, code, severity, message, extra = {}) {
  return { code, severity, message, offset, ...location(text, offset), ...extra };
}

/**
 * Lint an arbitrary Unicode text string.
 * @param {string} text
 * @param {{showMarks?: boolean}} [options]
 * @returns {Array<{code:string,severity:string,message:string,offset:number,line:number,column:number}>}
 */
export function lintText(text, options = {}) {
  if (typeof text !== 'string') throw new TypeError('text must be a string');
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('options must be an object');
  }
  const showMarks = options.showMarks ?? false;
  if (typeof showMarks !== 'boolean') throw new TypeError('showMarks must be a boolean');

  const stack = [];
  const results = [];

  for (let offset = 0; offset < text.length;) {
    const cp = text.codePointAt(offset);
    const codeUnitLength = cp > 0xffff ? 2 : 1;
    const opener = OPENERS.get(cp);

    if (opener) {
      const [kind, name] = opener;
      stack.push({ kind, name, offset });
      if (cp === 0x202d || cp === 0x202e) {
        results.push(diagnostic(text, offset, 'bidi-override', 'error',
          name + ' overrides visual text order and can conceal content.'));
      } else if (kind === 'embedding') {
        results.push(diagnostic(text, offset, 'legacy-bidi-embedding', 'warning',
          name + ' is an explicit bidi embedding; prefer isolated spans.'));
      }
    } else if (cp === PDF) {
      if (stack.length && stack[stack.length - 1].kind === 'embedding') {
        stack.pop();
      } else {
        results.push(diagnostic(text, offset, 'unmatched-pdf', 'error',
          'PDF does not close an active bidi embedding.'));
      }
    } else if (cp === PDI) {
      let match = -1;
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].kind === 'isolate') { match = i; break; }
      }
      if (match === -1) {
        results.push(diagnostic(text, offset, 'unmatched-pdi', 'error',
          'PDI does not close an active bidi isolate.'));
      } else {
        for (let i = stack.length - 1; i > match; i--) {
          results.push(diagnostic(text, stack[i].offset, 'unclosed-bidi-control',
            'error', stack[i].name + ' was not closed before PDI.'));
        }
        stack.length = match;
      }
    } else if (INVISIBLE.has(cp)) {
      results.push(diagnostic(text, offset, 'suspicious-invisible', 'warning',
        INVISIBLE.get(cp) + ' is invisible and may be accidental.'));
    } else if (SAFE_MARKS.has(cp) && showMarks) {
      results.push(diagnostic(text, offset, 'direction-mark', 'info',
        SAFE_MARKS.get(cp) + ' changes directional rendering; verify its use.'));
    }
    offset += codeUnitLength;
  }

  for (const entry of stack) {
    results.push(diagnostic(text, entry.offset, 'unclosed-bidi-control', 'error',
      entry.name + ' was not closed before end of text.'));
  }
  results.sort((a, b) => a.offset - b.offset);
  return results;
}

/**
 * Scan decoded JSON string values; keys are not scanned.
 * The path syntax starts at "$", with array indexes in brackets.
 * @param {string} source JSON source text
 * @param {{showMarks?: boolean}} [options]
 * @returns {Array<object>} Diagnostics with jsonPath, plus string-relative offsets.
 */
export function lintJson(source, options = {}) {
  if (typeof source !== 'string') throw new TypeError('JSON source must be a string');
  const root = JSON.parse(source);
  const diagnostics = [];

  function visit(value, path, depth) {
    if (depth > 250) throw new RangeError('JSON exceeds supported nesting depth.');
    if (typeof value === 'string') {
      for (const result of lintText(value, options)) {
        // The reported line and column are within the decoded string value,
        // not the raw JSON file; jsonPath locates the actual value.
        const { line, column, ...rest } = result;
        diagnostics.push({ ...rest, jsonPath: path });
      }
    } else if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, path + '[' + index + ']', depth + 1));
    } else if (value !== null && typeof value === 'object') {
      for (const [key, item] of Object.entries(value)) {
        visit(item, path + '[' + JSON.stringify(key) + ']', depth + 1);
      }
    }
  }

  visit(root, '$', 0);
  return diagnostics;
}
