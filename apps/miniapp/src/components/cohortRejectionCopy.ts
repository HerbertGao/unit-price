// Pure copy mapping, kept OUT of ListStates.tsx so it is testable without the
// Taro component runtime — importing the .tsx pulls in @tarojs/components and
// the test file silently collects zero tests, which is worse than no test.
import type { ListEmptyProps } from './ListStates';

/** Copy for the two ways a cohort can refuse to yield a board. Kept beside the
 *  component so both pages render an unrenderable cohort the same way. */
export function cohortRejectionCopy(kind: 'cross-cohort' | 'unknown-category'): ListEmptyProps {
  return kind === 'cross-cohort'
    ? { title: '该分类跨多个比价口径', hint: '请选择具体子分类查看单价榜' }
    : { title: '该分类不存在或已下架', hint: '请返回分类树重新选择' };
}
