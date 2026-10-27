import { describe, expect, it } from 'vitest';
import { countOptionalChainOperators } from './vendor-api-client.mjs';

describe('countOptionalChainOperators', () => {
  it('counts operators in code', () => {
    expect(countOptionalChainOperators('const x = a?.b?.c;')).toBe(2);
  });

  it('ignores the sequence inside strings, comments, and template text', () => {
    expect(countOptionalChainOperators(`"a?.b" + 'c?.d' + \`e?.f\``)).toBe(0);
    expect(countOptionalChainOperators('// a?.b\n/* c?.d */')).toBe(0);
  });

  it('still counts operators inside template interpolations', () => {
    expect(countOptionalChainOperators('`pre ${a?.b} post`')).toBe(1);
    expect(countOptionalChainOperators('`outer ${`inner ${obj?.key}`} end`')).toBe(1);
  });

  it('ignores Zod JIT source that only mentions ?. inside a template', () => {
    const zodEmitter =
      'doc.write(`const ${discVar} = ${accessor}?.[${esc(def.discriminator)}];`);';
    expect(countOptionalChainOperators(zodEmitter)).toBe(0);
  });

  it('counts an operator next to an object literal', () => {
    expect(countOptionalChainOperators('const o = { a: b?.c };')).toBe(1);
  });

  it('ignores quotes and ?. inside regex literals, then still sees a later operator', () => {
    expect(countOptionalChainOperators('const re = /a?.b/;')).toBe(0);
    expect(countOptionalChainOperators('const re = /[?.\'"]/;')).toBe(0);
    expect(countOptionalChainOperators('const re = /["\'] /;\nobj?.x')).toBe(1);
    expect(countOptionalChainOperators('const u = /^[^\\s@"]{1,64}@[^\s@]{1,255}$/u;\nvalue?.trim()')).toBe(1);
    expect(
      countOptionalChainOperators(
        'const html5 = /^[a-zA-Z0-9.!#$%&\'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;\nvalue?.trim()',
      ),
    ).toBe(1);
    expect(
      countOptionalChainOperators(
        "const email = /^(?:[A-Za-z0-9_'+\-]+\.)*[A-Za-z0-9_'+\-]*[A-Za-z0-9_+-]@(?:[A-Za-z0-9][A-Za-z0-9\-]*\.)+[A-Za-z]{2,}$/;\nvalue?.trim()",
      ),
    ).toBe(1);
    expect(
      countOptionalChainOperators(
        'const rfc = /^(([^<>()\\[\\]\\\\.,;:\\s@"]+(\\.[^<>()\\[\\]\\\\.,;:\\s@"]+)*)|(".+"))$/;\nx?.y',
      ),
    ).toBe(1);
  });

  it('does not treat division as a regex', () => {
    expect(countOptionalChainOperators('const n = total / count;\nobj?.prop')).toBe(1);
    expect(countOptionalChainOperators('const n = total / count?.value')).toBe(1);
    expect(countOptionalChainOperators('const n = total / count?.value / 2')).toBe(1);
    expect(countOptionalChainOperators('foo.return / 2;\na?.b')).toBe(1);
    expect(countOptionalChainOperators('const of = 4;\nof / a?.b / c')).toBe(1);
    expect(countOptionalChainOperators('a++ / b?.c')).toBe(1);
    expect(countOptionalChainOperators('const o = { a: 1 } / 2;\nb?.c')).toBe(1);
    expect(countOptionalChainOperators('const f = function () {} / a?.b / c')).toBe(1);
    expect(countOptionalChainOperators('const C = class {} / a?.b / c')).toBe(1);
    expect(countOptionalChainOperators('const f = async function () {} / a?.b / c')).toBe(1);
  });

  it('counts an operator after a regex in statement or interpolation position', () => {
    expect(countOptionalChainOperators('if (c) /["\']/.test(x)\nnext?.prop')).toBe(1);
    expect(countOptionalChainOperators('function f() {}\n/["\']/; a?.b')).toBe(1);
    expect(countOptionalChainOperators('return /["\']/; a?.b')).toBe(1);
    expect(countOptionalChainOperators('for (const x of /["\']/g) x?.y')).toBe(1);
    expect(countOptionalChainOperators('a ?? /["\']/; b?.c')).toBe(1);
    expect(countOptionalChainOperators('++/["\']/; a?.b')).toBe(1);
    expect(countOptionalChainOperators('export default function () {}\n/["\']/; a?.b')).toBe(1);
    expect(countOptionalChainOperators('export default async function () {}\n/["\']/; a?.b')).toBe(1);
    expect(countOptionalChainOperators('const f = () => {}\n/["\']/; a?.b')).toBe(1);
    expect(countOptionalChainOperators('`pre ${/["\']/.test(a?.b)} post`')).toBe(1);
    expect(countOptionalChainOperators('`${ /}/.test(a?.b) }`')).toBe(1);
    expect(countOptionalChainOperators('`${ /["\']}/ ? a?.b : 0 }`')).toBe(1);
    expect(countOptionalChainOperators('/* " */ a?.b')).toBe(1);
    expect(countOptionalChainOperators('const s = "a\\"?.b"; c?.d')).toBe(1);
    expect(countOptionalChainOperators('tag`a?.b ${c?.d}`')).toBe(1);
  });
});
