// The rejection-copy mapping had no test at all: inverting the branch — telling
// an unknown slug 「请选择具体子分类」 and a cross-axis node 「该分类不存在」 —
// left all 97 miniapp tests green. The literal-union parameter that the
// typecheck step protects guards the CALL SITES, not the mapping itself.
import { describe, expect, it } from 'vitest';
import { cohortRejectionCopy } from './cohortRejectionCopy';

describe('cohortRejectionCopy', () => {
  it.each([
    ['cross-cohort', '跨', '子分类'],
    ['unknown-category', '不存在', '重新选择'],
  ] as const)('%s names its own cause', (kind, inTitle, inHint) => {
    const got = cohortRejectionCopy(kind);
    expect(got.title).toContain(inTitle);
    expect(got.hint).toContain(inHint);
  });

  it('never tells a user to pull-to-refresh a board that cannot exist', () => {
    // The whole point of the two branches: 「下拉刷新试试」 is the default empty
    // copy, and offering it here is the dead-retry affordance this change
    // deleted from the footer — reintroduced on a full screen.
    for (const kind of ['cross-cohort', 'unknown-category'] as const) {
      const got = cohortRejectionCopy(kind);
      expect(`${got.title}${got.hint}`).not.toContain('下拉刷新');
    }
  });

  it('gives the two kinds different copy', () => {
    const a = cohortRejectionCopy('cross-cohort');
    const b = cohortRejectionCopy('unknown-category');
    expect(a.title).not.toBe(b.title);
  });
});
