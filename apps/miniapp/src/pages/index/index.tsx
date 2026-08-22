// Read-only rankings home (榜单 Tab). Composes the P1 shared components per the
// P0 design baseline (design/sams-zhibuzhi/index.html) in order: brand head →
// search entry → static scope bar → ranking list.
//
// Fetches one validated rankings snapshot through useRankings. No entry/scan/
// photo path and no core tier1/calculation runs on device: per100ml is stored by
// the server. Cohort drill-down, search, and pagination are local, order-preserving
// views over that snapshot and send no additional rankings request.
//
// Data layer (state machine + Taro lifecycle hooks) stays in the page; components
// are pure presentation. It renders loading/empty/first-screen-error, supports
// pull-to-refresh, and reveals additional local slices on reach-bottom.
import { View, Text } from "@tarojs/components";
import { useLoad, usePullDownRefresh, useReachBottom } from "@tarojs/taro";
import Taro from "@tarojs/taro";
import { Fragment } from "react";
import { useRankings } from "./useRankings";
import { isAdSlotAfterRank } from "./adSlots";
import AdSlot from "../../components/AdSlot";
import BrandHead from "../../components/BrandHead";
import SearchEntry from "../../components/SearchEntry";
import ScopeBar from "../../components/ScopeBar";
import RankingRow from "../../components/RankingRow";
import ListFooter from "../../components/ListFooter";
import {
  ListLoading,
  ListEmpty,
  FirstScreenError,
  cohortRejectionCopy,
} from "../../components/ListStates";

import "./index.css";

/** Header block shown above every list state so the brand / search / scope are
 *  present whether the list is loading, empty, errored, or ready. */
function Header() {
  return (
    <Fragment>
      {/* 小票头:商户抬头 → 口径 scope(dashed 收口)→ 搜索框。scope 属于小票头的一部分,
          故排在搜索之前。 */}
      <BrandHead />
      <ScopeBar />
      {/* Confirm navigates to board?q=…; that page filters the snapshot locally. */}
      <SearchEntry />
      {/* 比价辅入口(视觉次于搜索)。主入口是搜索无结果态的 ComputeCta;此处给
          「搜索前就知道没收录」的用户一个常驻 handle。→ pages/compute。 */}
      <View
        className="homecalc"
        onClick={() => {
          void Taro.navigateTo({ url: "/pages/compute/index" });
        }}
      >
        <Text className="homecalc__t">
          店里有、榜上没有的？
          <Text className="homecalc__lnk">输入规格算单价 ›</Text>
        </Text>
      </View>
    </Fragment>
  );
}

/** 榜单只读首页(榜单 Tab):按 P0 基线依次组合 品牌头 → 搜索入口 → 静态范围条 →
 *  榜单列表;经 useRankings 消费 GET /rankings,端上不做 tier1 / 单价计算。 */
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

  // Reach-bottom reveals the next local slice; no-op while loading, at end, or
  // in a first-screen error.
  useReachBottom(() => {
    r.loadNext();
  });

  // FIRST-SCREEN error: whole-screen error + retry. Never a blank screen. Error
  // judgement stays in useRankings (unchanged); the page just renders it.
  if (r.phase === "error") {
    return (
      <View className="screen">
        <Header />
        <FirstScreenError onRetry={() => r.retryFirst()} />
      </View>
    );
  }

  // First-screen loading (no list yet).
  if (r.phase === "idle" || (r.phase === "loading" && r.items.length === 0)) {
    return (
      <View className="screen">
        <Header />
        <ListLoading />
      </View>
    );
  }

  // Empty state: a validated [] from /rankings → explicit empty, not blank/error.
  // A REFUSED cohort is a different empty and says so — telling the user to pull
  // to refresh a board that can never exist is the kind of dead retry affordance
  // this page deleted from its footer.
  if (r.phase === "ready" && r.items.length === 0) {
    return (
      <View className="screen">
        <Header />
        <ListEmpty
          {...(r.rejection ? cohortRejectionCopy(r.rejection.kind) : {})}
        />
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
            <Fragment key={item.id}>
              <RankingRow item={item} />
              {showAdAfter ? (
                <AdSlot id={`ad-slot-after-${item.rank}`} />
              ) : null}
            </Fragment>
          );
        })}
      </View>

      <ListFooter reachedEnd={r.reachedEnd} />
    </View>
  );
}
