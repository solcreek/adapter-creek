import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { parse, type Options } from "acorn";
import { afterAll, describe, expect, it } from "vitest";
import { escapeNonLatin1 } from "./escape-source";

const NON_LATIN1 = /[^\x00-\xff]/u;
const CTOR = "__creekRegExp";

/**
 * Evaluate a script body that ends in `return …` and JSON-serialize the
 * result, or the name of the error it throws: a rewrite must throw where the
 * original throws, with the same kind of error.
 */
function run(body: string): string {
  try {
    return JSON.stringify(new Function(body)()) ?? "undefined";
  } catch (err) {
    return `throws ${(err as Error).constructor.name}`;
  }
}

const SCRIPT: Options = { ecmaVersion: "latest", sourceType: "script", allowReturnOutsideFunction: true };
const MODULE: Options = { ecmaVersion: "latest", sourceType: "module", allowHashBang: true };

// Position and raw spelling are what the rewrite changes on purpose; the raw
// text of a template element is not, so `raw` is only ignored on literals.
const POSITION_KEYS = new Set(["start", "end", "loc", "range"]);

/**
 * Compare two ASTs. Every node must match, except that a regex literal may
 * have become `new <CTOR>("<pattern>", "<flags>")` with the same pattern and
 * flags. Returns the path of the first difference, or null.
 */
function astDiff(a: any, b: any, ctor: string, at = "Program"): string | null {
  if (a && typeof a === "object" && a.type === "Literal" && a.regex) {
    // Untouched (nothing above U+00FF in it), or rewritten as the call.
    const untouched = b?.regex?.pattern === a.regex.pattern && b.regex.flags === a.regex.flags;
    const ok =
      untouched ||
      (b?.type === "NewExpression" &&
      b.callee?.type === "Identifier" &&
      b.callee.name === ctor &&
      b.arguments.length === 2 &&
      b.arguments[0].value === a.regex.pattern &&
      b.arguments[1].value === a.regex.flags);
    return ok ? null : `${at} (regex /${a.regex.pattern}/${a.regex.flags})`;
  }
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return `${at} (length)`;
    for (let i = 0; i < a.length; i++) {
      const d = astDiff(a[i], b[i], ctor, `${at}[${i}]`);
      if (d) return d;
    }
    return null;
  }
  if (a && typeof a === "object") {
    if (!b || typeof b !== "object" || a.type !== b.type) return `${at} (${a.type} → ${b?.type})`;
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
      if (POSITION_KEYS.has(k) || (k === "raw" && a.type === "Literal")) continue;
      const d = astDiff(a[k], b[k], ctor, `${at}.${k}`);
      if (d) return d;
    }
    return null;
  }
  return Object.is(a, b) ? null : `${at} (${String(a)} → ${String(b)})`;
}

/**
 * Parse both sources and require the same program, apart from rewritten
 * regexes and, when there are any, a first statement that captures the
 * constructor from a regex literal.
 */
