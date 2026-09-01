import React, { useState, useEffect } from 'react';
import { StyleSheet, View, Text, TextInput, TouchableOpacity, ScrollView, Alert } from 'react-native';
import { useTheme } from '../theme/ThemeProvider';
import { DEVICE_ID, getApiToken, type SyncPrefs } from '../config';
import { getLastSync } from '../db/localDb';
import { SyncBadge, resolveSyncPhase } from '../components/SyncUI';
import { SafeAreaHeader } from '../components/SafeArea';
import WarrantyScreen from './WarrantyScreen';
import SystemSettings from './SystemSettings';
import AccountManagement from './AccountManagement';
import OcrImageScreen from './OcrImageScreen';
import SupplierExpenseScreen from './SupplierExpenseScreen';
import type { SyncState } from '../nav';

interface Props {
  baseUrl: string;
  onBaseUrlChange: (v: string) => void;
  onTestConnection?: (url: string) => Promise<{ ok: boolean; msg: string }>;
  sync: SyncState;
  syncPrefs?: SyncPrefs;
  onSyncPrefsChange?: (p: SyncPrefs) => void;
  onLogout?: () => void;
}

export default function Settings({ baseUrl, onBaseUrlChange, onTestConnection, sync, syncPrefs, onSyncPrefsChange, onLogout }: Props) {
  const { theme } = useTheme();
  const styles = makeStyles(theme);
  const lastSync = getLastSync();
  const syncedMin = lastSync ? Math.max(0, Math.round((Date.now() - lastSync) / 60000)) : null;
  const phase = resolveSyncPhase(sync);
  const [tok, setTok] = useState('');
  const [view, setView] = useState<'main' | 'account' | 'ocr' | 'system' | 'warranty' | 'supplierExpense'>('main');
  useEffect(() => { getApiToken().then((t) => setTok(t || '')); }, []);

  const SUB_TITLES: Record<string, string> = {
    account: '账号管理',
    ocr: 'OCR主图生成',
    system: '系统设置',
    warranty: '电器保修',
  };

  // 「我的」子页面：账号管理 / OCR / 系统设置 / 电器保修。
  // 系统设置（SystemSettings，含主题切换+持久化）、电器保修（WarrantyScreen：本地 SQLite）、
  // 账号管理（AccountManagement：本机操作员档案）、OCR 主图生成（OcrImageScreen：相机拍照→后端腾讯云 OCR→主图库）均已落地。
  if (view !== 'main') {
    // 陈列费用：独立页（自带头部与「‹ 我的」返回），直接占满，不走 Settings 的子页 ScrollView 框架
    if (view === 'supplierExpense') {
      return <SupplierExpenseScreen baseUrl={baseUrl} onBack={() => setView('main')} />;
    }
    return (
      <ScrollView style={styles.subRoot} contentContainerStyle={styles.subContent}>
        <SafeAreaHeader style={styles.subHeader}>
          <TouchableOpacity
            style={styles.subBackBtn}
            onPress={() => setView('main')}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            accessibilityRole="button"
          >
            <Text style={styles.subBackText}>‹ 我的</Text>
          </TouchableOpacity>
          <Text style={styles.subTitle}>{SUB_TITLES[view]}</Text>
          <View style={styles.subSpacer} />
        </SafeAreaHeader>
        {view === 'account' ? (
          <AccountManagement />
        ) : view === 'warranty' ? (
          <WarrantyScreen />
        ) : view === 'system' ? (
          <SystemSettings />
        ) : view === 'ocr' ? (
          <OcrImageScreen baseUrl={baseUrl} />
        ) : (
          <Placeholder title={SUB_TITLES[view]} />
        )}
      </ScrollView>
    );
  }

  const handleLogout = () => {
    if (!onLogout) {
      Alert.alert('退出登录', '登录与账号体系将在 Phase 4 接入');
      return;
    }
    Alert.alert('退出登录', '将清除本机连接并返回登录页，本地草稿不会删除。', [
      { text: '取消', style: 'cancel' },
      { text: '退出', style: 'destructive', onPress: onLogout },
    ]);
  };

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
          <Text style={[styles.rowValue, { color: (syncPrefs?.autoSync ?? true) ? theme.color.success : theme.color.textAppTertiary }]}>
            {(syncPrefs?.autoSync ?? true) ? '已开启' : '已关闭'}
          </Text>
        </View>
        <View style={styles.row}>
          <Text style={styles.rowLabel}>仅 WiFi 同步</Text>
          <Text style={[styles.rowValue, { color: (syncPrefs?.wifiOnly ?? true) ? theme.color.success : theme.color.textAppTertiary }]}>
            {(syncPrefs?.wifiOnly ?? true) ? '已开启' : '已关闭'}
          </Text>
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

      {/* 我的 */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>我的</Text>
        <MenuRow label="账号管理" onPress={() => setView('account')} />
        <MenuRow label="OCR主图生成" onPress={() => setView('ocr')} />
        <MenuRow label="系统设置" onPress={() => setView('system')} />
        <MenuRow label="陈列费用" onPress={() => setView('supplierExpense')} />
        <MenuRow label="电器保修" onPress={() => setView('warranty')} last />
      </View>

      <TouchableOpacity style={styles.logoutRow} onPress={handleLogout}>
        <Text style={styles.logoutText}>退出登录</Text>
      </TouchableOpacity>

      {/* 帮助与反馈 */}
      <TouchableOpacity style={styles.helpRow}>
        <Text style={styles.helpText}>帮助与反馈</Text>
        <Text style={styles.arrow}>›</Text>
      </TouchableOpacity>
      <Text style={styles.hint}>手机端为快捷录入端：离线可录、连 WiFi 自动同步、同步成功即清理本地草稿。供应商管理请在电脑端操作。</Text>
    </ScrollView>
  );
}

