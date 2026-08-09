import React, { useMemo, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TextInput, TouchableOpacity } from 'react-native';
import { theme } from '../theme';
import {
  getCachedPurchases,
  getCachedRevenues,
  getDayOffset,
  getAllDrafts,
  getAllRevenueDrafts,
} from '../db/localDb';
import { formatDayLabel } from '../utils/dateLabel';
import type { SyncState } from '../nav';

type RecordKind = 'revenue' | 'purchase' | 'draft' | 'revenueDraft';

interface Props {
  sync: SyncState;
  onOpenDetail: (rec: { kind: RecordKind; id: string }) => void;
}

type Filter = 'all' | 'purchase' | 'revenue';

type RowStatus = 'pending' | 'syncing' | 'conflict' | 'synced';

interface Row {
  kind: RecordKind;
  id: string;
  date: string;
  title: string;
  sub: string;
  amount: number;
  amountColor: string;
  status: RowStatus;
}

const ROW_STATUS_TEXT: Record<RowStatus, string> = {
  pending: '待同步',
  syncing: '同步中',
  conflict: '冲突',
  synced: '已同步',
};

const ROW_STATUS_COLOR: Record<RowStatus, string> = {
  pending: theme.color.statusPending,
  syncing: theme.color.statusSyncing,
  conflict: theme.color.statusConflict,
  synced: theme.color.statusSynced,
};

