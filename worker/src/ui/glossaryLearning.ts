export interface GlossarySuggestion {
  from: string;
  to: string;
}

const OUTER_PUNCT_RE =
  /^[\s"'„“‚‘«»()[\]{}.,!?;:…–—]+|[\s"'„“‚‘«»()[\]{}.,!?;:…–—]+$/g;
const HAS_ALNUM_RE = /[\p{L}\p{N}]/u;
const MAX_TOKENS = 250;
const MAX_SPAN_WORDS = 3;
const MAX_SUGGESTIONS = 4;
const MAX_TERM_LEN = 80;

function tokenizeWords(raw: string): string[] {
  const out: string[] = [];
  for (const part of raw.trim().split(/\s+/)) {
    const clean = part.replace(OUTER_PUNCT_RE, '');
    if (clean) out.push(clean);
  }
  return out;
}

/**
 * Extract localized 1–3 word replacement pairs from an inline transcript edit
 * so corrected names or domain terms can be saved to the persistent Glossary in one click.
 */
export function extractGlossarySuggestions(
  originalText: string,
  editedText: string
): GlossarySuggestion[] {
  const orig = tokenizeWords(originalText);
  const edit = tokenizeWords(editedText);
  if (
    orig.length === 0 ||
    edit.length === 0 ||
    orig.length > MAX_TOKENS ||
    edit.length > MAX_TOKENS
  ) {
    return [];
  }

  // Exact-match LCS to anchor unchanged context tokens
  const m = orig.length;
  const n = edit.length;
  const dp: Uint16Array[] = Array.from(
    { length: m + 1 },
    () => new Uint16Array(n + 1)
  );
  for (let i = m - 1; i >= 0; i--) {
    const row = dp[i];
    const nextRow = dp[i + 1];
    for (let j = n - 1; j >= 0; j--) {
      if (orig[i] === edit[j]) {
        row[j] = nextRow[j + 1] + 1;
      } else {
        row[j] = nextRow[j] >= row[j + 1] ? nextRow[j] : row[j + 1];
      }
    }
  }

  const matches: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (orig[i] === edit[j]) {
      matches.push([i, j]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }

  // Ignore full-sentence rewrites with no shared context anchor (unless a short 1-3 word turn)
  if (matches.length === 0 && (m > MAX_SPAN_WORDS || n > MAX_SPAN_WORDS)) {
    return [];
  }

  matches.push([m, n]);
  const suggestions: GlossarySuggestion[] = [];
  const seen = new Set<string>();
  let prevI = 0;
  let prevJ = 0;

  for (const [matchI, matchJ] of matches) {
    const origSpan = orig.slice(prevI, matchI);
    const editSpan = edit.slice(prevJ, matchJ);
    prevI = matchI + 1;
    prevJ = matchJ + 1;

    if (
      origSpan.length === 0 ||
      editSpan.length === 0 ||
      origSpan.length > MAX_SPAN_WORDS ||
      editSpan.length > MAX_SPAN_WORDS
    ) {
      continue;
    }

    const from = origSpan.join(' ');
    const to = editSpan.join(' ');
    if (
      from === to ||
      from.length < 2 ||
      to.length < 2 ||
      from.length > MAX_TERM_LEN ||
      to.length > MAX_TERM_LEN ||
      !HAS_ALNUM_RE.test(from) ||
      !HAS_ALNUM_RE.test(to)
    ) {
      continue;
    }

    const dedupKey = `${from}\u0000${to}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);
    suggestions.push({ from, to });
    if (suggestions.length >= MAX_SUGGESTIONS) break;
  }

  return suggestions;
}
