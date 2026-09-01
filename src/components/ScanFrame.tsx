import React from 'react';
import { View, Text, useWindowDimensions, StyleSheet } from 'react-native';
import { useTheme } from '../theme/ThemeProvider';

interface Props {
  variant: 'sheet' | 'label';
  title: string;
  subtitle?: string;
}

// 相机取景识别框：暗角遮罩 + 暖橘描边 + 四角角标 + 提示文字。
// sheet = 送货单宽幅；label = 商品标签方形。pointerEvents 关闭，不挡底部快门。
export default function ScanFrame({ variant, title, subtitle }: Props) {
  const { theme } = useTheme();
  const { width: W, height: H } = useWindowDimensions();
  const accent = theme.color.primaryVivid;

  let top: number, left: number, right: number, bottom: number;
  if (variant === 'label') {
    const side = Math.min(W - 108, Math.round(H * 0.32));
    const edge = Math.round((W - side) / 2);
    left = right = edge;
    const vEdge = Math.round((H - side) / 2 - 8);
    top = bottom = vEdge;
  } else {
    left = 24;
    right = 24;
    top = Math.round(H * 0.2);
    bottom = Math.round(H * 0.4);
  }

  const mask = { position: 'absolute' as const, backgroundColor: 'rgba(0,0,0,0.5)' };

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

      <Text style={[styles.hintTop, { top: Math.max(top - 42, 16) }]}>{title}</Text>
      {subtitle ? (
        <Text style={[styles.hintBottom, { top: H - bottom + 14 }]}>{subtitle}</Text>
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
  hintTop: { position: 'absolute', left: 0, right: 0, textAlign: 'center', color: '#fff', fontSize: 14, fontWeight: '500', zIndex: 12 },
  hintBottom: { position: 'absolute', left: 16, right: 16, textAlign: 'center', color: 'rgba(255,255,255,0.7)', fontSize: 12, zIndex: 12 },
});
