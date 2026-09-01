import React, { useEffect, useMemo, useState } from 'react';
import {
  View, Text, ScrollView, StyleSheet, TouchableOpacity, Alert, TextInput, RefreshControl,
} from 'react-native';
import { useTheme } from '../theme/ThemeProvider';
import { SafeAreaHeader } from '../components/SafeArea';
import DatePickerField from '../components/DatePickerField';
import { SyncBadge, resolveSyncPhase } from '../components/SyncUI';
import type { SyncState } from '../nav';
import { toLocalDateStr, formatChineseDate } from '../utils/dateLabel';
import {
  getAllBarrelTypes, insertBarrelPress, insertBarrelRefund,
  getDepositFlows, getAllBarrelStock, updateBarrelStockInStore,
  getBarrelSummary, searchBarrelPress, deleteBarrelPress, clearTestBarrelRecords,
  type BarrelType, type BarrelPress, type BarrelRefund, type BarrelStockRow, type DepositFlowRow,
} from '../db/localDb';

interface Props { sync: SyncState; cacheVersion: number; onSyncAll?: () => void; }
type ViewKey = 'main' | 'press' | 'refund' | 'flow' | 'stock';

const VIEW_TITLES: Record<Exclude<ViewKey, 'main'>, string> = {
  press: '压桶登记',
  refund: '退桶登记',
  flow: '押金流水',
  stock: '桶库存',
};

function uuid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
// 生成业务单号：前缀(YT压桶/TK退桶) + 日期(YYYYMMDD) + 3位随机。
// 同步去重的关键：该 no 会随上行带给 PC，下行再按 no 命中本地、避免重复记账。
function genNo(prefix: string, date: string): string {
  return `${prefix}${date.replace(/-/g, '')}${String(Math.floor(100 + Math.random() * 900))}`;
}

function todayStr(): string { return toLocalDateStr(new Date()); }

export default function BarrelWaterScreen({ sync, cacheVersion, onSyncAll }: Props) {
  const { theme } = useTheme();
  const styles = makeStyles(theme);
  const [view, setView] = useState<ViewKey>('main');
  const [tick, setTick] = useState(0); // 触发派生数据刷新
  const refresh = () => setTick((t) => t + 1);

  // 清理本机（手机端）测试压/退桶记录，并重新计算库存。带二次确认，不可撤销。
  const handleClearTest = () => {
    Alert.alert(
      '清理测试数据',
      '将删除本机所有测试压桶/退桶记录（客户含 手机测试2/3/4、测试、验收客户），并重新计算库存。此操作不可撤销，确定继续？',
      [
        { text: '取消', style: 'cancel' },
        {
          text: '清理',
          style: 'destructive',
          onPress: () => {
            const r = clearTestBarrelRecords();
            refresh();
            Alert.alert('已清理', `已删除压桶 ${r.pressRemoved} 条、退桶 ${r.refundRemoved} 条。`);
          },
        },
      ]
    );
  };
  // 下行同步（PC→手机）完成后自动刷新本屏，无需用户手动下拉：
  // 用 useEffect 监听 cacheVersion（不重挂载，避免此前"分区自动跳出"bug 复发）。
  useEffect(() => { refresh(); }, [cacheVersion]);

  const summary = useMemo(() => getBarrelSummary(), [tick]);

  // ---- main ----
  if (view === 'main') {
    return (
      <ScrollView style={styles.root} contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={false} onRefresh={refresh} />}>
        <View style={styles.topRow}>
          <Text style={styles.title}>桶装水</Text>
          <SyncBadge state={sync} />
        </View>

        {/* 统计卡 ×3：实数派生 */}
        <View style={styles.statsRow}>
          <StatCard label="在押" value={summary.inUse} />
          <StatCard label="在库" value={summary.inStore} />
          <StatCard label="现有库存" value={summary.available} />
        </View>

        <Text style={styles.sectionTitle}>快捷操作</Text>
        <View style={styles.card}>
          <ActionRow label="压桶登记" note="登记压桶、收取押金"
            onPress={() => setView('press')} />
          <ActionRow label="退桶登记" note="退桶、退押金、扣损耗"
            onPress={() => setView('refund')} />
          <ActionRow label="押金流水" note="按时间倒序汇总"
            onPress={() => setView('flow')} />
          <ActionRow label="桶库存" note="按桶类型在库 / 在押"
            onPress={() => setView('stock')} />
        </View>

        <View style={styles.syncCard}>
          <View style={[styles.syncDot, { backgroundColor: syncPhaseColor(resolveSyncPhase(sync), theme) }]} />
          <Text style={styles.syncText}>
            桶装水操作落本地 SQLite，连接店铺后可双向核对；inStore 由「桶库存」页维护。
          </Text>
        </View>

        <Text style={styles.sectionTitle}>数据维护</Text>
        <View style={styles.card}>
          <ActionRow label="清理测试数据" note="删除本机测试压 / 退桶记录"
            onPress={handleClearTest} />
        </View>
      </ScrollView>
    );
  }

  // ---- sub-views ----
  const back = () => { setView('main'); refresh(); };
  // 保存压/退桶后直接进入「押金流水」，让刚登记的记录当场可见（避免回首页后误以为没存进去）
  const savedToFlow = () => { setView('flow'); refresh(); };
  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={false} onRefresh={refresh} />}>
      <SafeAreaHeader style={styles.subHeader}>
        <TouchableOpacity
          style={styles.subBackBtn}
          onPress={back}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          accessibilityRole="button"
        >
          <Text style={styles.subBackText}>‹ 桶装水</Text>
        </TouchableOpacity>
        <Text style={styles.subTitle}>{VIEW_TITLES[view]}</Text>
        <View style={styles.subSpacer} />
      </SafeAreaHeader>
      <View style={{ marginTop: theme.spaceScale[3] }}>
        {view === 'press' && <PressForm onSaved={savedToFlow} lanOn={sync.lanOn} onSyncAll={onSyncAll} />}
        {view === 'refund' && <RefundForm onSaved={savedToFlow} lanOn={sync.lanOn} onSyncAll={onSyncAll} />}
        {view === 'flow' && <FlowList tick={tick} />}
        {view === 'stock' && <StockList tick={tick} onChanged={refresh} />}
      </View>
    </ScrollView>
  );
}

