/**
 * Keep worker.js one byte per character in V8.
 *
 * V8 keeps a script's source on the heap as a single string, and a string
 * with even one character above U+00FF is stored two bytes per character.
 * A 33 MB worker.js with a handful of CJK characters therefore costs 66 MB
 * of the isolate's 128 MB, before it serves a request.
 *
 * esbuild's minify (charset ascii) escapes string literals, untagged template
 * text and identifiers, but not regular-expression literals (`/午前|下午/`) or
 * tagged-template text, whose raw form the tag can read. This pass rewrites
 * every remaining character above U+00FF as an escape with the same meaning:
 *
 * - string literals: `\uXXXX` / `\u{X}`. An odd run of backslashes before the
 *   character makes it a non-escape character (`"\中"` is `"中"`), so one
 *   backslash is dropped; `\` + U+2028/U+2029 is a line continuation and is
 *   removed whole.
 * - regex literals: `\uXXXX`; astral characters as `\u{X}` under the u/v
 *   flags and as a surrogate pair of escapes otherwise (a non-unicode regex
 *   sees them as two code units either way). Odd backslash runs as above.
 * - identifiers and private names: `\uXXXX` / `\u{X}`.
 * - comments: escaped as text; whitespace between tokens becomes a space, or
 *   a newline for U+2028/U+2029 (both are line terminators, so ASI holds).
 * - template text is left alone and counted as `kept`: whether a template is
 *   tagged is not visible at the token level, and escaping a tagged one
 *   changes `strings.raw`.
 *
 * Every edit stays inside one token, comment or whitespace run, so token
 * boundaries — and with them the tokenizer's regex-vs-division context for
 * the rest of the file — are unchanged. Each rewritten token is tokenized
 * again on its own and must come back as one token of the same type and
 * value (regex: same flags, pattern re-validated by acorn). Any difference,
 * or a tokenizer error, returns the input unchanged. One full tokenizer pass
 * over the file, not three: worker.js is tens of megabytes.
 */

import { tokenizer, type Options, type Token as AcornToken } from "acorn";

/** acorn's typings omit the decoded value its tokens carry. */
type Token = AcornToken & { value?: unknown };

const ACORN_OPTIONS: Options = {
  ecmaVersion: "latest",
  sourceType: "module",
  allowHashBang: true,
};

const NON_LATIN1 = /[^\x00-\xff]/gu;

export interface EscapeResult {
  code: string;
  /** Characters rewritten as escapes. */
  escaped: number;
  /** Characters above U+00FF left in the output (template text, or all of them on failure). */
  kept: number;
  /** Set when the rewrite was abandoned and `code` is the input. */
  reason?: string;
}

interface Hit {
  pos: number;
  len: number;
  cp: number;
}

interface Edit {
  start: number;
  end: number;
  text: string;
}

function hex4(unit: number): string {
  return "\\u" + unit.toString(16).toUpperCase().padStart(4, "0");
}

/** `\uXXXX` for the BMP, `\u{X}` above it. */
function escapeCodePoint(cp: number): string {
  return cp > 0xffff ? `\\u{${cp.toString(16).toUpperCase()}}` : hex4(cp);
}

/** `\uXXXX` for the BMP, a surrogate pair of escapes above it. */
function escapeCodeUnits(cp: number): string {
  if (cp <= 0xffff) return hex4(cp);
  const offset = cp - 0x10000;
  return hex4(0xd800 + (offset >> 10)) + hex4(0xdc00 + (offset & 0x3ff));
}

function oddBackslashesBefore(code: string, pos: number, floor: number): boolean {
  let n = 0;
  for (let i = pos - 1; i >= floor && code.charCodeAt(i) === 0x5c; i--) n++;
  return n % 2 === 1;
}

const isLineSeparator = (cp: number): boolean => cp === 0x2028 || cp === 0x2029;