function expectSameAst(before: string, after: string, options: Options, ctor = CTOR): void {
  const a = parse(before, options) as any;
  const b = parse(after, options) as any;
  const hasRegex = /\bnew __creekRegExp\d*\(/.test(after);
  if (hasRegex) {
    const [first, ...rest] = b.body;
    expect(first.type).toBe("VariableDeclaration");
    expect(first.kind).toBe("const");
    expect(first.declarations[0].id.name).toBe(ctor);
    const init = first.declarations[0].init;
    expect(init.type).toBe("MemberExpression");
    expect(init.object.regex).toEqual({ pattern: "(?:)", flags: "" });
    expect(init.property.name).toBe("constructor");
    b.body = rest;
  }
  expect(astDiff(a, b, ctor)).toBeNull();
}

/**
 * Escape `body`; assert nothing above U+00FF survives, the program is the
 * same (AST), and it evaluates to the same result or the same kind of error.
 */
function expectSameResult(body: string): string {
  const result = escapeNonLatin1(body);
  expect(result.reason).toBeUndefined();
  expect(result.kept).toBe(0);
  expect(result.code).not.toMatch(NON_LATIN1);
  expectSameAst(body, result.code, SCRIPT);
  expect(run(result.code)).toBe(run(body));
  return result.code;
}

const moduleDir = mkdtempSync(path.join(realpathSync(tmpdir()), "adapter-creek-escape-"));
afterAll(() => rmSync(moduleDir, { recursive: true, force: true }));
let moduleCount = 0;

/**
 * Import `code` as an ES module in a separate Node process — real Node ESM,
 * not the test runner's transform — and return its namespace as JSON.
 */
function importModule(code: string): string {
  const file = path.join(moduleDir, `m${moduleCount++}.mjs`);
  writeFileSync(file, code);
  const script = `const m = await import(${JSON.stringify(pathToFileURL(file).href)}); process.stdout.write(JSON.stringify({ ...m }));`;
  return execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf-8" });
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
    expect(out).toContain('(new __creekRegExp("\\u5348\\u524D|\\u4E0B\\u5348","g"))');
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
    expect(result.code).toContain('(new __creekRegExp("\\u4E2D",""))');
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

// Every syntactic position a regex literal can take, minified (no spaces) and
// not. `R` is the regex, `A`/`P` strings it should and should not match. Each
// body must evaluate to something comparable, or throw.
const REGEX_POSITIONS: Array<[string, (R: string, A: string, P: string) => string]> = [
  ["return value", (R, A) => `return ${R}.test(${A})`],
  ["after return, no space", (R, A) => `return${R}.test(${A})`],
  ["after return and a newline (ASI)", (R) => `return\n${R}`],
  ["after if (…)", (R, A) => `const o=[];if(1)${R}.test(${A})&&o.push(1);return o`],
  ["after else, no space", (R, A) => `const o=[];if(0);else${R}.test(${A})&&o.push(1);return o`],
  ["after a block", (R, A) => `const o=[];{o.push(0)}\n${R}.test(${A})&&o.push(1);return o`],
  ["after a block on one line", (R, A) => `const o=[];if(1){}${R}.test(${A})&&o.push(1);return o`],
  ["after an arrow function body and a newline", (R, A) => `const o=[];const f=()=>{}\n${R}.test(${A})&&o.push(1);return o`],
  ["after a label", (R, A) => `const o=[];l:${R}.test(${A})&&o.push(1);return o`],
  ["in do … while", (R, A) => `const o=[];do ${R}.test(${A})&&o.push(1);while(0);return o`],
  ["after case", (R) => `switch(1){case 1:return ${R}.source}`],
  ["yield and a newline (ASI)", (R) => `function*g(){yield\n${R}}return[...g()].map(String)`],
  ["yield operand", (R) => `function*g(){yield${R}}return[...g()].map(String)`],
  ["arrow body", (R, A) => `return(()=>${R})().test(${A})`],
  ["template substitution", (R) => "return`<${" + R + ".source}>`"],
  ["ternary branches", (R) => `return[String(1?${R}:0),String(0?0:${R})]`],
  ["array and object values", (R) => `return[${R},{k:${R}}.k,[...[${R}]][0]].map(String)`],
  ["computed key and class field", (R) => `class C{static r=${R};[${R}.source]=1}return[String(C.r),Object.keys(new C)]`],
  ["default parameter", (R) => `function f(r=${R}){return r.source}return f()`],
  ["unary operators", (R) => `return[typeof${R},void${R},!${R},-${R},~${R},+${R}]`],
  ["instanceof and in", (R) => `return[${R} instanceof Object,"source"in${R}]`],
  ["logical and nullish", (R) => `return[String(0||${R}),String(null??${R}),String(1&&${R})]`],
  ["comma and assignment", (R) => `let r;r=(0,${R});return String(r)`],
  ["optional chaining", (R, A) => `return[${R}?.flags,${R}.exec(${A})?.[0]??null]`],
  ["method chain", (R, A, P) => `return ${R}[Symbol.replace](${A}+${P},"-")`],
  ["lastIndex per evaluation", (R, A) => `const f=()=>${R};const a=f(),b=f();a.test(${A});return[a===b,a.lastIndex,b.lastIndex]`],
  ["new on the regex (throws)", (R) => `return new ${R}`],
  ["called as a function (throws)", (R) => `return ${R}()`],
  ["as a template tag (throws)", (R) => "return " + R + "`x`"],
  ["spread of a regex (throws)", (R) => `return[...${R}]`],
];

describe.each(LOCALES)("regex positions ($locale)", ({ locale, text, am, pm }) => {
  const A = JSON.stringify(am);
  const P = JSON.stringify(pm);
  const regexes = [`/^(${am}|${pm})$/g`, `/[${text}]+/u`];

  for (const [position, body] of REGEX_POSITIONS) {
    it.each(regexes)(`${position}: %s`, (R) => {
      expectSameResult(body(R, A, P));
    });
  }

  it("keeps division a division when the operands are non-Latin-1 names", () => {
    // Each `/…/g` here is two divisions; a tokenizer that read it as a regex
    // would turn it into a constructor call.
    const out = expectSameResult(`
      const g = 1, _${locale.replace("-", "")}A = 8, _${locale.replace("-", "")}B = 2;
      const 甲 = 8, 乙 = 2, f = () => 8, o = {};
      let i = 8;
      return [
        甲
        /乙/g,
        f()/乙/g,
        (甲)/乙/g,
        [甲][0]/乙/g,
        i++/乙/g,
        o.x/乙/g,
        ${A}.length/乙/g,
      ];
    `);
    expect(out).not.toContain(CTOR);
  });
});

describe("escapeNonLatin1: the captured constructor", () => {
  it("captures the constructor before the code patches RegExp.prototype.constructor", () => {
    expectSameResult(`
      const proto = Object.getPrototypeOf(/x/);
      const saved = Object.getOwnPropertyDescriptor(proto, "constructor");
      try {
        Object.defineProperty(proto, "constructor", { value: () => "patched", writable: true, configurable: true });
        return [String(/中文/g), /中文/.test("中文"), /中文/ instanceof saved.value];
      } finally {
        Object.defineProperty(proto, "constructor", saved);
      }
    `);
  });

  it("captures the constructor before the code installs a constructor getter", () => {
    expectSameResult(`
      const proto = Object.getPrototypeOf(/x/);
      const saved = Object.getOwnPropertyDescriptor(proto, "constructor");
      try {
        Object.defineProperty(proto, "constructor", { get() { throw new Error("read") }, configurable: true });
        return [String(/简体/u), /简体/u.flags];
      } finally {
        Object.defineProperty(proto, "constructor", saved);
      }
    `);
  });

  it("is unaffected by a reassigned global RegExp", () => {
    expectSameResult(`
      const saved = globalThis.RegExp;
      try {
        globalThis.RegExp = function () { return "patched"; };
        return [String(/한국어/), /한국어/.test("한국어"), /한국어/ instanceof saved];
      } finally {
        globalThis.RegExp = saved;
      }
    `);
  });

  it("is unaffected by local bindings named RegExp or constructor", () => {
    expectSameResult(`
      const RegExp = null, constructor = null;
      function g(RegExp) { return /ひらがな/.source + typeof RegExp; }
      return [g(1), String(/カタカナ/i)];
    `);
  });

  it("adds the capture statement only when a regex is rewritten", () => {
    expect(escapeNonLatin1('const s = "中文";').code).not.toContain(CTOR);
    expect(escapeNonLatin1("const r = /中文/;").code.startsWith(`const ${CTOR}=/(?:)/.constructor;`)).toBe(true);
  });

  it("picks another name when the file already contains it", () => {
    const body = `const ${CTOR} = 5; return ["${CTOR}2?", ${CTOR}, /繁體/.source];`;
    const result = escapeNonLatin1(body);
    expect(result.code).toContain(`(new ${CTOR}3(`);
    expect(run(result.code)).toBe(run(body));
    expectSameAst(body, result.code, SCRIPT, `${CTOR}3`);
  });

  it("gives up when the name is spelled with escapes", () => {
    const code = `const \\u005F_creekRegExp = 5; const r = /繁體/;`;
    const result = escapeNonLatin1(code);
    expect(result.code).toBe(code);
    expect(result.reason).toMatch(/already uses the identifier __creekRegExp/);
  });
});

describe("escapeNonLatin1: ES modules", () => {
  it("evaluates the same as a module with imports and exports", () => {
    const code = [
      'import { Buffer } from "node:buffer";',
      "export const zhHant = /^(上午|下午)$/.test(\"下午\");",
      "export const zhHans = String(/简体中文/gu);",
      "export const ja = /午前|午後/.source;",
      "export function ko(s) { return /^오전$/.test(s); }",
      "export const koResult = ko(\"오전\");",
      'export const bytes = Buffer.from("繁體").length;',
      'import * as path from "node:path";',
      "export const sep = path.sep;",
    ].join("\n");
    const result = escapeNonLatin1(code);
    expect(result.reason).toBeUndefined();
    expect(result.code).not.toMatch(NON_LATIN1);
    expectSameAst(code, result.code, MODULE);
    expect(importModule(result.code)).toBe(importModule(code));
  });

  it("puts the capture statement after a hashbang line", () => {
    for (const eol of ["\n", "\r\n"]) {
      const code = `#!/usr/bin/env node${eol}export const r = String(/繁體|简体/g);`;
      const result = escapeNonLatin1(code);
      expect(result.code.startsWith(`#!/usr/bin/env node${eol}const ${CTOR}=`)).toBe(true);
      expectSameAst(code, result.code, MODULE);
      expect(importModule(result.code)).toBe(importModule(code));
    }
  });

  it("runs the capture before hoisted functions are called", () => {
    const code = "export const early = f();\nfunction f() { return String(/日本語/y); }";
    const result = escapeNonLatin1(code);
    expect(importModule(result.code)).toBe(importModule(code));
  });
});
