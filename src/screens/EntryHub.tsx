import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Alert } from 'react-native';
import { theme } from '../theme';
import {
  getAllDrafts,
  deleteDraft,
  getAllRevenueDrafts,
  deleteRevenueDraft,
  type Draft,
  type RevenueDraft,
} from '../db/localDb';
import { resolveSyncPhase } from '../components/SyncUI';
import type { SyncState, TabKey } from '../nav';

interface Props {
  sync: SyncState;
  onNavigate: (tab: TabKey) => void;
  onNewPurchase: () => void;
  onNewRevenue: () => void;
  onEditDraft: (id: string) => void;
  onSyncAll: () => void;
  onRefreshPending: () => void;
}

export default function EntryHub({ sync, onNavigate, onNewPurchase, onNewRevenue, onEditDraft, onSyncAll, onRefreshPending }: Props) {
  const [drafts, setDrafts] = useState<Draft[]>(() => getAllDrafts());
  // 营收草稿：离线记的营收也躺在本机等推送，草稿箱必须能看到、能删、能手动重试，
  // 否则它就成了一笔「只有同步引擎知道、用户看不见」的账。
  const [revDrafts, setRevDrafts] = useState<RevenueDraft[]>(() => getAllRevenueDrafts());
  const phase = resolveSyncPhase(sync);

  // 「同步全部」按未同步总数（pending + syncing + conflict）来算，而不是只数 'pending'。
  // 只数 pending 时，草稿一旦卡在 'syncing'，按钮就直接消失，用户连手动重试的入口都没有。
  const unsynced =
    drafts.filter((d) => d.status !== 'synced').length +
    revDrafts.filter((d) => d.status !== 'synced').length;

  // 同步跑完（syncing 由 true→false）或计数变化时重新读库。
  // 之前 drafts 只在挂载时取一次，同步成功把草稿删了这里也不刷新，
  // 于是「同步中」的字样会一直挂着不动 —— 库里其实已经没这条了。
  useEffect(() => {
    setDrafts(getAllDrafts());
    setRevDrafts(getAllRevenueDrafts());
  }, [sync.pendingCount, sync.syncing]);

  const refresh = () => {
    setDrafts(getAllDrafts());
    setRevDrafts(getAllRevenueDrafts());
    onRefreshPending();
  };

  const handleDelete = (d: Draft) => {
    Alert.alert('删除草稿', `确认删除 ${d.orderNo}？`, [
      { text: '取消', style: 'cancel' },
      {
        text: '删除',
        style: 'destructive',
        onPress: () => {
          deleteDraft(d.id);
          refresh();
        },
      },
    ]);
  };

  const handleDeleteRevenue = (d: RevenueDraft) => {
    Alert.alert('删除营收草稿', `确认删除 ${d.date} 的 ¥${d.total.toFixed(2)}？`, [
      { text: '取消', style: 'cancel' },
      {
        text: '删除',
        style: 'destructive',
        onPress: () => {
          deleteRevenueDraft(d.id);
          refresh();
        },
      },
    ]);
  };

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <Text style={styles.title}>录单</Text>
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        {/* 同步状态条 ma-syncbar 四态 */}
        <TouchableOpacity style={styles.syncBar} onPress={() => onNavigate('settings')}>
          <View style={[styles.syncDot, { backgroundColor: syncPhaseColor(phase) }]} />
          <Text style={styles.syncText}>{syncPhaseText(phase, sync.pendingCount)}</Text>
          <Text style={styles.syncArrow}>›</Text>
        </TouchableOpacity>

        {/* 主橙实心按钮（R2 配额 1/1） */}
        <TouchableOpacity style={styles.primaryBtn} onPress={onNewPurchase}>
          <Text style={styles.primaryBtnText}>＋ 新建进货单</Text>
        </TouchableOpacity>

        {/* 次要 chip：记一笔营收（不占 R2） */}
        <TouchableOpacity style={styles.chip} onPress={onNewRevenue}>
          <Text style={styles.chipText}>记一笔营收</Text>
        </TouchableOpacity>

        {/* 草稿箱 */}
        <View style={styles.card}>
          <View style={styles.cardHead}>
            <Text style={styles.cardTitle}>草稿箱</Text>
            {unsynced > 0 && (
              <TouchableOpacity style={styles.syncAll} onPress={onSyncAll} disabled={sync.syncing}>
                <Text style={styles.syncAllText}>
                  {sync.syncing ? '同步中…' : `同步全部（${unsynced}）`}
                </Text>
              </TouchableOpacity>
            )}
          </View>

          {drafts.length === 0 && revDrafts.length === 0 ? (
            <Text style={styles.empty}>暂无草稿</Text>
          ) : (
            <>
            {drafts.map((d) => {
              // 必须容错解析：这是**渲染期**同步执行的，某条历史草稿的 images 是坏 JSON
              // 就会在 render 里抛出，全 App 没有 ErrorBoundary → 整棵树卸载 → 白屏，
              // 而且是「一进录单页就白屏」，等于把录入端彻底锁死。
              const imgs = safeCount(d.images);
              return (
                <View key={d.id} style={styles.item}>
                  <TouchableOpacity style={{ flex: 1 }} onPress={() => onEditDraft(d.id)}>
                    <Text style={styles.itemNo}>{d.orderNo}</Text>
                    <Text style={styles.itemSub}>
                      {d.supplierName || '未填供应商'} · ¥{d.totalAmount.toFixed(2)}
                    </Text>
                    <Text style={styles.itemSub}>
                      照片 {imgs} 张 · {draftStatusText(d.status)}
                    </Text>
                  </TouchableOpacity>
                  <View style={styles.itemActions}>
                    <View style={[styles.tag, { backgroundColor: draftStatusColor(d.status) }]} />
                    <TouchableOpacity style={styles.delBtn} onPress={() => handleDelete(d)} hitSlop={12}>
                      <Text style={styles.delText}>×</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              );
            })}
            {revDrafts.map((d) => (
              <View key={d.id} style={styles.item}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.itemNo}>营收 {d.date}</Text>
                  <Text style={styles.itemSub}>¥{d.total.toFixed(2)}{d.note ? ` · ${d.note}` : ''}</Text>
                  <Text style={styles.itemSub}>{draftStatusText(d.status)}</Text>
                </View>
                <View style={styles.itemActions}>
                  <View style={[styles.tag, { backgroundColor: draftStatusColor(d.status) }]} />
                  <TouchableOpacity style={styles.delBtn} onPress={() => handleDeleteRevenue(d)} hitSlop={12}>
                    <Text style={styles.delText}>×</Text>
                  </TouchableOpacity>
                </View>
              </View>
            ))}
            </>
          )}
        </View>
      </ScrollView>
    </View>
  );
}

