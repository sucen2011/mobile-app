import React, { useState, useEffect } from 'react';
import { StyleSheet, View, Text, TextInput, TouchableOpacity, ScrollView, Alert } from 'react-native';
import { theme } from '../theme';
import { DEVICE_ID, getApiToken } from '../config';
import { getLastSync } from '../db/localDb';
import { SyncBadge, resolveSyncPhase } from '../components/SyncUI';
import type { SyncState } from '../nav';

interface Props {
  baseUrl: string;
  onBaseUrlChange: (v: string) => void;
  onTestConnection?: (url: string) => Promise<{ ok: boolean; msg: string }>;
  sync: SyncState;
}

export default function Settings({ baseUrl, onBaseUrlChange, onTestConnection, sync }: Props) {
  const lastSync = getLastSync();
  const syncedMin = lastSync ? Math.max(0, Math.round((Date.now() - lastSync) / 60000)) : null;
  const phase = resolveSyncPhase(sync);
  const [tok, setTok] = useState('');
  useEffect(() => { getApiToken().then((t) => setTok(t || '')); }, []);

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.content}>
      <Text style={styles.title}>我的</Text>

      {/* 同步状态 */}
      <View style={styles.card}>
        <View style={styles.cardHead}>
          <Text style={styles.cardTitle}>同步状态</Text>
          <SyncBadge state={sync} />
        </View>
        <Text style={styles.detail}>
          {phase === 'offline' && '当前离线 · 录入数据暂存本地，连店铺 WiFi 后自动同步'}
          {phase === 'syncing' && '正在与服务器同步…'}
          {phase === 'pending' && `有 ${sync.pendingCount} 笔草稿待同步`}
          {phase === 'synced' && '已与服务器保持一致，同步成功的本地草稿已清理'}
        </Text>
        <Text style={styles.meta}>
          最近快照：{syncedMin === null ? '尚未同步' : `${syncedMin} 分钟前`}
        </Text>
        <Text style={[styles.meta, sync.live && { color: theme.color.success }]}>
          实时通道：{sync.live ? '已连接 · 数据变更将自动刷新' : '未连接'}
        </Text>
      </View>

      {/* 同步设置 */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>同步设置</Text>
        <View style={styles.row}>
          <Text style={styles.rowLabel}>自动同步</Text>
          <Text style={[styles.rowValue, { color: theme.color.success }]}>已开启</Text>
        </View>
        <View style={styles.row}>
          <Text style={styles.rowLabel}>仅 WiFi 同步</Text>
          <Text style={[styles.rowValue, { color: theme.color.success }]}>已开启</Text>
        </View>
        <View style={styles.field}>
          <Text style={styles.label}>店铺服务器地址</Text>
          <TextInput
            style={styles.input}
            value={baseUrl}
            onChangeText={onBaseUrlChange}
            placeholder="http://电脑局域网IP:3001"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
          />
          <TouchableOpacity
            style={styles.testBtn}
            onPress={async () => {
              const r = await onTestConnection?.(baseUrl);
              if (r) Alert.alert(r.ok ? '连接正常' : '连接失败', r.msg);
            }}
          >
            <Text style={styles.testBtnText}>测试连接</Text>
          </TouchableOpacity>
          <Text style={styles.hint}>店外使用时，把地址改成店铺后端的公网地址或域名（含 http://），保存后重启也生效。</Text>
        </View>
      </View>

      {/* 关于 */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>关于</Text>
        <View style={styles.row}>
          <Text style={styles.rowLabel}>版本</Text>
          <Text style={styles.rowValue}>v1.0</Text>
        </View>
        <View style={styles.row}>
          <Text style={styles.rowLabel}>设备标识</Text>
          <Text style={[styles.rowValue, { fontFamily: theme.font.family.mono }]}>{DEVICE_ID.slice(0, 12)}…</Text>
        </View>
        <View style={styles.row}>
          <Text style={styles.rowLabel}>接口 Token</Text>
          <Text style={[styles.rowValue, { fontFamily: theme.font.family.mono }]}>{tok ? tok.slice(0, 12) + '…' : '—'}</Text>
        </View>
      </View>

      {/* 帮助与反馈 */}
      <TouchableOpacity style={styles.helpRow}>
        <Text style={styles.helpText}>帮助与反馈</Text>
        <Text style={styles.arrow}>›</Text>
      </TouchableOpacity>
      <Text style={styles.hint}>手机端为快捷录入端：离线可录、连 WiFi 自动同步、同步成功即清理本地草稿。供应商管理请在电脑端操作。</Text>
    </ScrollView>
  );
}

const S = theme.size;
const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.color.bgApp },
  content: { padding: theme.spaceScale[4], paddingBottom: 32 },
  title: { fontSize: theme.font.sizeV4.h2, fontWeight: theme.font.weight.bold, color: theme.color.textApp, marginBottom: theme.spaceScale[4] },
  card: { backgroundColor: theme.color.surfaceApp, borderRadius: theme.radius.lg, padding: theme.spaceScale[4], marginBottom: theme.spaceScale[4] },
  cardHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: theme.spaceScale[2] },
  cardTitle: { fontSize: theme.font.sizeV4.h4, fontWeight: theme.font.weight.semibold, color: theme.color.textApp, marginBottom: theme.spaceScale[3] },
  detail: { fontSize: theme.font.sizeV4.bodySm, color: theme.color.textAppSecondary, lineHeight: 20 },
  meta: { fontSize: theme.font.sizeV4.caption, color: theme.color.textAppTertiary, marginTop: theme.spaceScale[2] },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: S.listRowMinH, borderBottomWidth: 1, borderBottomColor: theme.color.dividerApp },
  rowLabel: { fontSize: theme.font.sizeV4.body, color: theme.color.textApp },
  rowValue: { fontSize: theme.font.sizeV4.body, color: theme.color.textAppSecondary, fontFamily: theme.font.family.num },
  field: { marginTop: theme.spaceScale[3] },
  label: { fontSize: theme.font.sizeV4.caption, color: theme.color.textAppSecondary, marginBottom: theme.spaceScale[2] },
  input: {
    backgroundColor: theme.color.surfaceSunken, borderWidth: 1, borderColor: theme.color.borderApp,
    borderRadius: theme.radius.md, height: S.controlLg, paddingHorizontal: theme.spaceScale[4],
    color: theme.color.textApp, fontSize: theme.font.sizeV4.body, fontFamily: theme.font.family.num,
  },
  helpRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: theme.color.surfaceApp, borderRadius: theme.radius.lg, padding: theme.spaceScale[4], marginBottom: theme.spaceScale[3] },
  testBtn: { marginTop: theme.spaceScale[3], alignSelf: 'flex-start', backgroundColor: theme.color.primaryVivid, borderRadius: theme.radius.md, paddingVertical: theme.spaceScale[2], paddingHorizontal: theme.spaceScale[4] },
  testBtnText: { color: '#fff', fontSize: theme.font.sizeV4.body, fontWeight: theme.font.weight.medium },
  helpText: { fontSize: theme.font.sizeV4.body, color: theme.color.textApp },
  arrow: { color: theme.color.textAppTertiary, fontSize: 20 },
  hint: { fontSize: theme.font.sizeV4.caption, color: theme.color.textAppTertiary, lineHeight: 18 },
});