export default function RecordsScreen({ sync, onOpenDetail }: Props) {
  const offset = getDayOffset();
  const [filter, setFilter] = useState<Filter>('all');
  const [keyword, setKeyword] = useState('');

  const rows = useMemo<Row[]>(() => {
    const list: Row[] = [];
    for (const r of getCachedRevenues()) {
      list.push({ kind: 'revenue', id: r.id, date: r.date, title: '营业收款', sub: r.note || '营收', amount: r.total, amountColor: theme.color.income, status: 'synced' });
    }
    for (const p of getCachedPurchases()) {
      list.push({ kind: 'purchase', id: p.id, date: p.date, title: p.supplierName || '进货', sub: `进货单 ${p.orderNo}`, amount: p.totalAmount, amountColor: theme.color.expense, status: 'synced' });
    }
    for (const d of getAllDrafts()) {
      // 用草稿的真实状态，不要再写死 'pending'。
      // 写死会让「明细」永远显示待同步，而概览的计数走的是另一套口径，两边就对不上了。
      list.push({ kind: 'draft', id: d.id, date: d.date, title: d.supplierName || '进货草稿', sub: `草稿 ${d.orderNo}`, amount: d.totalAmount, amountColor: theme.color.expense, status: d.status });
    }
    // 离线记的营收：服务端还没有这条，只能从本机草稿表出。
    // 不列出来的话，店主离线记完账在明细里一片空白，会以为没记上、然后重复再记一遍。
    for (const r of getAllRevenueDrafts()) {
      list.push({ kind: 'revenueDraft', id: r.id, date: r.date, title: '营业收款', sub: r.note || '营收草稿', amount: r.total, amountColor: theme.color.income, status: r.status });
    }
    list.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    return list;
  }, [sync.pendingCount, sync.syncing]);

  const filtered = rows.filter((r) => {
    const isRevenueKind = r.kind === 'revenue' || r.kind === 'revenueDraft';
    if (filter === 'purchase' && isRevenueKind) return false;
    // 顺带修正：原来只排除 'purchase'，进货草稿（'draft'）会漏进「营收」分段里
    if (filter === 'revenue' && !isRevenueKind) return false;
    if (keyword && !(`${r.title}${r.sub}`.includes(keyword))) return false;
    return true;
  });

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <Text style={styles.title}>明细</Text>
      </View>

      <View style={styles.searchWrap}>
        <TextInput
          style={styles.search}
          placeholder="搜索供应商 / 单号 / 备注"
          placeholderTextColor={theme.color.textAppTertiary}
          value={keyword}
          onChangeText={setKeyword}
        />
      </View>

      <View style={styles.seg}>
        {(['all', 'purchase', 'revenue'] as Filter[]).map((f) => (
          <TouchableOpacity
            key={f}
            style={[styles.segItem, filter === f && styles.segItemActive]}
            onPress={() => setFilter(f)}
          >
            <Text style={[styles.segText, filter === f && styles.segTextActive]}>
              {f === 'all' ? '全部' : f === 'purchase' ? '进货' : '营收'}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
        {filtered.length === 0 ? (
          <View style={styles.empty}>
            <Text style={styles.emptyText}>暂无记录</Text>
          </View>
        ) : (
          filtered.map((r) => {
            const isRevenueKind = r.kind === 'revenue' || r.kind === 'revenueDraft';
            return (
            <TouchableOpacity key={r.kind + r.id} style={styles.row} onPress={() => onOpenDetail(r)}>
              <View style={[styles.icon, { backgroundColor: isRevenueKind ? theme.color.income : theme.color.expense }]}>
                <Text style={styles.iconText}>{isRevenueKind ? '收' : '进'}</Text>
              </View>
              <View style={styles.main}>
                <Text style={styles.rowTitle} numberOfLines={1}>{r.title}</Text>
                <Text style={styles.rowSub} numberOfLines={1}>{r.sub}</Text>
              </View>
              <View style={styles.right}>
                <Text style={[styles.amount, { color: r.amountColor, fontFamily: theme.font.family.num }]}>
                  {isRevenueKind ? '+' : '-'}¥{r.amount.toFixed(2)}
                </Text>
                <View style={[styles.badge, { backgroundColor: ROW_STATUS_COLOR[r.status] }]}>
                  <Text style={styles.badgeText}>{ROW_STATUS_TEXT[r.status]}</Text>
                </View>
              </View>
            </TouchableOpacity>
            );
          })
        )}
      </ScrollView>
    </View>
  );
}

const S = theme.size;
const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.color.bgApp },
  header: { paddingHorizontal: theme.spaceScale[4], paddingTop: theme.spaceScale[4], paddingBottom: theme.spaceScale[2] },
  title: { fontSize: theme.font.sizeV4.h2, fontWeight: theme.font.weight.bold, color: theme.color.textApp },
  searchWrap: { paddingHorizontal: theme.spaceScale[4], marginBottom: theme.spaceScale[3] },
  search: {
    backgroundColor: theme.color.surfaceSunken,
    borderWidth: 1,
    borderColor: theme.color.borderApp,
    borderRadius: theme.radius.md,
    height: S.controlLg,
    paddingHorizontal: theme.spaceScale[4],
    color: theme.color.textApp,
    fontSize: theme.font.sizeV4.body,
    fontFamily: theme.font.family.num,
  },
  seg: {
    flexDirection: 'row',
    backgroundColor: theme.color.surfaceSunken,
    borderRadius: theme.radius.pill,
    height: S.segmentedH,
    padding: theme.spaceScale[1],
    marginHorizontal: theme.spaceScale[4],
    marginBottom: theme.spaceScale[3],
  },
  segItem: { flex: 1, alignItems: 'center', justifyContent: 'center', borderRadius: theme.radius.pill },
  segItemActive: { backgroundColor: theme.color.surfaceRaised },
  segText: { fontSize: theme.font.sizeV4.bodySm, color: theme.color.textAppTertiary },
  segTextActive: { color: theme.color.textApp, fontWeight: theme.font.weight.semibold },
  list: { flex: 1 },
  listContent: { paddingHorizontal: theme.spaceScale[4] },
  row: { flexDirection: 'row', alignItems: 'center', minHeight: S.listRowMinH, borderBottomWidth: 1, borderBottomColor: theme.color.dividerApp },
  icon: { width: 32, height: 32, borderRadius: theme.radius.md, alignItems: 'center', justifyContent: 'center', marginRight: theme.spaceScale[3] },
  iconText: { color: '#fff', fontSize: theme.font.sizeV4.caption, fontWeight: theme.font.weight.semibold },
  main: { flex: 1 },
  rowTitle: { fontSize: theme.font.sizeV4.bodyLg, color: theme.color.textApp },
  rowSub: { fontSize: theme.font.sizeV4.caption, color: theme.color.textAppTertiary, marginTop: 2 },
  right: { alignItems: 'flex-end' },
  amount: { fontSize: theme.font.sizeV4.amount, fontWeight: theme.font.weight.semibold },
  badge: { marginTop: 4, paddingHorizontal: 8, paddingVertical: 2, borderRadius: theme.radius.sm },
  badgeText: { fontSize: theme.font.sizeV4.micro, color: '#fff', fontWeight: theme.font.weight.medium },
  empty: { alignItems: 'center', paddingVertical: theme.spaceScale[10] },
  emptyText: { fontSize: theme.font.sizeV4.body, color: theme.color.textAppTertiary },
});
