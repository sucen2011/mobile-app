import { StyleSheet, View, Text, TouchableOpacity } from 'react-native';
import { theme } from '../theme';

export default function OfflineHome({
  pendingCount,
  lanOn,
  syncing,
  syncMsg,
  onNavigate,
  onSync,
}: {
  pendingCount: number;
  lanOn: boolean;
  syncing: boolean;
  syncMsg: string;
  onNavigate: (s: 'home' | 'entry' | 'drafts' | 'settings' | 'details') => void;
  onSync: () => void;
}) {
  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <Text style={styles.title}>商超台账</Text>
        <View style={styles.lanWrap}>
          <View style={[styles.dot, { backgroundColor: lanOn ? theme.color.success : theme.color.textMuted }]} />
          <Text style={styles.lanText}>{lanOn ? '已连店铺WiFi' : '离线'}</Text>
        </View>
      </View>

      <View style={styles.card}>
        <Text style={styles.big}>{pendingCount}</Text>
        <Text style={styles.cardLabel}>待同步单据</Text>
      </View>

      <TouchableOpacity style={styles.btnPrimary} onPress={() => onNavigate('entry')}>
        <Text style={styles.btnPrimaryText}>＋ 新建进货单</Text>
      </TouchableOpacity>
      <TouchableOpacity style={styles.btn} onPress={() => onNavigate('drafts')}>
        <Text style={styles.btnText}>草稿箱（{pendingCount}）</Text>
      </TouchableOpacity>
      <TouchableOpacity style={styles.btn} onPress={() => onNavigate('details')}>
        <Text style={styles.btnText}>明细回看</Text>
      </TouchableOpacity>
      <TouchableOpacity style={[styles.btn, syncing && styles.btnDisabled]} onPress={onSync} disabled={syncing}>
        <Text style={styles.btnText}>{syncing ? '同步中…' : '立即同步'}</Text>
      </TouchableOpacity>
      <TouchableOpacity style={styles.btn} onPress={() => onNavigate('settings')}>
        <Text style={styles.btnText}>设置</Text>
      </TouchableOpacity>

      {syncing && (
        <View style={styles.syncBar}>
          <Text style={styles.syncText}>{syncMsg}</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.color.bg, padding: theme.space(2) },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingVertical: theme.space(1.5),
  },
  title: { fontSize: theme.font.size.xl, fontWeight: theme.font.weight.bold, color: theme.color.text },
  lanWrap: { flexDirection: 'row', alignItems: 'center' },
  dot: { width: 10, height: 10, borderRadius: 5, marginRight: theme.space(0.5) },
  lanText: { fontSize: theme.font.size.sm, color: theme.color.textMuted },
  card: {
    backgroundColor: theme.color.primarySoft, borderRadius: theme.radius.lg,
    padding: theme.space(3), alignItems: 'center', marginVertical: theme.space(2),
    ...theme.shadow.card,
  },
  big: { fontSize: 48, fontWeight: theme.font.weight.bold, color: theme.color.primary },
  cardLabel: { fontSize: theme.font.size.sm, color: theme.color.textMuted, marginTop: theme.space(0.5) },
  btnPrimary: {
    backgroundColor: theme.color.primary, borderRadius: theme.radius.md,
    paddingVertical: theme.space(1.75), alignItems: 'center', marginBottom: theme.space(1),
  },
  btnPrimaryText: { color: '#fff', fontSize: theme.font.size.lg, fontWeight: theme.font.weight.medium },
  btn: {
    backgroundColor: theme.color.surface, borderRadius: theme.radius.md,
    paddingVertical: theme.space(1.75), alignItems: 'center', marginBottom: theme.space(1),
    borderWidth: 1, borderColor: theme.color.border,
  },
  btnDisabled: { opacity: 0.5 },
  btnText: { color: theme.color.text, fontSize: theme.font.size.md },
  syncBar: {
    marginTop: theme.space(1), backgroundColor: theme.color.statusSyncing + '22',
    borderRadius: theme.radius.md, padding: theme.space(1.5),
  },
  syncText: { color: theme.color.statusSyncing, fontSize: theme.font.size.sm, textAlign: 'center' },
});
