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
});
