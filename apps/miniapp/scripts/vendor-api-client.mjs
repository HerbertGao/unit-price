// Pre-bundle @unit-price/api-client (which pulls in Zod + @unit-price/core) into
// a single weapp-safe ESM file under vendor/, consumed via a webpack alias.
//
// WHY: Zod 4 ships optional chaining `?.` / nullish coalescing `??`, which the
// WeChat runtime's parser rejects ("Unexpected token ."). Routing Zod through
// babel-preset-taro (via mini.compile.include) DID strip the syntax but BROKE
// Zod's class runtime (`w is not a function`) — babel's loose class transform /
// helper injection mangles Zod. esbuild at target es2017 lowers ONLY the
// unsupported operators while PRESERVING classes, so Zod's runtime stays intact.
// The output lives outside src/ and outside the babel allowlist, so Taro's
// babel-loader never touches it again. webpack still bundles + minifies it.
//
// Build order: depends on packages/api-client/dist (tsc) being built first, so
// run this AFTER `pnpm -r build` and BEFORE `taro build` (see build:weapp).
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync } from 'node:fs';

/**
 * Operators that can be followed by an expression, so a later `/` starts a regex.
 * `null` keeps the previous expression-allowed flag (`++` / `--` are prefix or postfix).
 * @type {Array<[string, boolean | null]>}
 */
const SLASH_AFTER_OPERATORS = [
  ['>>>=', true],
  ['...', true],
  ['<<=', true],
  ['>>=', true],
  ['===', true],
  ['!==', true],
  ['**=', true],
  ['&&=', true],
  ['||=', true],
  ['??=', true],
  ['>>>', true],
  ['<<', true],
  ['>>', true],
  ['==', true],
  ['!=', true],
  ['<=', true],
  ['>=', true],
  ['=>', true],
  ['&&', true],
  ['||', true],
  ['??', true],
  ['**', true],
  ['+=', true],
  ['-=', true],
  ['*=', true],
  ['%=', true],
  ['&=', true],
  ['|=', true],
  ['^=', true],
  ['++', null],
  ['--', null],
  ['+', true],
  ['-', true],
  ['*', true],
  ['%', true],
  ['<', true],
  ['>', true],
  ['&', true],
  ['|', true],
  ['^', true],
  ['!', true],
  ['~', true],
  ['?', true],
  ['=', true],
  [',', true],
  [';', true],
  [':', true],
];

const BEFORE_EXPR_KEYWORDS = new Set([
  'await',
  'case',
  'default',
  'delete',
  'do',
  'else',
  'extends',
  'in',
  'instanceof',
  'new',
  'return',
  'throw',
  'typeof',
  'void',
]);

/** Keywords that do not produce a value. `{` after them is a block, not an object. */
const STATEMENT_KEYWORDS = new Set([
  'break',
  'catch',
  'continue',
  'debugger',
  'export',
  'finally',
  'import',
  'static',
  'super',
  'switch',
  'this',
  'try',
]);

/**
 * @param {string} source
 * @param {number} i
 * @param {boolean} start
 */
function identSize(source, i, start) {
  if (i >= source.length) return 0;
  const c = source[i];
  if (start ? /[A-Za-z_$]/.test(c) : /[A-Za-z0-9_$]/.test(c)) return 1;
  const cp = source.codePointAt(i);
  if (cp === undefined || cp < 128) return 0;
  const ch = String.fromCodePoint(cp);
  if (start ? /\p{ID_Start}/u.test(ch) : /\p{ID_Continue}/u.test(ch)) return ch.length;
  return 0;
}

/**
 * @param {string} source
 * @param {number} i
 */
function readIdent(source, i) {
  let size = identSize(source, i, true);
  if (size === 0) return i;
  i += size;
  while (i < source.length) {
    size = identSize(source, i, false);
    if (size === 0) break;
    i += size;
  }
  return i;
}

