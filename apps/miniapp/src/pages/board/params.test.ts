import { describe, it, expect } from 'vitest';
import { readBoardParams } from './params';

describe('readBoardParams', () => {
  it('reads category; folds missing/blank to undefined (un-scoped list)', () => {
    expect(readBoardParams({ category: 'soft-drink' }).category).toBe('soft-drink');
    expect(readBoardParams({}).category).toBeUndefined();
    expect(readBoardParams({ category: '' }).category).toBeUndefined();
  });

  it('name defaults when absent', () => {
    expect(readBoardParams({}).name).toBe('分类榜');
  });

  it('decodes an encoded name', () => {
    expect(readBoardParams({ name: encodeURIComponent('软饮') }).name).toBe('软饮');
  });

  it('never throws on a name with a literal % (already-decoded input)', () => {
    // decodeURIComponent('100%纯果汁') would throw URIError → fallback to raw.
    expect(readBoardParams({ name: '100%纯果汁' }).name).toBe('100%纯果汁');
  });
});
