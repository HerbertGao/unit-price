// 我的 Tab — 比价工具区 + 关于区。只读边界:本页自身不发任何网络请求,不做端上计算
// (源码不出现任何网络发起/URL 构造调用,使「我的自身不发请求」可被源码检查机械验证)。
//   · 比价工具区:常驻「即时比价」入口(仅 navigateTo 到 /pages/compute/index)+ 端上本地
//     比价历史(读自存储,经 useDidShow 每次进入重读,倒序列出,点项以稳定 ts 回填)。
//   · 关于区:静态数据来源/时效/免责文案(合 §7 合规口径,众包贡献 + 运营整理校准口径)+
//     微信原生 open-type=feedback 意见反馈(通用反馈,非纠错/录入入口)。
// 本期禁止任何贡献 / 录入 / 纠错 / 扫码 / 拍照入口(只读边界)。
import { View, Text, Button } from '@tarojs/components';
import Taro, { useDidShow } from '@tarojs/taro';
import { useState } from 'react';
import { readHistory, type HistoryItem } from '../compute/history';

import './index.css';

const COMPUTE_PATH = '/pages/compute/index';

/** Format a stored `ts` (epoch ms) into a readable relative/absolute label —
 *  no date library. <1min→刚刚, <1h→N分钟前, <24h→N小时前, else→YYYY-MM-DD HH:mm. */
function formatTs(ts: number): string {
  const diff = Date.now() - ts;
  const min = 60 * 1000;
  const hour = 60 * min;
  const day = 24 * hour;
  if (diff < min) return '刚刚';
  if (diff < hour) return `${Math.floor(diff / min)} 分钟前`;
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
  const d = new Date(ts);
  const p = (n: number) => (n < 10 ? `0${n}` : `${n}`);
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export default function Mine() {
  const [history, setHistory] = useState<HistoryItem[]>([]);

  // Re-read on EVERY page show (not only first load) so a fresh 比价 done elsewhere
  // appears after switching back to this Tab. readHistory() is already newest-first,
  // validated and deduped — render in order, key by the stable `ts`.
  useDidShow(() => {
    setHistory(readHistory());
  });

  // 常驻「即时比价」入口 — 绝对路径 + /index + 对象形式,与既有 navigateTo 约定一致;
  // 入口本身不发网络请求(请求由比价表单页发起)。
  const openCompute = () => {
    void Taro.navigateTo({ url: COMPUTE_PATH });
  };

  // 点击历史项 → 以该项稳定 ts 作 handle 回填比价表单(非数组索引)。
  const openHistory = (ts: number) => {
    void Taro.navigateTo({ url: `${COMPUTE_PATH}?h=${ts}` });
  };

  return (
    <View className='mine'>
      {/* — 比价工具区 — */}
      <View className='mine-sec'>
        <Text className='mine-sec__title'>比价工具</Text>

        <View className='mine-entry' onClick={openCompute}>
          <View className='mine-entry__main'>
            <Text className='mine-entry__title'>即时比价</Text>
            <Text className='mine-entry__sub'>输入规格，算它的单价、看在同类里排哪</Text>
          </View>
          <View className='mine-entry__caret' />
        </View>

        {history.length > 0 ? (
          <View className='mine-hist'>
            <Text className='mine-hist__h'>历史比价</Text>
            {history.map((item) => (
              <View key={item.ts} className='mine-hist__row' onClick={() => openHistory(item.ts)}>
                <View className='mine-hist__body'>
                  <Text className='mine-hist__summary'>{item.summary}</Text>
                  <Text className='mine-hist__time'>{formatTs(item.ts)}</Text>
                </View>
                <View className='mine-hist__caret' />
              </View>
            ))}
          </View>
        ) : (
          <View className='mine-empty'>
            <Text className='mine-empty__t'>还没有比价记录</Text>
            <Text className='mine-empty__sub'>遇到没收录的商品，去算算它值不值</Text>
            <View className='mine-empty__cta' onClick={openCompute}>
              <Text className='mine-empty__cta-t'>去比价</Text>
            </View>
          </View>
        )}
      </View>

      {/* — 关于区 — 静态文案 + 微信原生反馈,无任何网络请求 */}
      <View className='mine-sec'>
        <Text className='mine-sec__title'>关于</Text>

        <View className='mine-about'>
          <Text className='mine-about__h'>数据来源</Text>
          <Text className='mine-about__p'>
            单价数据来自用户主动贡献的众包数据，并经运营整理与校准。
          </Text>
          <Text className='mine-about__p'>
            价格随时间变动，展示价格可能已过期；结论仅供参考，不构成购买建议。
          </Text>
        </View>

        <Button className='mine-feedback' openType='feedback'>
          意见反馈
        </Button>
      </View>
    </View>
  );
}
