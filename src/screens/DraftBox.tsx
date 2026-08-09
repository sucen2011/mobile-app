import { useState, useEffect } from 'react';
import { StyleSheet, View, Text, TouchableOpacity, ScrollView } from 'react-native';
import { theme } from '../theme';
import { getAllDrafts, type Draft } from '../db/localDb';

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

export default function DraftBox({ onBack, onSyncAll }: { onBack: () => void; onSyncAll: () => void }) {
  const [drafts, setDrafts] = useState<Draft[]>([]);
  useEffect(() => {
    setDrafts(getAllDrafts());
  }, []);

  // 同 EntryHub：按未同步总数而不是只数 'pending'。
  // 原来卡在 'syncing' 的草稿会让 pending===0，底部按钮变灰显示「无待同步」，
  // 用户明明看着一条「同步中」却点不动 —— 死锁就出在这。
  const unsynced = drafts.filter((d) => d.status !== 'synced').length;

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <TouchableOpacity style={styles.headerBtn} onPress={onBack} hitSlop={12} accessibilityRole="button">
          <Text style={styles.back}>‹ 返回</Text>
        </TouchableOpacity>
        <Text style={styles.title}>草稿箱</Text>
        <View style={{ width: 48 }} />
      </View>

      <ScrollView contentContainerStyle={styles.pad}>
        {drafts.length === 0 && <Text style={styles.empty}>暂无草稿</Text>}
        {drafts.map((d) => {
          const imgs = JSON.parse(d.images || '[]') as string[];
          return (
            <View key={d.id} style={styles.item}>
              <View style={{ flex: 1 }}>
                <Text style={styles.itemNo}>{d.orderNo}</Text>
                <Text style={styles.itemSub}>{d.supplierName || '未填供应商'} · ¥{d.totalAmount}</Text>
                <Text style={styles.itemSub}>
                  照片 {imgs.length} 张 · {draftStatusText(d.status)}
                </Text>
              </View>
              <View style={[styles.tag, { backgroundColor: draftStatusColor(d.status) }]} />
            </View>
          );
        })}
      </ScrollView>

      <View style={styles.footer}>
        <TouchableOpacity style={[styles.btnPrimary, unsynced === 0 && styles.btnDisabled]} onPress={onSyncAll} disabled={unsynced === 0}>
          <Text style={styles.btnPrimaryText}>{unsynced > 0 ? `同步全部（${unsynced}）` : '无待同步'}</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.color.bg },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: theme.space(2), paddingVertical: theme.space(1),
    minHeight: theme.size.tapMin + theme.space(1),
    borderBottomWidth: 1, borderBottomColor: theme.color.border,
  },
  headerBtn: { minHeight: theme.size.tapMin, justifyContent: 'center' },
  back: { color: theme.color.primaryVivid, fontSize: theme.font.size.md, width: 48 },
  title: { fontSize: theme.font.size.lg, fontWeight: theme.font.weight.bold, color: theme.color.text },
  pad: { padding: theme.space(2) },
  empty: { color: theme.color.textMuted, textAlign: 'center', marginTop: theme.space(6) },
  item: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: theme.color.surface,
    borderRadius: theme.radius.md, padding: theme.space(1.5), marginBottom: theme.space(1),
    borderWidth: 1, borderColor: theme.color.border,
  },
  itemNo: { fontSize: theme.font.size.md, fontWeight: theme.font.weight.medium, color: theme.color.text },
  itemSub: { fontSize: theme.font.size.xs, color: theme.color.textMuted, marginTop: 2 },
  tag: { width: 10, height: 10, borderRadius: 5, marginLeft: theme.space(1) },
  footer: { padding: theme.space(2), borderTopWidth: 1, borderTopColor: theme.color.border },
  btnPrimary: { backgroundColor: theme.color.primary, borderRadius: theme.radius.md, paddingVertical: theme.space(1.75), alignItems: 'center' },
  btnDisabled: { opacity: 0.5 },
  btnPrimaryText: { color: '#fff', fontSize: theme.font.size.lg, fontWeight: theme.font.weight.medium },
});
