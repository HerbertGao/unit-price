export default definePageConfig({
  // No page-level navigationBarTitleText — inherit app-level `会员商店值不值`
  // so the title stays consistent across all three tabs.
  // Enable the native pull-down gesture so usePullDownRefresh fires (offset=0
  // refresh). onReachBottom fires from the page scroll automatically.
  enablePullDownRefresh: true,
  backgroundTextStyle: 'dark',
});
