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

const MAX_DIAGNOSTICS = 50_000;
const MAX_SOURCE = 5 * 1024 * 1024;

// Pre-index newline positions once. Computing a prefix for every diagnostic
// used to make scans with many Unicode controls quadratic in source length.
function indexLineStarts(text) {
  const starts = [0];
  let index = 0;
  while ((index = text.indexOf('\n', index)) !== -1) {
    starts.push(index + 1);
    index++;
  }
  return starts;
}
function location(starts, offset) {
  let low = 0, high = starts.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (starts[mid] <= offset) low = mid + 1;
    else high = mid;
  }
  const index = low - 1;
  return { line: index + 1, column: offset - starts[index] + 1 };
}
function diagnostic(starts, offset, code, severity, message, extra = {}) {
  return { code, severity, message, offset, ...location(starts, offset), ...extra };
}

/**
 * Lint an arbitrary Unicode text string.
 * @param {string} text
 * @param {{showMarks?: boolean}} [options]
 * @returns {Array<{code:string,severity:string,message:string,offset:number,line:number,column:number}>}
 */
export function lintText(text, options = {}) {
  if (typeof text !== 'string') throw new TypeError('text must be a string');
  if (text.length > MAX_SOURCE) throw new RangeError('Text exceeds the 5 MiB scan limit.');
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('options must be an object');
  }
  const showMarks = options.showMarks ?? false;
  if (typeof showMarks !== 'boolean') throw new TypeError('showMarks must be a boolean');

  const stack = [];
  const results = [];
  const starts = indexLineStarts(text);
  const add = (offset, code, severity, message, extra = {}) => {
    if (results.length >= MAX_DIAGNOSTICS) {
      throw new RangeError('More than 50,000 bidi findings. Narrow the input instead of dropping results.');
    }
    results.push(diagnostic(starts, offset, code, severity, message, extra));
  };

  for (let offset = 0; offset < text.length;) {
    const cp = text.codePointAt(offset);
    const codeUnitLength = cp > 0xffff ? 2 : 1;
    const opener = OPENERS.get(cp);

    if (opener) {
      const [kind, name] = opener;
      stack.push({ kind, name, offset });
      if (cp === 0x202d || cp === 0x202e) {
        add(offset, 'bidi-override', 'error',
          name + ' overrides visual text order and can conceal content.');
      } else if (kind === 'embedding') {
        add(offset, 'legacy-bidi-embedding', 'warning',
          name + ' is an explicit bidi embedding; prefer isolated spans.');
      }
    } else if (cp === PDF) {
      if (stack.length && stack[stack.length - 1].kind === 'embedding') {
        stack.pop();
      } else {
        add(offset, 'unmatched-pdf', 'error',
          'PDF does not close an active bidi embedding.');
      }
    } else if (cp === PDI) {
      let match = -1;
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].kind === 'isolate') { match = i; break; }
      }
      if (match === -1) {
        add(offset, 'unmatched-pdi', 'error',
          'PDI does not close an active bidi isolate.');
      } else {
        for (let i = stack.length - 1; i > match; i--) {
          add(stack[i].offset, 'unclosed-bidi-control',
            'error', stack[i].name + ' was not closed before PDI.');
        }
        stack.length = match;
      }
    } else if (INVISIBLE.has(cp)) {
      add(offset, 'suspicious-invisible', 'warning',
        INVISIBLE.get(cp) + ' is invisible and may be accidental.');
    } else if (SAFE_MARKS.has(cp) && showMarks) {
      add(offset, 'direction-mark', 'info',
        SAFE_MARKS.get(cp) + ' changes directional rendering; verify its use.');
    }
    offset += codeUnitLength;
  }

  for (const entry of stack) {
    add(entry.offset, 'unclosed-bidi-control', 'error',
      entry.name + ' was not closed before end of text.');
  }
  results.sort((a, b) => a.offset - b.offset);
  return results;
}

/**
 * Scan decoded JSON string values, and optionally object keys.
 * The path syntax starts at "$", with array indexes in brackets.
 * @param {string} source JSON source text
 * @param {{showMarks?: boolean, includeKeys?: boolean}} [options]
 * @returns {Array<object>} Diagnostics with jsonPath, plus string-relative offsets.
 */
export function lintJson(source, options = {}) {
  if (typeof source !== 'string') throw new TypeError('JSON source must be a string');
  if (source.length > MAX_SOURCE) throw new RangeError('JSON source exceeds the 5 MiB scan limit.');
  const root = JSON.parse(source);
  const includeKeys = options?.includeKeys ?? false;
  if (typeof includeKeys !== 'boolean') throw new TypeError('includeKeys must be boolean.');
  const diagnostics = [];

  function visit(value, path, depth) {
    if (depth > 250) throw new RangeError('JSON exceeds supported nesting depth.');
    if (typeof value === 'string') {
      for (const result of lintText(value, options)) {
        // The reported line and column are within the decoded string value,
        // not the raw JSON file; jsonPath locates the actual value.
        const { line, column, ...rest } = result;
        if (diagnostics.length >= MAX_DIAGNOSTICS) throw new RangeError('More than 50,000 JSON bidi findings.');
        diagnostics.push({ ...rest, jsonPath: path });
      }
    } else if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, path + '[' + index + ']', depth + 1));
    } else if (value !== null && typeof value === 'object') {
      for (const [key, item] of Object.entries(value)) {
        const nextPath = path + '[' + JSON.stringify(key) + ']';
        if (includeKeys) {
          for (const result of lintText(key, options)) {
            const { line, column, ...rest } = result;
            if (diagnostics.length >= MAX_DIAGNOSTICS) throw new RangeError('More than 50,000 JSON bidi findings.');
            diagnostics.push({ ...rest, jsonPath: nextPath, locationKind: 'key' });
          }
        }
        visit(item, nextPath, depth + 1);
      }
    }
  }

  visit(root, '$', 0);
  return diagnostics;
}
