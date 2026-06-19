export default definePageConfig({
  // Title is set at runtime to the tapped category's name (setNavigationBarTitle).
  // Match the 榜单 Tab's scroll affordances so usePullDownRefresh / onReachBottom
  // fire identically on this board.
  enablePullDownRefresh: true,
  backgroundTextStyle: 'dark',
});
