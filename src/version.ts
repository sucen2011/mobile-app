// App 版本号（「我的 → 关于」里显示）。
//
// ⚠️ 发版时必须**同步改两处**，否则界面显示的版本会和安装包对不上：
//   1) app.json        → expo.version / expo.android.versionCode
//   2) 本文件          → APP_VERSION / APP_VERSION_CODE
//
// 为什么不用运行时读：本项目未安装 expo-constants / expo-application，
// 无法在 JS 侧读取原生版本号。原先 Settings 里把 "v1.0" 直接写死在 UI 文本里，
// 导致换了多少版包都显示 v1.0（用户无法据此判断新包是否装上）。改为集中常量后，
// 至少做到「一处维护、发版必改」，不会再出现永远不变的情况。
export const APP_VERSION = '1.1.6';
export const APP_VERSION_CODE = 17;