/**
 * @param {string} c
 */
function isNewline(c) {
  return c === '\n' || c === '\r' || c === '\u2028' || c === '\u2029';
}

/**
 * Index after a regex literal starting at `start` (`/`), or -1 when the slash
 * cannot close a regex. Character classes are skipped, so quotes and `?.`
 * inside them stay part of the literal. Mirrors the non-nesting class rule the
 * JS lexer uses, including for the `v` flag.
 * @param {string} source
 * @param {number} start
 */
function readRegexEnd(source, start) {
  const n = source.length;
  let i = start + 1;
  let inClass = false;
  while (i < n) {
    const c = source[i];
    if (isNewline(c)) return -1;
    if (c === '\\') {
      if (i + 1 >= n || isNewline(source[i + 1])) return -1;
      i += 2;
      continue;
    }
    if (c === '[') inClass = true;
    else if (c === ']' && inClass) inClass = false;
    else if (c === '/' && !inClass) {
      i += 1;
      let size = identSize(source, i, false);
      while (size > 0) {
        i += size;
        size = identSize(source, i, false);
      }
      return i;
    }
    i += 1;
  }
  return -1;
}

/**
 * @param {string} source
 * @param {number} i
 * @param {string} quote
 */
function readQuoted(source, i, quote) {
  const n = source.length;
  i += 1;
  while (i < n) {
    if (source[i] === '\\') {
      i += i + 1 < n ? 2 : 1;
      continue;
    }
    if (source[i] === quote) return i + 1;
    i += 1;
  }
  return i;
}

/**
 * @param {string} source
 * @param {number} i
 */
function readNumber(source, i) {
  const n = source.length;
  const next = source[i + 1];
  if (source[i] === '0' && next && /[xXoObB]/.test(next)) {
    i += 2;
    while (i < n && /[0-9a-fA-F_]/.test(source[i])) i += 1;
    return i;
  }
  if (source[i] !== '.') {
    while (i < n && /[0-9_]/.test(source[i])) i += 1;
  }
  if (source[i] === '.') {
    i += 1;
    while (i < n && /[0-9_]/.test(source[i])) i += 1;
  }
  if (source[i] === 'e' || source[i] === 'E') {
    let j = i + 1;
    if (source[j] === '+' || source[j] === '-') j += 1;
    if (j < n && /[0-9]/.test(source[j])) {
      j += 1;
      while (j < n && /[0-9_]/.test(source[j])) j += 1;
      i = j;
    }
  }
  if (source[i] === 'n' && identSize(source, i + 1, false) === 0) i += 1;
  return i;
}

/**
 * Count `?.` operators outside comments, string literals, template text, and
 * regex literals. A quote inside a regex character class is not a string
 * delimiter — Zod's email patterns contain them — and `?.` there is a
 * quantifier, not optional chaining. Operators inside `${...}` still count.
 * `/` starts a regex only where an expression is legal, so division such as
 * `a / b?.c` still counts.
 */
