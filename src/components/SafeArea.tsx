// 跨平台安全区容器（零新增依赖）
//
// 背景 / 根因：
//   原先 App.tsx 用 `paddingTop: StatusBar.currentHeight || 0` 来避开状态栏，
//   但 `StatusBar.currentHeight` 是 **Android-only** 的 API，在 iOS 上恒为 undefined，
//   于是 iOS 上 paddingTop 恒为 0 —— 顶部导航栏（取消/保存）直接压在状态栏、
//   刘海、灵动岛下面，按钮点不到。
//
// 修法：
//   iOS  → 用 RN 自带 SafeAreaView（原生真实 inset，刘海 / 灵动岛 / home indicator 都准）
//   其他 → 普通 View + paddingTop: StatusBar.currentHeight
//
// 关于绝对定位子节点（⚠ 这里原来的结论是错的，已按实测修正）：
//   Android：根节点用的是真正的 Yoga `paddingTop`，Yoga 确实会把它应用到
//   position:'absolute' 的子节点上，所以 overlay 自动落在状态栏下面，无需额外补白。
//
//   iOS：**不成立**。根节点的安全区不是普通 Yoga padding —— RCTSafeAreaView 是把
//   UIKit 的真实 inset 以 localData 灌进 shadow view 的，而 App.tsx 里那几个 overlay
//   （EntryForm / RevenueForm / RecordDetail）是 top/left/right/bottom 四边全钉死的
//   绝对定位节点，按 containing block 的 **border box** 解算，于是实际从 y=0 起画，
//   顶部导航条被状态栏 / 刘海 / 灵动岛压住，「关闭 / 取消」点不到。
//   → 这类 overlay 的 header 必须用下面的 SafeAreaHeader 局部补顶部安全区。
//
//   例外：RN 的 <Modal> 走的是独立 native window，父节点 padding 完全作用不到，
//   必须自己用下面的 BOTTOM_INSET / TOP_INSET 手动补（例：EntryForm 的相机 Modal）。
import React from 'react';
import {
  Dimensions,
  Platform,
  SafeAreaView,
  StatusBar,
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

/** Android 状态栏高度；iOS 交给 SafeAreaView 处理，这里为 0 */
export const ANDROID_STATUS_BAR_INSET =
  Platform.OS === 'android' ? StatusBar.currentHeight ?? 24 : 0;

/**
 * 是否为带 Home Indicator 的全面屏 iPhone（无实体 Home 键）。
 * 零依赖判定：全面屏机型最短边 >= 375 且长宽比 >= 2.0（iPhone X 起）。
 * iPhone SE / 8 这类 16:9 机型比值 ~1.78，会被正确排除。
 */
function hasHomeIndicator(): boolean {
  if (Platform.OS !== 'ios') return false;
  const { width, height } = Dimensions.get('window');
  const longest = Math.max(width, height);
  const shortest = Math.min(width, height);
  return shortest >= 375 && longest / shortest >= 2.0;
}

/**
 * 底部 Home Indicator 高度。
 * 仅用于 RN <Modal> 这种拿不到父级 safe area 的场景（普通页面由 SafeAreaRoot 负责）。
 */
export const BOTTOM_INSET = hasHomeIndicator() ? 34 : 0;

/** 顶部状态栏 / 刘海高度，同样仅用于 Modal 内部手动补白 */
export const TOP_INSET =
  Platform.OS === 'ios' ? (hasHomeIndicator() ? 44 : 20) : ANDROID_STATUS_BAR_INSET;

interface Props {
  style?: StyleProp<ViewStyle>;
  children?: React.ReactNode;
}

/**
 * App 根容器：自动避开状态栏 / 刘海 / 灵动岛 / 底部 Home Indicator。
 * iOS 走原生 SafeAreaView（四边真实 inset，底部 tabbar 一并被抬起来）。
 */
export function SafeAreaRoot({ style, children }: Props) {
  if (Platform.OS === 'ios') {
    return <SafeAreaView style={[styles.fill, style]}>{children}</SafeAreaView>;
  }
  return (
    <View style={[styles.fill, { paddingTop: ANDROID_STATUS_BAR_INSET }, style]}>
      {children}
    </View>
  );
}

/** 兼容别名 */
export const SafeAreaScreen = SafeAreaRoot;

/**
 * 全屏浮层（EntryForm / RevenueForm / RecordDetail）的顶部导航条容器。
 *
 * 根因（为什么上面那段"绝对定位子节点会继承根 padding"的注释在 iOS 上不成立）：
 *   App.tsx 里这三个页面是挂在 `position:'absolute'; top:0; left:0; right:0; bottom:0`
 *   的 overlay 里的。iOS 上根节点的安全区**不是**一个普通 Yoga `padding` 样式 ——
 *   它由 RCTSafeAreaView 把 UIKit 的真实 inset 以 localData 形式灌进 shadow view，
 *   而四边都钉死（top/bottom 同时给值）的绝对定位子节点是按 containing block 的
 *   **border box** 解算的，于是 overlay 实际从 y=0 起画，header 就压在状态栏 / 灵动岛下面。
 *
 * 修法：在 header 这一层再包一个原生 SafeAreaView。
 *   UIKit 的 `safeAreaInsets` 是**相对**语义 —— 若祖先已经把安全区吃掉了，
 *   子视图读到的 inset 就是 0，所以嵌套是幂等的，不会出现双重内缩。
 *   同理，header 贴在顶部、和底部 Home Indicator 不相交，底部 inset 天然为 0。
 *
 * Android：RN 的 SafeAreaView 是纯 no-op View，而根节点用的是真正的 Yoga paddingTop
 *   （绝对定位子节点会继承），所以这里保持普通 View，不重复补状态栏高度。
 */
export function SafeAreaHeader({ style, children }: Props) {
  if (Platform.OS === 'ios') {
    return <SafeAreaView style={style}>{children}</SafeAreaView>;
  }
  return <View style={style}>{children}</View>;
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
});

export default SafeAreaRoot;