export function escapeNonLatin1(code: string): EscapeResult {
  const hits: Hit[] = [];
  for (const m of code.matchAll(NON_LATIN1)) {
    hits.push({ pos: m.index, len: m[0].length, cp: m[0].codePointAt(0)! });
  }
  if (hits.length === 0) return { code, escaped: 0, kept: 0 };

  const unchanged = (reason: string): EscapeResult => ({ code, escaped: 0, kept: hits.length, reason });

  const comments: Array<[number, number]> = [];
  let c = 0;
  const edits: Edit[] = [];
  const touched: Token[] = [];
  let kept = 0;

  const between = (hit: Hit): void => {
    while (c < comments.length && comments[c][1] <= hit.pos) c++;
    const inComment = c < comments.length && comments[c][0] <= hit.pos;
    const text = inComment ? escapeCodePoint(hit.cp) : isLineSeparator(hit.cp) ? "\n" : " ";
    edits.push({ start: hit.pos, end: hit.pos + hit.len, text });
  };

  const inToken = (tok: Token, hit: Hit): void => {
    if (touched[touched.length - 1] !== tok) touched.push(tok);
    const end = hit.pos + hit.len;
    const odd = () => oddBackslashesBefore(code, hit.pos, tok.start);
    switch (tok.type.label) {
      case "string":
        if (odd()) {
          edits.push({ start: hit.pos - 1, end, text: isLineSeparator(hit.cp) ? "" : escapeCodePoint(hit.cp) });
        } else {
          edits.push({ start: hit.pos, end, text: escapeCodePoint(hit.cp) });
        }
        return;
      case "regexp": {
        const { flags } = tok.value as { flags: string };
        const unicode = flags.includes("u") || flags.includes("v");
        const text = unicode ? escapeCodePoint(hit.cp) : escapeCodeUnits(hit.cp);
        edits.push(odd() ? { start: hit.pos - 1, end, text } : { start: hit.pos, end, text });
        return;
      }
      case "name":
      case "privateId":
        edits.push({ start: hit.pos, end, text: escapeCodePoint(hit.cp) });
        return;
      default:
        kept++;
    }
  };

  let h = 0;
  try {
    const tokens = tokenizer(code, {
      ...ACORN_OPTIONS,
      onComment: (_block, _text, start, end) => {
        comments.push([start, end]);
      },
    });
    for (;;) {
      const tok: Token = tokens.getToken();
      while (h < hits.length && hits[h].pos < tok.start) between(hits[h++]);
      if (tok.type.label === "eof") break;
      while (h < hits.length && hits[h].pos < tok.end) inToken(tok, hits[h++]);
    }
    while (h < hits.length) between(hits[h++]);
  } catch (err) {
    return unchanged(`tokenize failed: ${(err as Error).message}`);
  }

  if (edits.length === 0) return { code, escaped: 0, kept };

  const out = applyEdits(code, edits, 0, code.length);

  // Each touched token's edits are a contiguous run of `edits`, in order.
  let e = 0;
  for (const tok of touched) {
    while (e < edits.length && edits[e].end <= tok.start) e++;
    const from = e;
    while (e < edits.length && edits[e].start < tok.end) e++;
    if (from === e) continue; // template text: kept, not edited
    const mismatch = retokenizesAs(tok, applyEdits(code, edits.slice(from, e), tok.start, tok.end));
    if (mismatch) return unchanged(mismatch);
  }

  return { code: out, escaped: hits.length - kept, kept };
}

/** Apply sorted, non-overlapping `edits` to `code.slice(start, end)`. */
function applyEdits(code: string, edits: Edit[], start: number, end: number): string {
  const parts: string[] = [];
  let last = start;
  for (const e of edits) {
    parts.push(code.slice(last, e.start), e.text);
    last = e.end;
  }
  parts.push(code.slice(last, end));
  return parts.join("");
}

/**
 * Tokenize `text` alone: it must be exactly one token with `tok`'s type and
 * decoded value (for a regex, its flags; acorn validates the pattern while
 * reading it). Returns a description of the difference, or null.
 */
function retokenizesAs(tok: Token, text: string): string | null {
  let first: Token, next: Token;
  try {
    const t = tokenizer(text, ACORN_OPTIONS);
    first = t.getToken();
    next = t.getToken();
  } catch (err) {
    return `rewritten ${tok.type.label} at offset ${tok.start} does not tokenize: ${(err as Error).message}`;
  }
  if (first.type !== tok.type || first.end !== text.length || next.type.label !== "eof") {
    return `rewritten ${tok.type.label} at offset ${tok.start} is no longer one ${tok.type.label} token`;
  }
  const same =
    tok.type.label === "regexp"
      ? (first.value as { flags: string }).flags === (tok.value as { flags: string }).flags
      : first.value === tok.value;
  return same ? null : `rewritten ${tok.type.label} at offset ${tok.start} changed value`;
}
