// Three-state PRESENTATION for the rankings list — loading / empty /
// first-screen error. Pure, props-driven display ONLY: NO state machine, NO
// useRankings, NO Taro lifecycle hooks (D4). The page decides WHICH state is
// active (from useRankings) and renders the matching component; these just draw
// it. Copy is carried over verbatim from the existing read-only screen.
import { View, Text } from '@tarojs/components';

import './ListStates.css';

/** First-screen loading — no list yet. */
export function ListLoading() {
  return (
    <View className="lstate lstate--center">
      <Text className="lstate__hint">加载中…</Text>
    </View>
  );
}

/** Empty: a validated [] from /rankings → explicit empty, not blank/error. */
export function ListEmpty() {
  return (
    <View className="lstate lstate--center">
      <Text className="lstate__title">榜单暂无数据</Text>
      <Text className="lstate__hint">下拉刷新试试</Text>
    </View>
  );
}

export interface FirstScreenErrorProps {
  /** Whole-screen retry handler — supplied by the page (maps to retryFirst). */
  onRetry: () => void;
}

/** First-screen error: whole-screen error + retry. Never a white screen. */
export function FirstScreenError({ onRetry }: FirstScreenErrorProps) {
  return (
    <View className="lstate lstate--center">
      <Text className="lstate__title">榜单加载失败</Text>
      <Text className="lstate__hint">请检查网络后重试</Text>
      <View className="lstate__btn" onClick={onRetry}>
        <Text className="lstate__btn-text">重试</Text>
      </View>
    </View>
  );
}
