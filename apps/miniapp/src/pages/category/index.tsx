// 分类 Tab — P1 占位页(带 P0 设计语言)。只读骨架:不发任何请求、不做端上计算。
// 真实品类树 / 按品类比价属 P3。
import { View, Text } from '@tarojs/components';

import './index.css';

export default function Category() {
  return (
    <View className='placeholder'>
      <View className='placeholder__card'>
        <Text className='placeholder__title'>分类比价</Text>
        <Text className='placeholder__hint'>敬请期待</Text>
        <Text className='placeholder__sub'>按品类 / 属性横向比价正在路上</Text>
      </View>
    </View>
  );
}
