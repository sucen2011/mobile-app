import React, { useMemo, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity } from 'react-native';
import { theme } from '../theme';
import { BarChart } from '../components/Charts';
import { SyncBadge } from '../components/SyncUI';
import { getCachedPurchases, getCachedRevenues, getLastSync, getDayOffset } from '../db/localDb';
import { formatDayLabel, applyDayOffset, toLocalDateStr } from '../utils/dateLabel';
import type { SyncState } from '../nav';

interface Props {
  sync: SyncState;
}

type Scope = 'today' | 'month';

function dayStr(offsetDays: number) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return toLocalDateStr(d);
}
function weekStart(offset: number) {
  const d = new Date();
  d.setDate(d.getDate() + offset - ((d.getDay() + 6) % 7)); // 周一为一周开始
  return toLocalDateStr(d);
}

export default function ReportScreen({ sync }: Props) {
  const [scope, setScope] = useState<Scope>('today');
  const offset = getDayOffset();

  const m = useMemo(() => {
    const rev = getCachedRevenues();
    const pur = getCachedPurchases();
    const t = applyDayOffset(dayStr(0), -offset); // 营业日口径：指标按真实昨天聚合
    const mp = t.slice(0, 7);

    const sumRev = (pred: (r: any) => boolean) => rev.filter(pred).reduce((s, r) => s + r.total, 0);
    const sumPur = (pred: (p: any) => boolean) => pur.filter(pred).reduce((s, p) => s + p.totalAmount, 0);
    const cntRev = (pred: (r: any) => boolean) => rev.filter(pred).length;
    const cntPur = (pred: (p: any) => boolean) => pur.filter(pred).length;

    const todayRev = sumRev((r) => r.date === t);
    const todayPur = sumPur((p) => p.date === t);
    const todayCount = cntRev((r) => r.date === t) + cntPur((p) => p.date === t);

    const monthRev = sumRev((r) => r.date.startsWith(mp));
    const monthPur = sumPur((p) => p.date.startsWith(mp));
    const monthCount = cntRev((r) => r.date.startsWith(mp)) + cntPur((p) => p.date.startsWith(mp));
    const monthRate = monthRev > 0 ? ((monthRev - monthPur) / monthRev) * 100 : 0;

    // 环比上周
    const ws = weekStart(0);
    const wsLast = weekStart(-7);
    const thisWeekRev = sumRev((r) => r.date >= ws);
    const lastWeekRev = sumRev((r) => r.date >= wsLast && r.date < ws);
    const wow = lastWeekRev > 0 ? ((thisWeekRev - lastWeekRev) / lastWeekRev) * 100 : 0;

    // 近 7 日柱状（营收 vs 进货）
    const bars: { label: string; revenue: number; purchase: number }[] = [];
    for (let i = 6; i >= 0; i--) {
      const ds = dayStr(-i);
      bars.push({
        label: formatDayLabel(ds, offset).replace('今日', '今').replace('昨日', '昨'),
        revenue: sumRev((r) => r.date === ds),
        purchase: sumPur((p) => p.date === ds),
      });
    }

    return { todayRev, todayPur, todayCount, monthRev, monthPur, monthCount, monthRate, wow, bars };
  }, []);

  const lastSync = getLastSync();
  const syncedMin = lastSync ? Math.max(0, Math.round((Date.now() - lastSync) / 60000)) : null;

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.content}>
      <View style={styles.topRow}>
        <Text style={styles.title}>报表</Text>
        <SyncBadge state={sync} />
      </View>

      <View style={styles.seg}>
        {(['today', 'month'] as Scope[]).map((s) => (
          <TouchableOpacity key={s} style={[styles.segItem, scope === s && styles.segItemActive]} onPress={() => setScope(s)}>
            <Text style={[styles.segText, scope === s && styles.segTextActive]}>{s === 'today' ? '昨日' : '本月'}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* 指标卡 */}
      <View style={styles.metrics}>
        <Metric label={scope === 'today' ? '昨日营业额' : '本月营业额'} value={`¥${scope === 'today' ? m.todayRev.toFixed(2) : m.monthRev.toFixed(2)}`} color={theme.color.income} />
        <Metric label={scope === 'today' ? '昨日进货额' : '本月进货额'} value={`¥${scope === 'today' ? m.todayPur.toFixed(2) : m.monthPur.toFixed(2)}`} color={theme.color.expense} />
        <Metric label="笔数" value={String(scope === 'today' ? m.todayCount : m.monthCount)} color={theme.color.textApp} />
        <Metric
          label="毛利率"
          value={`${
            scope === 'today'
              ? m.todayRev > 0
                ? ((m.todayRev - m.todayPur) / m.todayRev * 100).toFixed(1)
                : '—'
              : m.monthRate.toFixed(1)
          }%`}
          color={theme.color.positive}
        />
      </View>

      {/* 环比 */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>营收环比上周</Text>
        <Text style={[styles.wow, { color: m.wow >= 0 ? theme.color.positive : theme.color.negative }]}>
          {m.wow >= 0 ? '↑' : '↓'} {Math.abs(m.wow).toFixed(1)}%
        </Text>
      </View>

      {/* 柱状图（禁橙） */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>近 7 日 营收 / 进货</Text>
        <BarChart data={m.bars} />
        <View style={styles.legend}>
          <Legend color={theme.color.chartRevenue} text="营收" />
          <Legend color={theme.color.chartPurchase} text="进货" />
        </View>
      </View>

      <Text style={styles.syncNote}>
        {syncedMin === null ? '尚未同步快照' : `快照更新于 ${syncedMin} 分钟前`}
        {' · '}营业日口径：今日记为昨日
      </Text>
    </ScrollView>
  );
}

function Metric({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <View style={styles.metric}>
      <Text style={styles.metricLabel}>{label}</Text>
      <Text style={[styles.metricValue, { color, fontFamily: theme.font.family.num }]}>{value}</Text>
    </View>
  );
}
function Legend({ color, text }: { color: string; text: string }) {
  return (
    <View style={styles.legendItem}>
      <View style={[styles.legendDot, { backgroundColor: color }]} />
      <Text style={styles.legendText}>{text}</Text>
    </View>
  );
}

const S = theme.size;
const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.color.bgApp },
  content: { padding: theme.spaceScale[4], paddingBottom: 32 },
  topRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: theme.spaceScale[3] },
  title: { fontSize: theme.font.sizeV4.h2, fontWeight: theme.font.weight.bold, color: theme.color.textApp },
  seg: { flexDirection: 'row', backgroundColor: theme.color.surfaceSunken, borderRadius: theme.radius.pill, height: S.segmentedH, padding: theme.spaceScale[1], marginBottom: theme.spaceScale[4] },
  segItem: { flex: 1, alignItems: 'center', justifyContent: 'center', borderRadius: theme.radius.pill },
  segItemActive: { backgroundColor: theme.color.surfaceRaised },
  segText: { fontSize: theme.font.sizeV4.bodySm, color: theme.color.textAppTertiary },
  segTextActive: { color: theme.color.textApp, fontWeight: theme.font.weight.semibold },
  metrics: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.spaceScale[3] },
  metric: { width: '47%', backgroundColor: theme.color.surfaceApp, borderRadius: theme.radius.lg, padding: theme.spaceScale[4] },
  metricLabel: { fontSize: theme.font.sizeV4.caption, color: theme.color.textAppTertiary },
  metricValue: { fontSize: theme.font.sizeV4.metric, fontWeight: theme.font.weight.semibold, marginTop: 4 },
  card: { backgroundColor: theme.color.surfaceApp, borderRadius: theme.radius.lg, padding: theme.spaceScale[4], marginTop: theme.spaceScale[4] },
  cardTitle: { fontSize: theme.font.sizeV4.h4, fontWeight: theme.font.weight.semibold, color: theme.color.textApp, marginBottom: theme.spaceScale[3] },
  wow: { fontSize: theme.font.sizeV4.metricXl, fontWeight: theme.font.weight.semibold, fontFamily: theme.font.family.num },
  legend: { flexDirection: 'row', marginTop: theme.spaceScale[3] },
  legendItem: { flexDirection: 'row', alignItems: 'center', marginRight: theme.spaceScale[4] },
  legendDot: { width: 10, height: 10, borderRadius: 3, marginRight: 6 },
  legendText: { fontSize: theme.font.sizeV4.caption, color: theme.color.textAppSecondary },
  syncNote: { fontSize: theme.font.sizeV4.caption, color: theme.color.textAppTertiary, marginTop: theme.spaceScale[4], textAlign: 'center' },
});