// ============ 统计卡 ============
function StatCard({ label, value }: { label: string; value: number }) {
  const { theme } = useTheme();
  const styles = makeStyles(theme);
  return (
    <View style={styles.statCard}>
      <Text style={[styles.statValue, { fontFamily: theme.font.family.num }]}>
        {value}
      </Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

// ============ 操作行 ============
function ActionRow({ label, note, onPress }: { label: string; note: string; onPress: () => void }) {
  const { theme } = useTheme();
  const styles = makeStyles(theme);
  return (
    <TouchableOpacity style={styles.actionRow} onPress={onPress}>
      <View style={[styles.actionIcon, { backgroundColor: theme.color.primarySoft }]}>
        <Text style={[styles.actionIconText, { color: theme.color.primaryVivid }]}>桶</Text>
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.actionLabel}>{label}</Text>
        <Text style={styles.actionSub}>{note}</Text>
      </View>
      <Text style={styles.actionArrow}>›</Text>
    </TouchableOpacity>
  );
}

// ============ 桶类型选择器（Alert 简易实现）============
function TypePicker({ types, value, onChange }: {
  types: BarrelType[]; value: string; onChange: (name: string, deposit: number) => void;
}) {
  const { theme } = useTheme();
  const styles = makeStyles(theme);
  const show = () => {
    if (types.length === 0) { Alert.alert('桶类型', '暂无桶类型，请先在桶库存中维护'); return; }
    Alert.alert('选择桶类型', undefined, [
      ...types.map((t) => ({ text: `${t.name}（押金 ¥${t.deposit}）`, onPress: () => onChange(t.name, t.deposit) })),
      { text: '取消', onPress: () => undefined, style: 'cancel' as const },
    ]);
  };
  return (
    <TouchableOpacity style={styles.field} onPress={show}>
      <Text style={[styles.fieldText, !value && { color: theme.color.textAppTertiary }]}>
        {value || '点击选择桶类型'}
      </Text>
      <Text style={styles.fieldArrow}>›</Text>
    </TouchableOpacity>
  );
}

// ============ 压桶表单 ============
function PressForm({ onSaved, lanOn, onSyncAll }: { onSaved: () => void; lanOn: boolean; onSyncAll?: () => void; }) {
  const { theme } = useTheme();
  const styles = makeStyles(theme);
  const types = useMemo(() => getAllBarrelTypes(), []);
  const [customer, setCustomer] = useState('');
  const [phone, setPhone] = useState('');
  const [date, setDate] = useState(todayStr());
  const [barrel, setBarrel] = useState('');
  const [unitPrice, setUnitPrice] = useState(0);
  const [count, setCount] = useState(0);
  const [received, setReceived] = useState(0);
  const [note, setNote] = useState('');

  const totalDeposit = Math.max(0, count) * Math.max(0, unitPrice);
  const change = Math.max(0, received) - totalDeposit;

  const submit = () => {
    if (!customer.trim()) return Alert.alert('压桶登记', '请填写客户姓名');
    if (!barrel) return Alert.alert('压桶登记', '请选择桶类型');
    if (!(count > 0)) return Alert.alert('压桶登记', '请填写数量（大于 0）');
    try {
      const now = Date.now();
      insertBarrelPress({
        id: uuid(), no: genNo('YT', date), customer: customer.trim(), phone: phone.trim(), handler: '',
        date, items: [{ barrel, count, unitPrice }],
        totalDeposit, received, change, note: note.trim(), createdAt: now,
      });
      const syncTip = lanOn ? '已自动触发同步…' : '请连接店铺 WiFi 并触发同步，电脑端即可看到。';
      Alert.alert('压桶登记', `已登记：${barrel} × ${count}，押金 ¥${totalDeposit}\n\n${syncTip}`);
      onSaved();
      if (lanOn) onSyncAll?.();
    } catch (e: any) {
      Alert.alert('压桶登记失败', e?.message || String(e));
    }
  };

  return (
    <View style={styles.card}>
      <FieldLabel>客户姓名 *</FieldLabel>
      <TextInput style={styles.input} value={customer} onChangeText={setCustomer} placeholder="如：张师傅" placeholderTextColor={theme.color.textAppTertiary} />

      <FieldLabel>联系电话</FieldLabel>
      <TextInput style={styles.input} value={phone} onChangeText={setPhone} placeholder="选填" placeholderTextColor={theme.color.textAppTertiary} keyboardType="phone-pad" />

      <FieldLabel>压桶日期</FieldLabel>
      <DatePickerField value={date} onChange={setDate} />

      <FieldLabel>桶类型 *</FieldLabel>
      <TypePicker types={types} value={barrel} onChange={(n, d) => { setBarrel(n); setUnitPrice(d); }} />

      <View style={styles.dualRow}>
        <View style={{ flex: 1 }}>
          <FieldLabel>数量（桶）</FieldLabel>
          <TextInput style={styles.input} value={count ? String(count) : ''} onChangeText={(v) => setCount(Number(v.replace(/[^0-9]/g, '')) || 0)} placeholder="0" placeholderTextColor={theme.color.textAppTertiary} keyboardType="numeric" />
        </View>
        <View style={{ width: 12 }} />
        <View style={{ flex: 1 }}>
          <FieldLabel>押金单价</FieldLabel>
          <TextInput style={styles.input} value={unitPrice ? String(unitPrice) : ''} onChangeText={(v) => setUnitPrice(Number(v.replace(/[^0-9.]/g, '')) || 0)} placeholder="0" placeholderTextColor={theme.color.textAppTertiary} keyboardType="numeric" />
        </View>
      </View>

      <FieldLabel>押金合计</FieldLabel>
      <View style={styles.readonly}><Text style={styles.readonlyText}>¥ {totalDeposit.toFixed(2)}</Text></View>

      <FieldLabel>收款金额</FieldLabel>
      <TextInput style={styles.input} value={received ? String(received) : ''} onChangeText={(v) => setReceived(Number(v.replace(/[^0-9.]/g, '')) || 0)} placeholder="0" placeholderTextColor={theme.color.textAppTertiary} keyboardType="numeric" />

      <FieldLabel>找零</FieldLabel>
      <View style={styles.readonly}><Text style={[styles.readonlyText, { color: change < 0 ? theme.color.danger : theme.color.success }]}>¥ {change.toFixed(2)}</Text></View>

      <FieldLabel>备注</FieldLabel>
      <TextInput style={styles.input} value={note} onChangeText={setNote} placeholder="选填" placeholderTextColor={theme.color.textAppTertiary} />

      <TouchableOpacity style={styles.primaryBtn} onPress={submit}>
        <Text style={styles.primaryBtnText}>保存压桶</Text>
      </TouchableOpacity>
    </View>
  );
}

// ============ 退桶表单 ============
function RefundForm({ onSaved, lanOn, onSyncAll }: { onSaved: () => void; lanOn: boolean; onSyncAll?: () => void; }) {
  const { theme } = useTheme();
  const styles = makeStyles(theme);
  const types = useMemo(() => getAllBarrelTypes(), []);
  const [pressList] = useState<BarrelPress[]>(() => searchBarrelPress(''));
  const [customer, setCustomer] = useState('');
  const [phone, setPhone] = useState('');
  const [date, setDate] = useState(todayStr());
  const [barrel, setBarrel] = useState('');
  const [unitPrice, setUnitPrice] = useState(0);
  const [count, setCount] = useState(0);
  const [deduct, setDeduct] = useState(0);
  const [pressNo, setPressNo] = useState('');
  const [note, setNote] = useState('');

  const gross = Math.max(0, count) * Math.max(0, unitPrice);
  const refund = Math.max(0, gross - Math.max(0, deduct));

  const pickPress = () => {
    if (pressList.length === 0) { Alert.alert('退桶登记', '暂无压桶记录'); return; }
    const top = pressList.slice(0, 30);
    Alert.alert('关联压桶单（可跳过）', undefined, [
      ...top.map((p) => ({
        text: `${p.no} · ${p.customer} · ${p.date}`,
        onPress: () => {
          setPressNo(p.no);
          setCustomer(p.customer);
          setPhone(p.phone);
          if (p.items[0]) { setBarrel(p.items[0].barrel); setUnitPrice(p.items[0].unitPrice); }
        },
      })),
      { text: '不关联', onPress: () => setPressNo('') },
      { text: '取消', onPress: () => undefined, style: 'cancel' as const },
    ]);
  };

  const submit = () => {
    if (!customer.trim()) return Alert.alert('退桶登记', '请填写客户姓名');
    if (!barrel) return Alert.alert('退桶登记', '请选择桶类型');
    if (!(count > 0)) return Alert.alert('退桶登记', '请填写数量（大于 0）');
    try {
      const now = Date.now();
      insertBarrelRefund({
        id: uuid(), no: genNo('TK', date), pressNo, customer: customer.trim(), phone: phone.trim(),
        date, items: [{ barrel, count, unitPrice, deduct }],
        totalDeduct: Math.max(0, deduct), refund, note: note.trim(), createdAt: now,
      });
      const syncTip = lanOn ? '已自动触发同步…' : '请连接店铺 WiFi 并触发同步，电脑端即可看到。';
      Alert.alert('退桶登记', `已登记：退 ${barrel} × ${count}，实退 ¥${refund.toFixed(2)}\n\n${syncTip}`);
      onSaved();
      if (lanOn) onSyncAll?.();
    } catch (e: any) {
      Alert.alert('退桶登记失败', e?.message || String(e));
    }
  };

  return (
    <View style={styles.card}>
      <FieldLabel>关联压桶单（选填）</FieldLabel>
      <TouchableOpacity style={styles.field} onPress={pickPress}>
        <Text style={[styles.fieldText, !pressNo && { color: theme.color.textAppTertiary }]}>
          {pressNo || '点击选择已登记的压桶单'}
        </Text>
        <Text style={styles.fieldArrow}>›</Text>
      </TouchableOpacity>

      <FieldLabel>客户姓名 *</FieldLabel>
      <TextInput style={styles.input} value={customer} onChangeText={setCustomer} placeholder="如：张师傅" placeholderTextColor={theme.color.textAppTertiary} />

      <FieldLabel>联系电话</FieldLabel>
      <TextInput style={styles.input} value={phone} onChangeText={setPhone} placeholder="选填" placeholderTextColor={theme.color.textAppTertiary} keyboardType="phone-pad" />

      <FieldLabel>退桶日期</FieldLabel>
      <DatePickerField value={date} onChange={setDate} />

      <FieldLabel>桶类型 *</FieldLabel>
      <TypePicker types={types} value={barrel} onChange={(n, d) => { setBarrel(n); setUnitPrice(d); }} />

      <View style={styles.dualRow}>
        <View style={{ flex: 1 }}>
          <FieldLabel>数量（桶）</FieldLabel>
          <TextInput style={styles.input} value={count ? String(count) : ''} onChangeText={(v) => setCount(Number(v.replace(/[^0-9]/g, '')) || 0)} placeholder="0" placeholderTextColor={theme.color.textAppTertiary} keyboardType="numeric" />
        </View>
        <View style={{ width: 12 }} />
        <View style={{ flex: 1 }}>
          <FieldLabel>扣减损耗</FieldLabel>
          <TextInput style={styles.input} value={deduct ? String(deduct) : ''} onChangeText={(v) => setDeduct(Number(v.replace(/[^0-9.]/g, '')) || 0)} placeholder="0" placeholderTextColor={theme.color.textAppTertiary} keyboardType="numeric" />
        </View>
      </View>

      <FieldLabel>押金单价</FieldLabel>
      <TextInput style={styles.input} value={unitPrice ? String(unitPrice) : ''} onChangeText={(v) => setUnitPrice(Number(v.replace(/[^0-9.]/g, '')) || 0)} placeholder="0" placeholderTextColor={theme.color.textAppTertiary} keyboardType="numeric" />

      <FieldLabel>实退金额</FieldLabel>
      <View style={styles.readonly}><Text style={[styles.readonlyText, { color: theme.color.success }]}>¥ {refund.toFixed(2)}</Text></View>

      <FieldLabel>备注</FieldLabel>
      <TextInput style={styles.input} value={note} onChangeText={setNote} placeholder="选填" placeholderTextColor={theme.color.textAppTertiary} />

      <TouchableOpacity style={styles.primaryBtn} onPress={submit}>
        <Text style={styles.primaryBtnText}>保存退桶</Text>
      </TouchableOpacity>
    </View>
  );
}

// ============ 押金流水 ============
function FlowList({ tick }: { tick: number }) {
  const { theme } = useTheme();
  const styles = makeStyles(theme);
  const flows = useMemo(() => getDepositFlows(), [tick]);
  if (flows.length === 0) {
    return <View style={styles.empty}><Text style={styles.emptyText}>暂无流水</Text></View>;
  }
  return (
    <View style={styles.card}>
      {flows.map((f, i) => (
        <View key={f.key} style={[styles.flowRow, i > 0 && { borderTopWidth: 1, borderTopColor: theme.color.dividerApp }]}>
          <View style={[styles.flowTag, { backgroundColor: f.type === 'press' ? theme.color.primarySoft : theme.color.surfaceRaised }]}>
            <Text style={[styles.flowTagText, { color: f.type === 'press' ? theme.color.primaryVivid : theme.color.info }]}>
              {f.type === 'press' ? '压桶' : '退桶'}
            </Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.flowTitle}>{f.no} · {f.customer || '—'}</Text>
            <Text style={styles.flowSub}>{formatChineseDate(f.date)} · {f.remark}</Text>
          </View>
          <Text style={[styles.flowAmount, { color: f.amount >= 0 ? theme.color.success : theme.color.danger }]}>
            {f.amount >= 0 ? '+' : ''}¥{f.amount.toFixed(2)}
          </Text>
        </View>
      ))}
    </View>
  );
}

