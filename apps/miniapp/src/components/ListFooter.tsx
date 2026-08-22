// List footer PRESENTATION — end-of-list marker. Pure, props-driven display
// ONLY: NO state machine, NO useRankings, NO Taro lifecycle hooks (D4).
//
// The page-error branch (`pageError` + `onRetryNext`) is RETIRED: paging is a
// local slice of an already-loaded snapshot, so a "next page" cannot fail. A
// retry button for an unreachable failure is not a safety net — it reads like
// one while guarding nothing. The spinner went with it: revealing more of an
// in-memory list is synchronous.
import { View, Text } from '@tarojs/components';

import './ListFooter.css';

export interface ListFooterProps {
  /** Every row of the current view is on screen → show the end marker. */
  reachedEnd: boolean;
}

/** 榜单列表页脚(纯展示、props 驱动):到底时收口。分页是本地切片、不会失败,
 *  故无加载态与本页重试。无状态机、无 useRankings、无 Taro 生命周期(D4)。 */
export default function ListFooter({ reachedEnd }: ListFooterProps) {
  if (!reachedEnd) return null;
  return (
    <View className="lfoot lfoot--end">
      {/* 撕纸/剪口收口:小票在真实末尾「验讫」撕下 */}
      <View className="lfoot__cut">
        <Text className="lfoot__scissors">✂</Text>
      </View>
      <Text className="lfoot__hint">单已验讫 · 已到底</Text>
    </View>
  );
}
