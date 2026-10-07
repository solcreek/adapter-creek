import { describe, expect, it } from "vitest";
import { escapeNonLatin1 } from "./escape-source";

const NON_LATIN1 = /[^\x00-\xff]/u;

/** Evaluate a script body that ends in `return …` and JSON-serialize the result. */
function run(body: string): string {
  return JSON.stringify(new Function(body)());
}

/** Escape `body`, assert no non-Latin-1 character survives, and assert it evaluates the same. */
function expectSameResult(body: string): string {
  const result = escapeNonLatin1(body);
  expect(result.reason).toBeUndefined();
  expect(result.kept).toBe(0);
  expect(result.code).not.toMatch(NON_LATIN1);
  expect(run(result.code)).toBe(run(body));
  return result.code;
}

// Each sample is entirely above U+00FF (Hungarian's ő/ű are Latin Extended-A,
// just past the Latin-1 boundary). `am`/`pm` feed a regex alternation.
const LOCALES = [
  { locale: "zh-Hant", text: "繁體中文測試", am: "上午", pm: "下午" },
  { locale: "zh-Hans", text: "简体中文测试", am: "上午", pm: "下午" },
  { locale: "ja", text: "ひらがなカタカナ漢字", am: "午前", pm: "午後" },
  { locale: "ko", text: "한국어시험", am: "오전", pm: "오후" },
  { locale: "ru", text: "русскийтекст", am: "утро", pm: "вечер" },
  { locale: "ar", text: "مرحبابالعالم", am: "صباحا", pm: "مساء" },
  { locale: "th", text: "ภาษาไทย", am: "เช้า", pm: "บ่าย" },
  { locale: "hi", text: "हिन्दी", am: "पूर्वाह्न", pm: "अपराह्न" },
  { locale: "hu", text: "őűŐŰ", am: "dé", pm: "du" },
];

describe.each(LOCALES)("escapeNonLatin1 ($locale)", ({ text, am, pm }) => {
  const lit = JSON.stringify;

  it("escapes regex literals and keeps what they match", () => {
    expectSameResult(`
      const r = /^(${am}|${pm})$/;
      const all = /^[${text}]+$/u;
      return [r.test(${lit(am)}), r.test(${lit(pm)}), r.test(${lit(text)}), all.test(${lit(text)}), all.test("x"),
        r.source, String(r), all.source, all.flags];
    `);
  });

  it("escapes string literals and comments", () => {
    expectSameResult(`// ${text}\n/* ${am} */\nreturn [${lit(text)}, '${pm}'];`);
  });

  it("escapes identifiers where the script allows them", () => {
    // Combining marks (Thai, Devanagari) are ID_Continue but not ID_Start,
    // so prefix a letter.
    expectSameResult(`const _${text} = 1; return _${text};`);
  });
});

