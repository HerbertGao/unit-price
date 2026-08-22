// Per100ml-ascending board reused by category drill-down and search. Both views
// call useRankings(category, q), which reads one snapshot and filters/slices it
// locally while preserving server order. This non-tab page only changes title
// chrome; it never issues category- or query-specific rankings requests.
import { View } from "@tarojs/components";
import Taro, {
  useRouter,
  useLoad,
  usePullDownRefresh,
  useReachBottom,
} from "@tarojs/taro";
import { useRankings } from "../index/useRankings";
import { readBoardParams } from "./params";
import RankingRow from "../../components/RankingRow";
import ListFooter from "../../components/ListFooter";
import {
  ListLoading,
  ListEmpty,
  FirstScreenError,
  cohortRejectionCopy,
} from "../../components/ListStates";
import ComputeCta from "../../components/ComputeCta";

// Reuse the 榜单 Tab's .screen/.list rules — same list chrome, no second copy.
import "../index/index.css";

export default function Board() {
  const router = useRouter();
  // Missing category falls back to the named landing cohort in useRankings; q is
  // the decoded local-search term and name is the already-derived page title.
  const { category, q, name } = readBoardParams(router.params);

  const r = useRankings(category, q);

  useLoad(() => {
    // `name` is already the decoded-q-or-category title (not the encoded q).
    void Taro.setNavigationBarTitle({ title: name });
    r.loadFirst();
  });

  usePullDownRefresh(() => {
    void r.refresh().finally(() => {
      void Taro.stopPullDownRefresh();
    });
  });

  useReachBottom(() => {
    r.loadNext();
  });

  if (r.phase === "error") {
    return (
      <View className="screen">
        <FirstScreenError onRetry={() => r.retryFirst()} />
      </View>
    );
  }

  if (r.phase === "idle" || (r.phase === "loading" && r.items.length === 0)) {
    return (
      <View className="screen">
        <ListLoading />
      </View>
    );
  }

  // Empty: in SEARCH mode (q set) → the 比价 CTA (highest-intent "not found"
  // moment, primary entry to /compute); in category-drill mode → plain empty.
  // A refused cohort outranks the search CTA: "no match for 元气森林" is the wrong
  // story when the board itself could never be derived.
  if (r.phase === "ready" && r.items.length === 0) {
    return (
      <View className="screen">
        {r.rejection ? (
          <ListEmpty {...cohortRejectionCopy(r.rejection.kind)} />
        ) : q ? (
          <ComputeCta term={q} />
        ) : (
          <ListEmpty />
        )}
      </View>
    );
  }

  return (
    <View className="screen">
      <View className="list">
        {r.items.map((item) => (
          <RankingRow key={item.id} item={item} />
        ))}
      </View>
      <ListFooter reachedEnd={r.reachedEnd} />
    </View>
  );
}