/** 坏 JSON 一律按 0 张处理 —— 列表宁可少显示一个数字，也不能整页崩掉 */
function safeCount(s: string | null | undefined): number {
  try {
    const v = JSON.parse(s || '[]');
    return Array.isArray(v) ? v.length : 0;
  } catch {
    return 0;
  }
}

/** 草稿状态四重编码：文字 + 颜色（与 theme.color.status* 对齐） */
function draftStatusText(s: Draft['status']) {
  if (s === 'syncing') return '同步中';
  if (s === 'conflict') return '冲突 · 待重试';
  if (s === 'synced') return '已同步';
  return '待同步';
}
function draftStatusColor(s: Draft['status']) {
  if (s === 'syncing') return theme.color.statusSyncing;
  if (s === 'conflict') return theme.color.statusConflict;
  if (s === 'synced') return theme.color.statusSynced;
  return theme.color.statusPending;
}

function syncPhaseColor(p: string) {
  if (p === 'syncing') return theme.color.info;
  if (p === 'offline') return theme.color.textAppTertiary;
  if (p === 'pending') return theme.color.statusPending;
  return theme.color.success;
}
function syncPhaseText(p: string, n: number) {
  if (p === 'syncing') return '自动同步中…';
  if (p === 'offline') return '离线 · 可录入';
  if (p === 'pending') return `待同步 ${n} 笔 · 连 WiFi 自动同步`;
  return '已同步 · 本地已清理';
}