describe("escapeNonLatin1", () => {
  it("escapes emoji ZWJ sequences and variation selectors", () => {
    const out = expectSameResult(`
      const family = "👨‍👩‍👧";
      return [family, /^👨‍👩‍👧$/u.test(family), /^❤️$/.test("❤️"), [...family].length];
    `);
    expect(out).toContain("\\u200D");
  });

  it("returns Latin-1 source untouched", () => {
    const code = 'const s = "café ñ ÿ"; const r = /é/;';
    expect(escapeNonLatin1(code)).toEqual({ code, escaped: 0, kept: 0 });
  });

  it("escapes regex literals and keeps what they match", () => {
    const out = expectSameResult(`
      const r = /午前|下午/g;
      return [["午前", "下午", "上午"].map((s) => r.test(s)), r.source, String(r), r.flags, r.lastIndex];
    `);
    expect(out).toContain('/(?:)/.constructor("\\u5348\\u524D|\\u4E0B\\u5348","g")');
  });

  it("keeps .source and toString() of a rewritten regex", () => {
    // Escaping inside the literal would turn /中/.source into "\\u4E2D".
    expectSameResult(`
      return [/中/.source, String(/中\\/文/gi), /[中/]/.source, /\\中/.source, /😀/u.source];
    `);
  });

  it("rewrites a regex in every expression position minified code puts one", () => {
    expectSameResult(`
      const RegExp = null; // a local binding must not shadow the constructor
      function f(s) { return/^中/.test(s) }
      const xs = [/中/g, typeof/中/, !/中/.test("文"), "中文".replace(/中/g, "x"), /中/ instanceof Object];
      return [f("中文"), f("文"), xs.map(String), xs[0].lastIndex];
    `);
  });

  it("gives each evaluation of a regex its own object, as a literal does", () => {
    expectSameResult(`
      const make = () => /中/g;
      const a = make(), b = make();
      a.test("中");
      return [a === b, a.lastIndex, b.lastIndex];
    `);
  });

  it("escapes ranges and classes", () => {
    expectSameResult(`
      const cjk = /^[一-龥]+$/;
      return [cjk.test("中文"), cjk.test("abc"), /[，。]/g[Symbol.replace]("a，b。", "-")];
    `);
  });

  it("escapes astral characters per regex mode", () => {
    const out = expectSameResult(`
      return [
        /^😀$/.test("😀"),
        /^😀$/u.test("😀"),
        /^[😀]$/u.test("😀"),
        /^[😀]$/.test("😀"),
        /^.$/u.test("😀"),
      ].concat([/^😀$/, /^😀$/u, /[😀]/u].map(String));
    `);
    expect(out).toContain('"^\\u{1F600}$","u"');
  });

  it("keeps backslash runs before the character in a regex", () => {
    expectSameResult(
      'return [/\\中/.test("中"), /\\\\中/.test("\\\\中"), /\\\\\\中/.test("\\\\中"), /\\中/.source, /\\\\中/.source];',
    );
  });

  it("escapes named capture groups", () => {
    expectSameResult(`
      const m = /(?<年>\\d+)年\\k<年>/.exec("2026年2026");
      return m.groups;
    `);
  });

  it("escapes string literals, including non-escape characters and line continuations", () => {
    const out = expectSameResult(
      'return ["中文", "\\中", "\\\\中", "😀", \'單引號\', "a\\\u2028b", "x\u2028y"];',
    );
    expect(out).toContain('"\\u4E2D\\u6587"');
    expect(out).toContain('"\\u{1F600}"');
  });

  it("escapes identifiers and private names", () => {
    expectSameResult(`
      const 變數 = 1, 𠮷 = 2;
      class C { #私有 = 3; get() { return this.#私有; } }
      return [變數, 𠮷, new C().get()];
    `);
  });

  it("keeps a line separator inside a block comment a line break", () => {
    // `return /*<LS>*/ 1` returns undefined: the comment ends the statement.
    expectSameResult("function f() { return /* 註\u2028解 */ 1 }\nreturn f();");
  });

  it("escapes comments and replaces non-Latin-1 whitespace", () => {
    expectSameResult("const a = 1\u2028const b = 2\u3000;\n// 註解\n/* 區塊註解 */\nreturn [a, b];");
  });

  it("leaves template text alone and counts it as kept", () => {
    const code = 'const r = /中/; const t = String.raw`標\\籤`; const u = `中文${r.source}`;';
    const result = escapeNonLatin1(code);
    expect(result.reason).toBeUndefined();
    expect(result.escaped).toBe(1);
    expect(result.kept).toBe(4);
    expect(result.code).toContain('/(?:)/.constructor("\\u4E2D","")');
    expect(result.code).toContain("String.raw`標\\籤`");
    expect(result.code).toContain("`中文${");
  });

  it("returns the input unchanged when it does not tokenize", () => {
    const code = 'const s = "中文"; const t = "unterminated';
    const result = escapeNonLatin1(code);
    expect(result.code).toBe(code);
    expect(result.escaped).toBe(0);
    expect(result.kept).toBe(2);
    expect(result.reason).toMatch(/tokenize failed/);
  });

  it("handles ES module syntax", () => {
    const code = 'import x from "./a.js";\nexport const r = /午前/;\nexport { x as 名 };';
    const result = escapeNonLatin1(code);
    expect(result.reason).toBeUndefined();
    expect(result.code).not.toMatch(NON_LATIN1);
  });
});
