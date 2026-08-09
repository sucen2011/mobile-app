import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { theme } from '../theme';

// 轻量图表：纯 RN View 绘制，不引第三方；一律走非橙 chart 系列（R5），零阴影（R3）

interface BarItem {
  label: string;
  revenue?: number; // 营收（青绿）
  purchase?: number; // 进货（黄铜）
}

/** 报表柱状图：营收 vs 进货，按天（堆叠按「营收+进货」合计归一，避免同日双高溢出图表高度） */
export function BarChart({ data, height = 160 }: { data: BarItem[]; height?: number }) {
  const maxCombined = Math.max(
    1,
    ...data.map((d) => (d.revenue || 0) + (d.purchase || 0))
  );
  const avail = height - 28; // 预留标签高度
  return (
    <View style={[styles.barWrap, { height }]}>
      {data.map((d, i) => {
        const rH = Math.round(((d.revenue || 0) / maxCombined) * avail);
        const pH = Math.round(((d.purchase || 0) / maxCombined) * avail);
        return (
          <View key={i} style={styles.barCol}>
            <View style={styles.barStack}>
              <View style={[styles.bar, { height: rH, backgroundColor: theme.color.chartRevenue }]} />
              <View style={[styles.bar, { height: pH, backgroundColor: theme.color.chartPurchase, marginTop: 3 }]} />
            </View>
            <Text style={styles.barLabel} numberOfLines={1}>
              {d.label}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

/** 概览迷你趋势：单系列短柱（营收） */
export function MiniTrend({ values, color }: { values: number[]; color: string }) {
  const max = Math.max(1, ...values);
  return (
    <View style={styles.miniWrap}>
      {values.map((v, i) => (
        <View key={i} style={styles.miniCol}>
          <View
            style={[
              styles.miniBar,
              { height: Math.max(3, Math.round((v / max) * 40)), backgroundColor: color },
            ]}
          />
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  barWrap: { flexDirection: 'row', alignItems: 'flex-end', paddingTop: 8 },
  barCol: { flex: 1, alignItems: 'center', justifyContent: 'flex-end' },
  barStack: { alignItems: 'center', justifyContent: 'flex-end' },
  bar: { width: 10, borderRadius: 3 },
  barLabel: {
    marginTop: 6,
    fontSize: theme.font.sizeV4.caption,
    color: theme.color.textAppTertiary,
    fontFamily: theme.font.family.num,
  },
  miniWrap: { flexDirection: 'row', alignItems: 'flex-end', height: 44 },
  miniCol: { flex: 1, alignItems: 'center', justifyContent: 'flex-end' },
  miniBar: { width: 6, borderRadius: 2 },
});
