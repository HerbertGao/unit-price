// 分类 Tab — the store-agnostic category is-a tree. One GET /categories on load
// (no pagination: the whole tree is a single small payload), flattened into a
// pre-order indented list. Rankable nodes (a single comparable cohort) are
// tappable → the category-scoped 分类榜 (/pages/board). Non-rankable nodes
// (root 饮料 / 酒类 parent) are group headers, NOT clickable — tapping one would
// hit the server's cohort 400, so the tree gates clickability by node.rankable.
//
// Read-only: NO on-device calc, NO write path. comparableUnit (is-a inherited)
// and rankableCount are already resolved server-side; the page just draws them.
import { View, Text } from '@tarojs/components';
import Taro, { useLoad } from '@tarojs/taro';
import { useState } from 'react';
import {
  buildCategoriesUrl,
  parseCategoryTreeResponse,
  type CategoryTreeNode,
} from '@unit-price/api-client';
import { BASE, BASE_IS_PLACEHOLDER } from '../index/config';
import { toRows, type Row } from './tree';

import './index.css';

type Phase = 'idle' | 'loading' | 'ready' | 'error';

/** One validated GET /categories fetch. Throws on network OR schema failure
 *  (parseCategoryTreeResponse is fail-closed) — caught into the error state. */
async function fetchTree(): Promise<CategoryTreeNode[]> {
  if (BASE_IS_PLACEHOLDER) {
    throw new Error('BASE 未配置：见 src/pages/index/config.ts');
  }
  const res = await Taro.request({ url: buildCategoriesUrl(BASE), method: 'GET' });
  return parseCategoryTreeResponse(res.data).nodes;
}

/** Loading / error / empty card — reuses the .placeholder design language. */
function StateCard(props: { hint: string; sub?: string; onTap?: () => void }) {
  return (
    <View className="placeholder">
      <View className="placeholder__card" onClick={props.onTap}>
        <Text className="placeholder__title">分类比价</Text>
        <Text className="placeholder__hint">{props.hint}</Text>
        {props.sub ? <Text className="placeholder__sub">{props.sub}</Text> : null}
      </View>
    </View>
  );
}

export default function Category() {
  const [phase, setPhase] = useState<Phase>('idle');
  const [rows, setRows] = useState<Row[]>([]);

  const load = () => {
    setPhase('loading');
    fetchTree()
      .then((nodes) => {
        setRows(toRows(nodes));
        setPhase('ready');
      })
      .catch(() => setPhase('error'));
  };

  useLoad(() => {
    load();
  });

  // Only rankable nodes navigate; non-rankable group headers are inert.
  const open = (node: CategoryTreeNode) => {
    if (!node.rankable) return;
    void Taro.navigateTo({
      url: `/pages/board/index?category=${encodeURIComponent(node.slug)}&name=${encodeURIComponent(node.name)}`,
    });
  };

  if (phase === 'idle' || phase === 'loading') {
    return <StateCard hint="加载中…" />;
  }
  if (phase === 'error') {
    return <StateCard hint="加载失败" sub="点击重试" onTap={load} />;
  }
  if (rows.length === 0) {
    return <StateCard hint="暂无分类" sub="数据准备中" />;
  }

  return (
    <View className="ctree">
      {rows.map(({ node, depth }) => (
        <View
          key={node.slug}
          className={`ctree__row${node.rankable ? ' ctree__row--clickable' : ' ctree__row--group'}`}
          style={{ paddingLeft: `${24 + depth * 32}rpx` }}
          onClick={() => open(node)}
        >
          <Text className="ctree__name">{node.name}</Text>
          {node.rankableCount > 0 ? (
            <Text className="ctree__count">{node.rankableCount}</Text>
          ) : null}
          {node.rankable ? <Text className="ctree__chev">›</Text> : null}
        </View>
      ))}
    </View>
  );
}