export function countOptionalChainOperators(source) {
  let count = 0;
  let i = 0;
  /** @type {Array<{ kind: string }>} */
  const ctx = [{ kind: 'stat' }];
  /**
   * @typedef {{
   *   type: 'code',
   *   brace: number,
   *   ctxMark: number,
   *   exprAllowed: boolean,
   *   prev: string,
   *   prevBeforeExpr: boolean,
   *   newline: boolean,
   *   asyncFnExpr: boolean,
   *   asyncIsDefault: boolean,
   * }} CodeFrame
   * @type {Array<CodeFrame | { type: 'tpl' }>}
   */
  const stack = [
    {
      type: 'code',
      brace: 0,
      ctxMark: 0,
      exprAllowed: true,
      prev: 'eof',
      prevBeforeExpr: false,
      newline: false,
      asyncFnExpr: false,
      asyncIsDefault: false,
    },
  ];

  /**
   * @param {CodeFrame} frame
   * @param {boolean | null} exprAllowed
   * @param {string} prev
   * @param {boolean} prevBeforeExpr
   */
  function endToken(frame, exprAllowed, prev, prevBeforeExpr) {
    if (exprAllowed !== null) frame.exprAllowed = exprAllowed;
    frame.prev = prev;
    frame.prevBeforeExpr = prevBeforeExpr;
    frame.newline = false;
  }

  /**
   * @param {CodeFrame} frame
   * @param {{ kind: string } | undefined} parent
   */
  function braceIsBlock(frame, parent) {
    const parentKind = parent?.kind;
    if (parentKind === 'fn' || parentKind === 'fnExpr') return true;
    if (frame.prev === 'colon' && (parentKind === 'stat' || parentKind === 'expr')) {
      return parentKind !== 'expr';
    }
    // `return` and `yield` are restricted productions: a newline starts a block.
    // `of` / other expression keywords are not — `{` after them is an object.
    if (frame.prev === 'return' || frame.prev === 'yield' || (frame.prev === 'name' && frame.exprAllowed)) {
      return frame.newline;
    }
    if (
      frame.prev === 'else' ||
      frame.prev === 'do' ||
      frame.prev === 'semi' ||
      frame.prev === 'eof' ||
      frame.prev === 'parenR' ||
      frame.prev === 'arrow'
    ) {
      return true;
    }
    if (frame.prev === 'braceL') return parentKind === 'stat';
    if (frame.prev === 'var' || frame.prev === 'const') return false;
    // `foo\n{` is a block after ASI. Same-line `foo {` is not a statement block.
    if (frame.prev === 'name') return frame.newline;
    return !frame.exprAllowed;
  }

  /**
   * @param {CodeFrame} frame
   */
  function isFnExpr(frame) {
    const parent = ctx[ctx.length - 1];
    if (!frame.prevBeforeExpr) return false;
    if (frame.prev === 'else') return false;
    if (frame.prev === 'semi' && parent?.kind !== 'parenStat') return false;
    if ((frame.prev === 'return' || frame.prev === 'yield') && frame.newline) return false;
    if ((frame.prev === 'colon' || frame.prev === 'braceL') && parent?.kind === 'stat') return false;
    return true;
  }

  /**
   * `export default function` / `export default class` are declarations, so a
   * regex on the next statement must still be recognized. `async` is only a
   * keyword when it actually prefixes that function.
   * @param {CodeFrame} frame
   */
  function functionKind(frame) {
    if (frame.prev === 'default') return 'fn';
    if (frame.prev === 'async' && !frame.newline) {
      if (frame.asyncIsDefault) return 'fn';
      return frame.asyncFnExpr ? 'fnExpr' : 'fn';
    }
    return isFnExpr(frame) ? 'fnExpr' : 'fn';
  }

  /**
   * @param {CodeFrame} frame
   * @param {'brace' | 'paren'} kind
   */
  function closeGroup(frame, kind) {
    const minLen = Math.max(frame.ctxMark + 1, 1);
    let exprAllowed = true;
    if (ctx.length > minLen) {
      let out = ctx.pop();
      if (
        out.kind === 'stat' &&
        ctx.length > minLen &&
        (ctx[ctx.length - 1].kind === 'fn' || ctx[ctx.length - 1].kind === 'fnExpr')
      ) {
        out = ctx.pop();
      }
      const isExpr = out.kind === 'expr' || out.kind === 'fnExpr' || out.kind === 'parenExpr';
      exprAllowed = !isExpr;
    }
    endToken(frame, exprAllowed, kind === 'paren' ? 'parenR' : 'braceR', false);
  }

  /**
   * @param {CodeFrame} frame
   * @param {string} word
   */
  function applyWord(frame, word) {
    if (frame.prev === 'dot') {
      endToken(frame, false, 'name', false);
      return;
    }
    if (word === 'of' && !frame.exprAllowed) {
      // `for (x of /re/)` and `for (x of {a:1})`, including across a newline.
      endToken(frame, true, 'beforeExpr', true);
      return;
    }
    if (word === 'yield') {
      // Restricted production, same newline rule as `return`.
      endToken(frame, true, 'yield', true);
      return;
    }
    if (word === 'async') {
      const asyncFnExpr = isFnExpr(frame);
      const asyncIsDefault = frame.prev === 'default';
      endToken(frame, false, 'async', false);
      frame.asyncFnExpr = asyncFnExpr;
      frame.asyncIsDefault = asyncIsDefault;
      return;
    }
    if (word === 'function' || word === 'class') {
      ctx.push({ kind: functionKind(frame) });
      endToken(frame, false, word, false);
      return;
    }
    if (BEFORE_EXPR_KEYWORDS.has(word)) {
      const prev =
        word === 'return' || word === 'else' || word === 'do' || word === 'default' ? word : 'beforeExpr';
      endToken(frame, true, prev, true);
      return;
    }
    if (word === 'var' || word === 'let' || word === 'const') {
      endToken(frame, false, word === 'var' ? 'var' : 'const', false);
      return;
    }
    if (word === 'if' || word === 'for' || word === 'while' || word === 'with') {
      endToken(frame, false, word, false);
      return;
    }
    endToken(frame, false, STATEMENT_KEYWORDS.has(word) ? 'kw' : 'name', false);
  }

  while (i < source.length) {
    const state = stack[stack.length - 1];
    if (state.type === 'tpl') {
      const c = source[i];
      const next = source[i + 1];
      if (c === '\\') {
        i += i + 1 < source.length ? 2 : 1;
        continue;
      }
      if (c === '`') {
        stack.pop();
        const code = stack[stack.length - 1];
        if (code.type === 'code') endToken(code, false, 'template', false);
        i += 1;
        continue;
      }
      if (c === '$' && next === '{') {
        const mark = ctx.length;
        ctx.push({ kind: 'interp' });
        stack.push({
          type: 'code',
          brace: 1,
          ctxMark: mark,
          exprAllowed: true,
          prev: 'interp',
          prevBeforeExpr: true,
          newline: false,
          asyncFnExpr: false,
          asyncIsDefault: false,
        });
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }

    const frame = state;
    while (i < source.length) {
      const c = source[i];
      if (c === ' ' || c === '\t' || c === '\f' || c === '\v' || c === '\u00a0' || c === '\ufeff') {
        i += 1;
        continue;
      }
      if (isNewline(c)) {
        frame.newline = true;
        i += 1;
        continue;
      }
      break;
    }
    if (i >= source.length) break;

    const c = source[i];
    const next = source[i + 1];

    if (c === '/' && next === '/') {
      i += 2;
      while (i < source.length && !isNewline(source[i])) i += 1;
      frame.newline = true;
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
        if (isNewline(source[i])) frame.newline = true;
        i += 1;
      }
      if (i < source.length) i += 2;
      continue;
    }
    if (c === '/') {
      if (frame.exprAllowed) {
        const end = readRegexEnd(source, i);
        if (end > i) {
          i = end;
          endToken(frame, false, 'regexp', false);
          continue;
        }
      }
      i += next === '=' ? 2 : 1;
      endToken(frame, true, 'other', true);
      continue;
    }
    if (c === "'" || c === '"') {
      i = readQuoted(source, i, c);
      endToken(frame, false, 'string', false);
      continue;
    }
    if (c === '`') {
      stack.push({ type: 'tpl' });
      i += 1;
      continue;
    }
    if ((c >= '0' && c <= '9') || (c === '.' && next >= '0' && next <= '9')) {
      i = readNumber(source, i);
      endToken(frame, false, 'num', false);
      continue;
    }
    if (c === '?' && next === '.') {
      count += 1;
      i += 2;
      endToken(frame, false, 'other', false);
      continue;
    }
    if (c === '#') {
      const end = readIdent(source, i + 1);
      i = end > i + 1 ? end : i + 1;
      endToken(frame, false, 'name', false);
      continue;
    }
    if (identSize(source, i, true) > 0) {
      const end = readIdent(source, i);
      applyWord(frame, source.slice(i, end));
      i = end;
      continue;
    }
    if (c === '{') {
      ctx.push({ kind: braceIsBlock(frame, ctx[ctx.length - 1]) ? 'stat' : 'expr' });
      frame.brace += 1;
      endToken(frame, true, 'braceL', true);
      i += 1;
      continue;
    }
    if (c === '}') {
      if (frame.brace > 0) frame.brace -= 1;
      if (frame.brace === 0 && stack.length > 1) {
        ctx.length = frame.ctxMark;
        stack.pop();
        i += 1;
        continue;
      }
      closeGroup(frame, 'brace');
      i += 1;
      continue;
    }
    if (c === '(') {
      const statement =
        frame.prev === 'if' || frame.prev === 'for' || frame.prev === 'while' || frame.prev === 'with';
      ctx.push({ kind: statement ? 'parenStat' : 'parenExpr' });
      endToken(frame, true, 'parenL', true);
      i += 1;
      continue;
    }
    if (c === ')') {
      closeGroup(frame, 'paren');
      i += 1;
      continue;
    }
    if (c === '[') {
      endToken(frame, true, 'other', true);
      i += 1;
      continue;
    }
    if (c === ']') {
      endToken(frame, false, 'other', false);
      i += 1;
      continue;
    }

    let matched = false;
    for (const [op, exprAllowed] of SLASH_AFTER_OPERATORS) {
      if (!source.startsWith(op, i)) continue;
      i += op.length;
      const prev = op === '=>' ? 'arrow' : op === ';' ? 'semi' : op === ':' ? 'colon' : 'other';
      endToken(frame, exprAllowed, prev, exprAllowed === true);
      matched = true;
      break;
    }
    if (matched) continue;
    if (c === '.') {
      endToken(frame, false, 'dot', false);
      i += 1;
      continue;
    }
    i += 1;
  }

  return count;
}