// ============ 桶库存 ============
function StockList({ tick, onChanged }: { tick: number; onChanged: () => void }) {
  const { theme } = useTheme();
  const styles = makeStyles(theme);
  const [stock, setStock] = useState<BarrelStockRow[]>(() => getAllBarrelStock());
  React.useEffect(() => { setStock(getAllBarrelStock()); }, [tick]);

  const adjust = (row: BarrelStockRow, delta: number) => {
    const next = Math.max(0, row.inStore + delta);
    updateBarrelStockInStore(row.type, next);
    setStock(getAllBarrelStock());
    onChanged();
  };
  const setCustom = (row: BarrelStockRow) => {
    Alert.alert('修改在库', undefined, [
      ...[-10, -1, +1, +10].map((d) => ({
        text: `${d > 0 ? '+' : ''}${d}`,
        onPress: () => adjust(row, d),
      })),
      { text: '清零', onPress: () => adjust(row, -row.inStore) },
      { text: '取消', onPress: () => undefined, style: 'cancel' as const },
    ]);
  };

  if (stock.length === 0) {
    return <View style={styles.empty}><Text style={styles.emptyText}>暂无桶类型</Text></View>;
  }
  return (
    <View>
      <Text style={styles.hint}>在库由您直接维护（手机端无采购入库流程）；在押随压桶 / 退桶自动联动。现有库存 = 在库 − 在押。</Text>
      <View style={styles.card}>
        <View style={[styles.stockHeaderRow, { borderBottomWidth: 1, borderBottomColor: theme.color.dividerApp }]}>
          <Text style={[styles.stockHeaderCell, { flex: 1.4 }]}>桶类型</Text>
          <Text style={[styles.stockHeaderCell, { flex: 1, textAlign: 'right' }]}>在库</Text>
          <Text style={[styles.stockHeaderCell, { flex: 1, textAlign: 'right' }]}>在押</Text>
          <Text style={[styles.stockHeaderCell, { flex: 1, textAlign: 'right' }]}>现有库存</Text>
        </View>
        {stock.map((s) => (
          <TouchableOpacity key={s.type} style={styles.stockRow} onPress={() => setCustom(s)}>
            <Text style={[styles.stockType, { flex: 1.4 }]}>{s.type}</Text>
            <Text style={[styles.stockNum, { flex: 1, color: theme.color.primaryVivid }]}>{s.inStore}</Text>
            <Text style={[styles.stockNum, { flex: 1, color: theme.color.info }]}>{s.inUse}</Text>
            <Text style={[styles.stockNum, { flex: 1 }]}>{s.inStore - s.inUse}</Text>
          </TouchableOpacity>
        ))}
      </View>
    </View>
  );
}

