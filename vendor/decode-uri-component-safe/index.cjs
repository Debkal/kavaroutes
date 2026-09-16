'use strict';

const HEX_PAIR = /^[0-9a-fA-F]{2}$/;

/**
 * CommonJS-compatible, linear-time tolerant URI-component decoder.
 * Invalid byte runs are retained literally, matching the dependency's
 * historical best-effort contract without its exponential retry behavior.
 */
module.exports = function decodeUriComponentSafe(value) {
  if (typeof value !== 'string') {
    throw new TypeError('Expected a string');
  }

  const normalized = value.replaceAll('+', ' ');
  try {
    return decodeURIComponent(normalized);
  } catch {
    let output = '';
    for (let index = 0; index < normalized.length;) {
      if (normalized[index] !== '%' || !HEX_PAIR.test(normalized.slice(index + 1, index + 3))) {
        output += normalized[index];
        index += 1;
        continue;
      }

      let end = index;
      while (normalized[end] === '%' && HEX_PAIR.test(normalized.slice(end + 1, end + 3))) {
        end += 3;
      }
      const run = normalized.slice(index, end);
      try {
        output += decodeURIComponent(run);
      } catch {
        output += run;
      }
      index = end;
    }
    return output;
  }
};
