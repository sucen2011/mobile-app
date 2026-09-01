import React, { useMemo } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity } from 'react-native';
import { useTheme } from '../theme/ThemeProvider';
import { SyncBadge } from '../components/SyncUI';
import { MiniTrend } from '../components/Charts';
import { getCachedPurchases, getCachedRevenues, getDayOffset } from '../db/localDb';
import { formatDayLabel, applyDayOffset, toLocalDateStr } from '../utils/dateLabel';
import type { SyncState, TabKey } from '../nav';

interface Props {
  sync: SyncState;
  onNavigate: (tab: TabKey) => void;
  onOpenDetail: (rec: { kind: 'revenue' | 'purchase'; id: string }) => void;
}

function todayStr() {
  return toLocalDateStr(new Date());
}
function monthPrefix() {
  return todayStr().slice(0, 7);
}

export default function OverviewScreen({ sync, onNavigate, onOpenDetail }: Props) {
  const { theme } = useTheme();
  const styles = makeStyles(theme);
  const offset = getDayOffset();
  const data = useMemo(() => {
    const purchases = getCachedPurchases();
    const revenues = getCachedRevenues();
    const t = applyDayOffset(todayStr(), -offset); // 营业日口径：指标按真实昨天聚合
    const m = monthPrefix();

    const sumWhere = (list: any[], pick: (x: any) => number, pred: (x: any) => boolean) =>
      list.filter(pred).reduce((s, x) => s + pick(x), 0);

    const todayRev = sumWhere(revenues, (r) => r.total, (r) => r.date === t);
    const todayPur = sumWhere(purchases, (p) => p.totalAmount, (p) => p.date === t);
    const monthRev = sumWhere(revenues, (r) => r.total, (r) => r.date.startsWith(m));
    const monthPur = sumWhere(purchases, (p) => p.totalAmount, (p) => p.date.startsWith(m));
    const todayCount =
      revenues.filter((r) => r.date === t).length + purchases.filter((p) => p.date === t).length;

    // 近 7 日营收趋势
    const days: number[] = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const ds = toLocalDateStr(d);
      days.push(revenues.filter((r) => r.date === ds).reduce((s, r) => s + r.total, 0));
    }

    const recent = [
      ...revenues.slice(0, 3).map((r) => ({ kind: 'revenue' as const, id: r.id, date: r.date, amount: r.total, sub: r.note || '营业收款' })),
      ...purchases.slice(0, 3).map((p) => ({ kind: 'purchase' as const, id: p.id, date: p.date, amount: p.totalAmount, sub: p.supplierName || '进货' })),
    ]
      .sort((a, b) => (a.date < b.date ? 1 : -1))
      .slice(0, 4);

    return { todayRev, todayPur, monthRev, monthPur, todayCount, trend: days, recent };
  }, []);

  const empty = data.recent.length === 0 && sync.pendingCount === 0;

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.content}>
      <View style={styles.topRow}>
        <Text style={styles.greet}>概览</Text>
        <SyncBadge state={sync} />
      </View>

      {/* Hero 昨日营业额 */}
      <View style={styles.hero}>
        <Text style={styles.heroLabel}>昨日营业额</Text>
        <Text style={[styles.heroValue, { color: theme.color.income }]}>
          ¥{data.todayRev.toFixed(2)}
        </Text>
        <Text style={styles.heroSub}>
          本月累计 <Text style={{ color: theme.color.textApp }}>¥{data.monthRev.toFixed(2)}</Text>
        </Text>
      </View>

      {/* mini-kpi ×3 */}
      <View style={styles.kpiRow}>
        <Kpi label="昨日笔数" value={String(data.todayCount)} color={theme.color.textApp} />
        <Kpi label="待同步草稿" value={String(sync.pendingCount)} color={theme.color.textApp} />
        <Kpi label="本月进货额" value={`¥${data.monthPur.toFixed(0)}`} color={theme.color.expense} />
      </View>

      {/* 趋势短图（禁橙） */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>近 7 日营收</Text>
        <MiniTrend values={data.trend} color={theme.color.chartRevenue} />
      </View>

      {/* 最近记录 */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>最近记录</Text>
        {data.recent.length === 0 && !empty ? (
          <Text style={styles.emptyInline}>暂无记录</Text>
        ) : (
          data.recent.map((r) => (
            <TouchableOpacity
              key={r.kind + r.id}
              style={styles.recRow}
              onPress={() => onOpenDetail({ kind: r.kind, id: r.id })}
            >
              <View
                style={[
                  styles.recIcon,
                  { backgroundColor: r.kind === 'revenue' ? theme.color.income : theme.color.expense },
                ]}
              >
                <Text style={styles.recIconText}>{r.kind === 'revenue' ? '收' : '进'}</Text>
              </View>
              <View style={styles.recMain}>
                <Text style={styles.recSub} numberOfLines={1}>
                  {r.sub}
                </Text>
                <Text style={styles.recDate}>{formatDayLabel(r.date, 0)}</Text>
              </View>
              <Text
                style={[
                  styles.recAmount,
                  { color: r.kind === 'revenue' ? theme.color.income : theme.color.expense },
                ]}
              >
                {r.kind === 'revenue' ? '+' : '-'}¥{r.amount.toFixed(2)}
              </Text>
            </TouchableOpacity>
          ))
        )}
      </View>

      {empty && (
        <View style={styles.emptyState}>
          <Text style={styles.emptyTitle}>还没有记录</Text>
          <Text style={styles.emptyText}>去录一笔进货单吧</Text>
          <TouchableOpacity style={styles.emptyCta} onPress={() => onNavigate('business')}>
            <Text style={[styles.emptyCtaText, { color: theme.color.primaryVivid }]}>前往录单 →</Text>
          </TouchableOpacity>
        </View>
      )}
    </ScrollView>
  );
}