// ============ 通用小件 ============
function FieldLabel({ children }: { children: React.ReactNode }) {
  const { theme } = useTheme();
  return <Text style={{ fontSize: 12, color: theme.color.textAppTertiary, marginTop: 12, marginBottom: 6 }}>{children}</Text>;
}

function syncPhaseColor(p: string, theme: any): string {
  if (p === 'syncing') return theme.color.info;
  if (p === 'offline') return theme.color.textAppTertiary;
  if (p === 'pending') return theme.color.statusPending;
  return theme.color.success;
}

function makeStyles(theme: any) {
  const S = theme.size;
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: theme.color.bgApp },
    content: { padding: theme.spaceScale[4], paddingBottom: 32 },
    topRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: theme.spaceScale[4] },
    title: { fontSize: theme.font.sizeV4.h2, fontWeight: theme.font.weight.bold, color: theme.color.textApp },
    statsRow: { flexDirection: 'row', gap: theme.spaceScale[3], marginBottom: theme.spaceScale[4] },
    statCard: { flex: 1, backgroundColor: theme.color.surfaceApp, borderRadius: theme.radius.lg, padding: theme.spaceScale[4], alignItems: 'center' },
    statValue: { fontSize: theme.font.sizeV4.metric, fontWeight: theme.font.weight.semibold, color: theme.color.textApp },
    statLabel: { fontSize: theme.font.sizeV4.caption, color: theme.color.textAppTertiary, marginTop: 4 },
    sectionTitle: { fontSize: theme.font.sizeV4.h4, fontWeight: theme.font.weight.semibold, color: theme.color.textApp, marginBottom: theme.spaceScale[3] },
    card: { backgroundColor: theme.color.surfaceApp, borderRadius: theme.radius.lg, paddingHorizontal: theme.spaceScale[4], marginBottom: theme.spaceScale[4] },
    actionRow: { flexDirection: 'row', alignItems: 'center', minHeight: S.listRowMinH, paddingVertical: 10, borderBottomWidth: 0 },
    actionIcon: { width: 36, height: 36, borderRadius: theme.radius.md, alignItems: 'center', justifyContent: 'center', marginRight: theme.spaceScale[3] },
    actionIconText: { fontSize: theme.font.sizeV4.bodySm, fontWeight: theme.font.weight.semibold },
    actionLabel: { fontSize: theme.font.sizeV4.body, color: theme.color.textApp, fontWeight: '500' },
    actionSub: { fontSize: theme.font.sizeV4.caption, color: theme.color.textAppTertiary, marginTop: 2 },
    actionArrow: { color: theme.color.textAppTertiary, fontSize: 22 },
    syncCard: { flexDirection: 'row', alignItems: 'center', backgroundColor: theme.color.surfaceApp, borderWidth: 1, borderColor: theme.color.borderApp, borderRadius: theme.radius.lg, padding: theme.spaceScale[4] },
    syncDot: { width: 8, height: 8, borderRadius: 4, marginRight: theme.spaceScale[2] },
    syncText: { flex: 1, fontSize: theme.font.sizeV4.bodySm, color: theme.color.textAppSecondary, lineHeight: 20 },
    input: { backgroundColor: theme.color.surfaceRaised, borderRadius: theme.radius.md, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15, color: theme.color.textApp, minHeight: S.controlLg },
    field: { flexDirection: 'row', alignItems: 'center', backgroundColor: theme.color.surfaceRaised, borderRadius: theme.radius.md, paddingHorizontal: 12, paddingVertical: 12, minHeight: S.controlLg },
    fieldText: { flex: 1, fontSize: 15, color: theme.color.textApp },
    fieldArrow: { color: theme.color.textAppTertiary, fontSize: 18 },
    dualRow: { flexDirection: 'row' },
    readonly: { backgroundColor: theme.color.surfaceSunken, borderRadius: theme.radius.md, paddingHorizontal: 12, paddingVertical: 12, minHeight: S.controlLg, justifyContent: 'center' },
    readonlyText: { fontSize: 17, fontWeight: '600', color: theme.color.textApp },
    primaryBtn: { backgroundColor: theme.color.primaryVivid, borderRadius: theme.radius.md, minHeight: S.controlLg, alignItems: 'center', justifyContent: 'center', marginTop: 16, marginBottom: 8 },
    primaryBtnText: { color: '#FFFFFF', fontSize: 16, fontWeight: '600' },
    flowRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, gap: 10 },
    flowTag: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: theme.radius.sm },
    flowTagText: { fontSize: 12, fontWeight: '600' },
    flowTitle: { fontSize: 14, color: theme.color.textApp, fontWeight: '500' },
    flowSub: { fontSize: 12, color: theme.color.textAppTertiary, marginTop: 2 },
    flowAmount: { fontSize: 15, fontWeight: '600' },
    hint: { fontSize: 12, color: theme.color.textAppTertiary, lineHeight: 18, marginBottom: theme.spaceScale[3] },
    stockHeaderRow: { flexDirection: 'row', paddingVertical: 8 },
    stockHeaderCell: { fontSize: 12, color: theme.color.textAppTertiary, fontWeight: '600' },
    stockRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12 },
    stockType: { fontSize: 14, color: theme.color.textApp, fontWeight: '500' },
    stockNum: { fontSize: 16, fontWeight: '600', textAlign: 'right', fontVariant: ['tabular-nums'] },
    empty: { backgroundColor: theme.color.surfaceApp, borderRadius: theme.radius.lg, padding: theme.spaceScale[6], alignItems: 'center' },
    emptyText: { color: theme.color.textAppTertiary, fontSize: 14 },
    subHeader: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, backgroundColor: theme.color.bgApp },
    subBackBtn: { paddingLeft: 4, paddingRight: 12, paddingVertical: 4 },
    subBackText: { fontSize: 15, color: theme.color.primaryVivid },
    subTitle: { fontSize: 17, fontWeight: '600', color: theme.color.textApp, flex: 1, textAlign: 'center' },
    subSpacer: { width: 60 },
  });
}