async function vendorApiClient() {
  const here = dirname(fileURLToPath(import.meta.url));
  // Bundles @unit-price/api-client → Zod + @unit-price/core, all inlined. (Zod's
  // JIT-eval incompatibility with the WeChat runtime is handled inside
  // parseRankingsResponse via `jitless: true`, not here.)
  const entry = resolve(here, '../../../packages/api-client/dist/index.js');
  const outfile = resolve(here, '../vendor/api-client.js');

  await build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    // es2017 keeps classes/async (weapp lib 3.16.1 runs them) but lowers newer
    // syntax; the explicit `supported` flags force-lower the three operators the
    // WeChat parser chokes on regardless of target.
    target: 'es2017',
    supported: {
      'optional-chain': false,
      'nullish-coalescing': false,
      'logical-assignment': false,
    },
    legalComments: 'none',
    banner: { js: '// GENERATED by scripts/vendor-api-client.mjs — do not edit. Source: @unit-price/api-client' },
    outfile,
  });

  const out = readFileSync(outfile, 'utf8');
  // Real `?.` operators only. The same characters inside strings, comments,
  // template text, or regex literals do not break the WeChat parser.
  const optChain = countOptionalChainOperators(out);
  const classes = (out.match(/\bclass\b/g) || []).length;
  process.stdout.write(
    `vendor-api-client: wrote vendor/api-client.js (${out.length} bytes) — ?. operators=${optChain}, classes preserved=${classes}\n`,
  );
  if (optChain > 0) {
    process.stderr.write('vendor-api-client: FAIL — residual `?.` operators would break the WeChat parser\n');
    process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await vendorApiClient();
}