function MenuRow({ label, onPress, last }: { label: string; onPress: () => void; last?: boolean }) {
  const { theme } = useTheme();
  const styles = makeStyles(theme);
  return (
    <TouchableOpacity
      style={[styles.menuRow, !last && { borderBottomWidth: 1, borderBottomColor: theme.color.dividerApp }]}
      onPress={onPress}
    >
      <Text style={styles.menuLabel}>{label}</Text>
      <Text style={styles.menuArrow}>›</Text>
    </TouchableOpacity>
  );
}

function Placeholder({ title }: { title: string }) {
  const { theme } = useTheme();
  const styles = makeStyles(theme);
  return (
    <View style={styles.placeholder}>
      <Text style={styles.placeholderTitle}>{title}</Text>
      <Text style={styles.placeholderText}>该模块将在 Phase 4 接入（账号体系 / OCR 引擎 / 设置项）。</Text>
    </View>
  );
}

function makeStyles(theme: any) {
  const S = theme.size;
  return StyleSheet.create({
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
  subRoot: { flex: 1, backgroundColor: theme.color.bgApp },
  subContent: { paddingBottom: 32 },
  subHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: theme.spaceScale[4], paddingVertical: theme.spaceScale[3], borderBottomWidth: 1, borderBottomColor: theme.color.dividerApp, backgroundColor: theme.color.surfaceApp },
  subBackBtn: { minHeight: 44, justifyContent: 'center' },
  subBackText: { fontSize: theme.font.sizeV4.body, color: theme.color.textAppSecondary },
  subTitle: { fontSize: theme.font.sizeV4.h4, fontWeight: theme.font.weight.semibold, color: theme.color.textApp },
  subSpacer: { width: 56 },
  placeholder: { padding: theme.spaceScale[4] },
  placeholderTitle: { fontSize: theme.font.sizeV4.h3, fontWeight: theme.font.weight.semibold, color: theme.color.textApp, marginBottom: theme.spaceScale[2] },
  placeholderText: { fontSize: theme.font.sizeV4.body, color: theme.color.textAppSecondary, lineHeight: 20 },
  menuRow: { flexDirection: 'row', alignItems: 'center', minHeight: S.listRowMinH },
  menuLabel: { flex: 1, fontSize: theme.font.sizeV4.body, color: theme.color.textApp },
  menuArrow: { color: theme.color.textAppTertiary, fontSize: 20 },
  logoutRow: { alignItems: 'center', justifyContent: 'center', backgroundColor: theme.color.surfaceApp, borderRadius: theme.radius.lg, paddingVertical: theme.spaceScale[4], marginTop: theme.spaceScale[3] },
  logoutText: { fontSize: theme.font.sizeV4.body, color: theme.color.danger, fontWeight: theme.font.weight.medium },
});
}
