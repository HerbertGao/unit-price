// 我的 Tab — P1 占位页(带 P0 设计语言)。只读骨架:不发任何请求、不做端上计算。
// 本期禁止任何贡献 / 录入 / 纠错 / 扫码 / 拍照入口(只读边界;贡献留待 P6)。
import { View, Text } from '@tarojs/components';

import './index.css';

export default function Mine() {
  return (
    <View className='placeholder'>
      <View className='placeholder__card'>
        <Text className='placeholder__title'>我的</Text>
        <Text className='placeholder__hint'>敬请期待</Text>
        <Text className='placeholder__sub'>更多个人功能正在路上</Text>
      </View>
    </View>
  );
}
