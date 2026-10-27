// 单价信任页。从榜单行进入，展示服务端已经算好的规格、formula 和 cohort。
// 端上不跑 core，也不用标价乘规格重算 per100ml。
import { View, Text } from '@tarojs/components';
import Taro, { useLoad, usePullDownRefresh, useRouter } from '@tarojs/taro';
import { useCallback, useState } from 'react';
import { buildProductTrustUrl, type ProductTrust } from '@unit-price/api-client';
import { ListEmpty, ListLoading, FirstScreenError } from '../../components/ListStates';
import { formatRank } from '../../components/RankingRow';
import { BASE, BASE_IS_PLACEHOLDER } from '../index/config';
import { readTrustParams, trustPageUrl } from './params';
import { acceptTrustResponse, TrustNotFound } from './response';
import {
  cohortCopy,
  formatCapturedAt,
  formatConfidence,
  formatPer100ml,
  historicalLowLine,
  priceLine,
  specLines,
  staleNote,
} from './view';

import '../index/index.css';
import './index.css';

type Phase = 'loading' | 'ready' | 'error' | 'missing';

async function fetchTrust(id: string, cohort: string | undefined): Promise<ProductTrust> {
  if (BASE_IS_PLACEHOLDER) {
    throw new Error('BASE 未配置');
  }
  const res = await Taro.request({
    url: buildProductTrustUrl(BASE, id, cohort),
    method: 'GET',
  });
  return acceptTrustResponse(res.statusCode, res.data);
}

export default function TrustPage() {
  const router = useRouter();
  const { id, cohort } = readTrustParams(router.params);
  const [phase, setPhase] = useState<Phase>(id ? 'loading' : 'missing');
  const [trust, setTrust] = useState<ProductTrust | null>(null);
  const [err, setErr] = useState(id ? '' : '从榜单打开才能看依据');

  const load = useCallback(() => {
    if (!id) {
      setPhase('missing');
      setErr('从榜单打开才能看依据');
      return;
    }
    setPhase('loading');
    return fetchTrust(id, cohort)
      .then((body) => {
        setTrust(body);
        setPhase('ready');
      })
      .catch((error: unknown) => {
        if (error instanceof TrustNotFound) {
          setErr(error.message);
          setPhase('missing');
          return;
        }
        setPhase('error');
      });
  }, [id, cohort]);

  useLoad(() => {
    void load();
  });

  usePullDownRefresh(() => {
    void Promise.resolve(load()).finally(() => {
      void Taro.stopPullDownRefresh();
    });
  });

  if (phase === 'missing') {
    return (
      <View className="screen">
        <ListEmpty title={err || '榜单里没有这件商品'} hint="返回榜单再试" />
      </View>
    );
  }

  if (phase === 'error') {
    return (
      <View className="screen">
        <FirstScreenError onRetry={load} title="依据加载失败" hint="请检查网络后重试" />
      </View>
    );
  }

  if (phase === 'loading' || trust == null) {
    return (
      <View className="screen">
        <ListLoading />
      </View>
    );
  }

  const copy = cohortCopy(trust);
  const lowest = historicalLowLine(trust);
  const stale = staleNote(trust, Date.now());
  const peerCohort = trust.cohort.slug ?? cohort ?? '';

  return (
    <View className="trust">
      <Text className="trust__title">{trust.title}</Text>
      <View className="trust__per">
        <Text className="trust__per-num">{formatPer100ml(trust.per100ml)}</Text>
        <Text className="trust__per-unit">元/100ml</Text>
      </View>
      <Text className="trust__meta">{priceLine(trust)}</Text>
      <Text className="trust__meta">{formatCapturedAt(trust.capturedAt)}</Text>
      <View className="trust__chips">
        {lowest ? <Text className="trust__lowest">{lowest}</Text> : null}
        <Text className="trust__chip">置信度 {formatConfidence(trust.confidence)}</Text>
        {stale ? <Text className="trust__chip">{stale}</Text> : null}
        {trust.warnings.map((warning) => (
          <Text key={warning} className="trust__warn">⚠ {warning}</Text>
        ))}
      </View>

      <Text className="trust__h">规格</Text>
      {specLines(trust).map((line) => (
        <View key={line.label} className="trust__line">
          <Text className="trust__label">{line.label}</Text>
          <Text className="trust__value">{line.value}</Text>
        </View>
      ))}

      <Text className="trust__h">怎么算的</Text>
      <Text className="trust__formula">{trust.formula}</Text>

      <Text className="trust__h">同类</Text>
      <Text className="trust__headline">{copy.headline}</Text>
      {copy.detail ? <Text className="trust__detail">{copy.detail}</Text> : null}
      {trust.cohort.peers.map((peer) => (
        <View
          key={peer.id}
          className="trust__peer"
          onClick={() => {
            void Taro.navigateTo({ url: trustPageUrl(peer.id, peerCohort) });
          }}
        >
          <Text className="trust__peer-rank">#{formatRank(peer.rank)}</Text>
          <Text className="trust__peer-title">{peer.title}</Text>
          <Text className="trust__peer-price">{formatPer100ml(peer.per100ml)}</Text>
        </View>
      ))}
    </View>
  );
}