function Kpi({ label, value, color }: { label: string; value: string; color: string }) {
  const { theme } = useTheme();
  const styles = makeStyles(theme);
  return (
    <View style={styles.kpi}>
      <Text style={styles.kpiLabel}>{label}</Text>
      <Text style={[styles.kpiValue, { color, fontFamily: theme.font.family.num }]}>{value}</Text>
    </View>
  );
}

function makeStyles(theme: any) {
  const S = theme.size;
  return StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.color.bgApp },
  content: { padding: theme.spaceScale[4], paddingBottom: 32 },
  topRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: theme.spaceScale[4] },
  greet: { fontSize: theme.font.sizeV4.h2, fontWeight: theme.font.weight.bold, color: theme.color.textApp },
  hero: {
    backgroundColor: theme.color.surfaceApp,
    borderRadius: theme.radius.lg,
    padding: theme.spaceScale[5],
    marginBottom: theme.spaceScale[4],
  },
  heroLabel: { fontSize: theme.font.sizeV4.caption, color: theme.color.textAppTertiary },
  heroValue: { fontSize: theme.font.sizeV4.metricXl, fontWeight: theme.font.weight.semibold, fontFamily: theme.font.family.num, marginTop: 4 },
  heroSub: { fontSize: theme.font.sizeV4.bodySm, color: theme.color.textAppSecondary, marginTop: 6 },
  kpiRow: { flexDirection: 'row', gap: theme.spaceScale[3] },
  kpi: {
    flex: 1,
    backgroundColor: theme.color.surfaceApp,
    borderRadius: theme.radius.lg,
    padding: theme.spaceScale[4],
  },
  kpiLabel: { fontSize: theme.font.sizeV4.caption, color: theme.color.textAppTertiary },
  kpiValue: { fontSize: theme.font.sizeV4.metric, fontWeight: theme.font.weight.semibold, marginTop: 4 },
  card: {
    backgroundColor: theme.color.surfaceApp,
    borderRadius: theme.radius.lg,
    padding: theme.spaceScale[4],
    marginTop: theme.spaceScale[4],
  },
  cardTitle: { fontSize: theme.font.sizeV4.h4, fontWeight: theme.font.weight.semibold, color: theme.color.textApp, marginBottom: theme.spaceScale[3] },
  recRow: { flexDirection: 'row', alignItems: 'center', minHeight: S.listRowMinH, borderBottomWidth: 1, borderBottomColor: theme.color.dividerApp },
  recIcon: { width: 32, height: 32, borderRadius: theme.radius.md, alignItems: 'center', justifyContent: 'center', marginRight: theme.spaceScale[3] },
  recIconText: { color: '#fff', fontSize: theme.font.sizeV4.caption, fontWeight: theme.font.weight.semibold },
  recMain: { flex: 1 },
  recSub: { fontSize: theme.font.sizeV4.bodyLg, color: theme.color.textApp },
  recDate: { fontSize: theme.font.sizeV4.caption, color: theme.color.textAppTertiary, marginTop: 2 },
  recAmount: { fontSize: theme.font.sizeV4.amount, fontWeight: theme.font.weight.semibold, fontFamily: theme.font.family.num },
  emptyInline: { fontSize: theme.font.sizeV4.bodySm, color: theme.color.textAppTertiary, paddingVertical: theme.spaceScale[3] },
  emptyState: { alignItems: 'center', paddingVertical: theme.spaceScale[8] },
  emptyTitle: { fontSize: theme.font.sizeV4.h3, color: theme.color.textApp, fontWeight: theme.font.weight.semibold },
  emptyText: { fontSize: theme.font.sizeV4.body, color: theme.color.textAppSecondary, marginTop: 6 },
  emptyCta: { marginTop: theme.spaceScale[4], paddingVertical: theme.spaceScale[2] },
  emptyCtaText: { fontSize: theme.font.sizeV4.body, fontWeight: theme.font.weight.medium },
});
}