const S = theme.size;
const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.color.bgApp },
  header: { paddingHorizontal: theme.spaceScale[4], paddingTop: theme.spaceScale[4], paddingBottom: theme.spaceScale[2] },
  title: { fontSize: theme.font.sizeV4.h2, fontWeight: theme.font.weight.bold, color: theme.color.textApp },
  content: { padding: theme.spaceScale[4], paddingBottom: 32 },
  syncBar: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: theme.color.surfaceApp, borderWidth: 1, borderColor: theme.color.borderApp,
    borderRadius: theme.radius.lg, paddingVertical: theme.spaceScale[3], paddingHorizontal: theme.spaceScale[4],
    marginBottom: theme.spaceScale[4],
  },
  syncDot: { width: 8, height: 8, borderRadius: 4, marginRight: theme.spaceScale[2] },
  syncText: { flex: 1, fontSize: theme.font.sizeV4.body, color: theme.color.textApp },
  syncArrow: { color: theme.color.textAppTertiary, fontSize: 20 },
  primaryBtn: {
    backgroundColor: theme.color.primary, borderRadius: theme.radius.lg,
    height: S.controlLg, alignItems: 'center', justifyContent: 'center',
    marginBottom: theme.spaceScale[3],
  },
  primaryBtnText: { color: theme.color.ctaText, fontSize: theme.font.sizeV4.bodyLg, fontWeight: theme.font.weight.semibold },
  chip: {
    backgroundColor: theme.color.surfaceRaised, borderWidth: 1, borderColor: theme.color.borderApp,
    borderRadius: theme.radius.pill, minHeight: S.controlLg, alignItems: 'center', justifyContent: 'center',
    marginBottom: theme.spaceScale[4],
  },
  chipText: { color: theme.color.textApp, fontSize: theme.font.sizeV4.body, fontWeight: theme.font.weight.medium },
  card: { backgroundColor: theme.color.surfaceApp, borderRadius: theme.radius.lg, padding: theme.spaceScale[4] },
  cardHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: theme.spaceScale[3] },
  cardTitle: { fontSize: theme.font.sizeV4.h4, fontWeight: theme.font.weight.semibold, color: theme.color.textApp },
  syncAll: { backgroundColor: theme.color.surfaceRaised, borderWidth: 1, borderColor: theme.color.primaryVivid, borderRadius: theme.radius.pill, paddingVertical: 6, paddingHorizontal: 12 },
  syncAllText: { color: theme.color.primaryVivid, fontSize: theme.font.sizeV4.caption, fontWeight: theme.font.weight.medium },
  empty: { color: theme.color.textAppTertiary, textAlign: 'center', paddingVertical: theme.spaceScale[4] },
  item: {
    flexDirection: 'row', alignItems: 'center', minHeight: S.listRowMinH,
    borderBottomWidth: 1, borderBottomColor: theme.color.dividerApp,
  },
  itemNo: { fontSize: theme.font.sizeV4.bodyLg, fontWeight: theme.font.weight.medium, color: theme.color.textApp },
  itemSub: { fontSize: theme.font.sizeV4.caption, color: theme.color.textAppTertiary, marginTop: 2 },
  itemActions: { flexDirection: 'row', alignItems: 'center', gap: theme.spaceScale[3] },
  tag: { width: 10, height: 10, borderRadius: 5 },
  delBtn: { width: S.tapMin, height: S.tapMin, alignItems: 'center', justifyContent: 'center' },
  delText: { color: theme.color.textAppTertiary, fontSize: 24, fontWeight: theme.font.weight.bold },
});
