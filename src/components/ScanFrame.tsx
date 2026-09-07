import React from 'react';
import { View, Text, useWindowDimensions, StyleSheet } from 'react-native';
import { useTheme } from '../theme/ThemeProvider';
import { BOTTOM_INSET, TOP_INSET } from './SafeArea';

interface Props {
  variant: 'sheet' | 'label';
  title: string;
  subtitle?: string;
  /** 顶部安全区（状态栏/标题占用）。不传则按屏幕尺寸自适应 */
  topInset?: number;
  /** 底部安全区（快门条/Home Indicator 占用）。不传则按屏幕尺寸自适应 */
  bottomInset?: number;
}

// 相机取景识别框：暗角遮罩 + 暖橘描边 + 四角角标 + 提示文字。
//
// 尺寸策略（自适应屏幕，不写死 px）：
//   1. 左右边距按屏宽比例算并夹在 [14, 32]，小屏也不会贴边、大屏也不会窄成一条；
//   2. 上下安全区 = 系统安全区（状态栏 / Home Indicator）+ 固定控件高度（标题行 / 快门条 / 副标题）；
//   3. 在剩余可用区内按目标宽高比 contain 铺满 —— 屏幕越大框越大，换机型自动适配。
//
// sheet = 送货单/方案表竖幅（9:16，与手机竖屏一致，能完整框住标题行避免 OCR 漏字）；
// label = 商品标签方形。
// pointerEvents 关闭，不挡底部快门。
export default function ScanFrame({ variant, title, subtitle, topInset, bottomInset }: Props) {
  const { theme } = useTheme();
  const { width: W, height: H } = useWindowDimensions();
  const accent = theme.color.primaryVivid;

  // 1) 左右边距：屏宽的 4%，夹在 14~32
  const marginX = Math.min(Math.max(Math.round(W * 0.04), 14), 32);

  // 2) 上下安全区：系统安全区 + 控件高度
  //    顶部：状态栏 + 标题行（随屏高自适应收窄，小屏不吃掉太多可用高度）
  //    底部：Home Indicator + 快门条(≈68) + 副标题行(≈16+间距)
  //          —— 底部固定 96，不能随屏高缩小：缩了副标题就会压到快门条上（小屏/横屏实测会重叠）
  const ctrlTop = Math.round(Math.min(56, H * 0.08));
  const topSafe = topInset ?? TOP_INSET + ctrlTop;
  const bottomSafe = bottomInset ?? BOTTOM_INSET + 96;

  const availW = W - marginX * 2;
  const availH = Math.max(H - topSafe - bottomSafe, 120); // 兜底，避免极端小屏算出负数

  // 3) contain 铺满：先按可用宽度算，超高则按可用高度反推
  const ratio = variant === 'sheet' ? 9 / 16 : 1; // w / h
  const usableW = variant === 'label' ? availW * 0.9 : availW; // 标签方框四周多留点余量
  let frameW = usableW;
  let frameH = Math.round(frameW / ratio);
  if (frameH > availH) {
    frameH = availH;
    frameW = Math.round(frameH * ratio);
  }
  frameW = Math.max(frameW, 120);
  frameH = Math.max(frameH, 120);

  const left = Math.round((W - frameW) / 2);
  const right = left;
  // 垂直方向在「可用区」内居中（不是整屏居中），这样底部刚好给快门条让位
  const top = topSafe + Math.round((availH - frameH) / 2);
  const bottom = H - top - frameH;

  const mask = { position: 'absolute' as const, backgroundColor: 'rgba(0,0,0,0.5)' };

  // 提示文字位置：顶部不被状态栏压、底部不压住快门条
  const hintTopPos = Math.max(top - 42, TOP_INSET + 8);
  // 副标题落在底部安全区顶部，天然避开下方快门条
  const hintBottomPos = Math.min(top + frameH + 12, H - bottomSafe + 8);

  return (
    <View style={styles.wrap} pointerEvents="none">
      <View style={[mask, { top: 0, left: 0, right: 0, height: top }]} />
      <View style={[mask, { bottom: 0, left: 0, right: 0, height: bottom }]} />
      <View style={[mask, { top, bottom, left: 0, width: left }]} />
      <View style={[mask, { top, bottom, right: 0, width: right }]} />

      <View style={[styles.frame, { top, left, right, bottom, borderColor: accent }]}>
        <View style={[styles.c1, { borderTopColor: accent, borderLeftColor: accent }]} />
        <View style={[styles.c2, { borderTopColor: accent, borderRightColor: accent }]} />
        <View style={[styles.c3, { borderBottomColor: accent, borderLeftColor: accent }]} />
        <View style={[styles.c4, { borderBottomColor: accent, borderRightColor: accent }]} />
      </View>

      <Text style={[styles.hintTop, { top: hintTopPos }]}>{title}</Text>
      {subtitle ? (
        <Text style={[styles.hintBottom, { top: hintBottomPos }]}>{subtitle}</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 10 },
  frame: { position: 'absolute', borderWidth: 2, borderRadius: 14, zIndex: 11 },
  c1: { position: 'absolute', top: -2, left: -2, width: 24, height: 24, borderTopWidth: 4, borderLeftWidth: 4, borderTopLeftRadius: 8 },
  c2: { position: 'absolute', top: -2, right: -2, width: 24, height: 24, borderTopWidth: 4, borderRightWidth: 4, borderTopRightRadius: 8 },
  c3: { position: 'absolute', bottom: -2, left: -2, width: 24, height: 24, borderBottomWidth: 4, borderLeftWidth: 4, borderBottomLeftRadius: 8 },
  c4: { position: 'absolute', bottom: -2, right: -2, width: 24, height: 24, borderBottomWidth: 4, borderRightWidth: 4, borderBottomRightRadius: 8 },
  hintTop: { position: 'absolute', left: 16, right: 16, textAlign: 'center', color: '#fff', fontSize: 14, fontWeight: '500', zIndex: 12 },
  hintBottom: { position: 'absolute', left: 16, right: 16, textAlign: 'center', color: 'rgba(255,255,255,0.7)', fontSize: 12, zIndex: 12 },
});
