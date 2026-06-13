// List footer PRESENTATION — pagination spinner / page-error local retry /
// end-of-list marker. Pure, props-driven display ONLY: NO state machine, NO
// useRankings, NO Taro lifecycle hooks (D4). The page passes the already-decided
// flags; this only draws the matching footer. The three flags are mutually
// exclusive in practice, but each is rendered independently so the page keeps
// full control. Copy carried over verbatim from the existing screen.
import { View, Text } from '@tarojs/components';

import './ListFooter.css';

export interface ListFooterProps {
  /** A next page (offset>0) is in flight → footer spinner. */
  pageLoading: boolean;
  /** A next-page load failed but the list is preserved → local retry. */
  pageError: boolean;
  /** A page returned [] → no more pages, show the end marker. */
  reachedEnd: boolean;
  /** Local retry for the failed next page (maps to retryNext). */
  onRetryNext: () => void;
}

export default function ListFooter({
  pageLoading,
  pageError,
  reachedEnd,
  onRetryNext,
}: ListFooterProps) {
  return (
    <View>
      {pageLoading ? (
        <View className="lfoot">
          <Text className="lfoot__hint">加载中…</Text>
        </View>
      ) : null}
      {pageError ? (
        <View className="lfoot">
          <Text className="lfoot__hint">下一页加载失败</Text>
          <View className="lfoot__btn" onClick={onRetryNext}>
            <Text className="lfoot__btn-text">重试本页</Text>
          </View>
        </View>
      ) : null}
      {reachedEnd && !pageError ? (
        <View className="lfoot">
          <Text className="lfoot__hint">已到底</Text>
        </View>
      ) : null}
    </View>
  );
}
