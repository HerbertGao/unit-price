// Read-only rankings home (榜单 Tab). Composes the P1 shared components per the
// P0 design baseline (design/sams-zhibuzhi/index.html) in order: brand head →
// search entry → static scope bar → attribute chips → ranking list.
//
// Consumes prod GET /rankings via @unit-price/api-client (buildRankingsUrl +
// parseRankingsResponse, jitless) over Taro.request — wired through useRankings.
// NO entry/scan/photo path, NO core tier1/calc on device: the list is
// already-computed per100ml from /rankings. The search entry and attribute chips
// are placeholders only — they NEVER request and NEVER reorder the list.
//
// Data layer (the state machine + Taro lifecycle hooks) stays in the page (D4);
// the components are pure presentation. Renders the spec's three states (loading
// / empty / first-screen error) with the two error positions kept distinct
// (whole-screen first-screen error vs list-preserving page error), pull-to-refresh
// + reach-bottom pagination, and the degraded in-list ad slot (zero-height in v1).
import { View, ScrollView } from '@tarojs/components';
import { useLoad, usePullDownRefresh, useReachBottom } from '@tarojs/taro';
import Taro from '@tarojs/taro';
import { Fragment } from 'react';
import { useRankings } from './useRankings';
import { isAdSlotAfterRank } from './adSlots';
import AdSlot from '../../components/AdSlot';
import BrandHead from '../../components/BrandHead';
import SearchEntry from '../../components/SearchEntry';
import ScopeBar from '../../components/ScopeBar';
import Chip from '../../components/Chip';
import RankingRow from '../../components/RankingRow';
import ListFooter from '../../components/ListFooter';
import { ListLoading, ListEmpty, FirstScreenError } from '../../components/ListStates';

import './index.css';

// Static placeholder chip set (P0 ".chips": 全部/无糖/气泡/进口/茶饮). All disabled
// in P1 — tapping does NOT request, does NOT reorder. Real attribute filtering is
// P3. The leading "全部" carries the active visual, the rest are dimmed placeholders.
const CHIPS: ReadonlyArray<{ label: string; active?: boolean }> = [
  { label: '全部', active: true },
  { label: '无糖' },
  { label: '气泡' },
  { label: '进口' },
  { label: '茶饮' },
];

// Layout-only inline styles (no color literals — color is owned by the components'
// own CSS via tokens). The chips row scrolls horizontally; the gaps are spacing.
const CHIPS_ROW_STYLE = {
  display: 'flex',
  gap: '16rpx',
  padding: '8rpx 24rpx 4rpx',
  whiteSpace: 'nowrap' as const,
} as const;

/** Header block shown above every list state so the brand / search / scope /
 *  chips are present whether the list is loading, empty, errored, or ready. */
function Header() {
  return (
    <Fragment>
      <BrandHead />
      <SearchEntry
        onClick={() => {
          // Placeholder only: a "敬请期待" toast. NO navigation, NO request, NO
          // input/focus state. Real search is P4 (spec / D5).
          void Taro.showToast({ title: '敬请期待', icon: 'none' });
        }}
      />
      <ScopeBar />
      <ScrollView scrollX className="chips" style={CHIPS_ROW_STYLE}>
        {CHIPS.map((c) => (
          <Chip key={c.label} label={c.label} active={c.active} disabled={!c.active} />
        ))}
      </ScrollView>
    </Fragment>
  );
}

export default function Index() {
  const r = useRankings();

  useLoad(() => {
    r.loadFirst();
  });

  // Pull-to-refresh: reset offset=0, replace the list; stop the native spinner
  // once the request settles (success OR failure).
  usePullDownRefresh(() => {
    void r.refresh().finally(() => {
      void Taro.stopPullDownRefresh();
    });
  });

  // Reach-bottom: append the next page (no-op while loading / at end / in a
  // first-screen error / when a page error is pending its local retry).
  useReachBottom(() => {
    r.loadNext();
  });

  // FIRST-SCREEN error: whole-screen error + retry. Never a blank screen. Error
  // judgement stays in useRankings (unchanged); the page just renders it.
  if (r.phase === 'error') {
    return (
      <View className="screen">
        <Header />
        <FirstScreenError onRetry={() => r.retryFirst()} />
      </View>
    );
  }

  // First-screen loading (no list yet).
  if (r.phase === 'idle' || (r.phase === 'loading' && r.items.length === 0)) {
    return (
      <View className="screen">
        <Header />
        <ListLoading />
      </View>
    );
  }

  // Empty state: a validated [] from /rankings → explicit empty, not blank/error.
  if (r.phase === 'ready' && r.items.length === 0) {
    return (
      <View className="screen">
        <Header />
        <ListEmpty />
      </View>
    );
  }

  // Ready with items: render the list (per100ml ascending, already sorted by the
  // server) interleaved with degraded ad slots after render rank 10/22/34/…
  return (
    <View className="screen">
      <Header />
      <View className="list">
        {r.items.map((item) => {
          const showAdAfter = isAdSlotAfterRank(item.rank);
          return (
            <Fragment key={`${item.store}:${item.storeSku}:${item.rank}`}>
              <RankingRow item={item} />
              {showAdAfter ? <AdSlot id={`ad-slot-after-${item.rank}`} /> : null}
            </Fragment>
          );
        })}
      </View>

      <ListFooter
        pageLoading={r.pageLoading}
        pageError={r.pageError}
        reachedEnd={r.reachedEnd}
        onRetryNext={() => r.retryNext()}
      />
    </View>
  );
}
