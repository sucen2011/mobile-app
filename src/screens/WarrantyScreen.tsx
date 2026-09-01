import React, { useState, useEffect } from 'react';
import { View, Text, TextInput, TouchableOpacity, Alert, StyleSheet } from 'react-native';
import { useTheme } from '../theme/ThemeProvider';
import DatePickerField from '../components/DatePickerField';
import { toLocalDateStr } from '../utils/dateLabel';
import {
  insertWarrantyDevice,
  searchWarrantyDevices,
  deleteWarrantyDevice,
  getWarrantyStatus,
  type WarrantyDevice,
  type WarrantyStatus,
} from '../db/localDb';

function uuid() {
  return 'w_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

type ViewKey = 'main' | 'purchase' | 'lookup';

const ENTRIES = [
  { key: 'purchase', title: '购买登记', sub: '登记新购电器与保修信息', glyph: '购' },
  { key: 'lookup', title: '设备查询', sub: '按客户 / 设备号查询在保状态', glyph: '查' },
] as const;

// 状态语义色（与主题无关，保证深浅色下都可读）
const STATUS_BG: Record<WarrantyStatus, string> = {
  在保: 'rgba(16,185,129,0.12)',
  即将到期: 'rgba(143,100,16,0.14)',
  已过保: 'rgba(196,50,43,0.12)',
};

/**
 * 电器保修（手机端极简版，非独立 Tab）。
 * 仅「购买登记」+「设备查询」两项，数据纯本地；完整报修工单在电脑端处理。
 * 作为「我的」菜单的子页面正文渲染（由 Settings 子页提供返回头），自身不带标题栏。
 */
export default function WarrantyScreen() {
  const { theme } = useTheme();
  const styles = makeStyles(theme);
  const [view, setView] = useState<ViewKey>('main');

  return (
    <View style={styles.root}>
      {view === 'main' && (
        <>
          {ENTRIES.map((e) => (
            <TouchableOpacity key={e.key} style={styles.card} onPress={() => setView(e.key)}>
              <View style={[styles.icon, { backgroundColor: theme.color.primarySoft }]}>
                <Text style={[styles.iconText, { color: theme.color.primaryVivid }]}>{e.glyph}</Text>
              </View>
              <View style={styles.main}>
                <Text style={styles.title}>{e.title}</Text>
                <Text style={styles.sub}>{e.sub}</Text>
              </View>
              <Text style={styles.arrow}>›</Text>
            </TouchableOpacity>
          ))}
          <Text style={styles.hint}>
            电器版块使用频率低，手机端仅保留购买登记与设备查询。数据仅存本机、离线可用，完整报修流程在电脑端处理。
          </Text>
        </>
      )}

      {view === 'purchase' && (
        <PurchaseForm styles={styles} onBack={() => setView('main')} onSaved={() => setView('main')} />
      )}
      {view === 'lookup' && <LookupList styles={styles} onBack={() => setView('main')} />}
    </View>
  );
}

function BackBar({
  styles,
  label,
  onBack,
}: {
  styles: ReturnType<typeof makeStyles>;
  label: string;
  onBack: () => void;
}) {
  return (
    <TouchableOpacity
      style={styles.backBar}
      onPress={onBack}
      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
      accessibilityRole="button"
    >
      <Text style={styles.backText}>‹ 返回</Text>
      <Text style={styles.backLabel}>{label}</Text>
    </TouchableOpacity>
  );
}

function Field({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  const { theme } = useTheme();
  return (
    <View style={{ marginBottom: 14 }}>
      <Text style={{ fontSize: theme.font.sizeV4.caption, color: theme.color.textAppSecondary, marginBottom: 6 }}>
        {label}
        {required ? ' *' : ''}
      </Text>
      {children}
    </View>
  );
}

function PurchaseForm({
  styles,
  onBack,
  onSaved,
}: {
  styles: ReturnType<typeof makeStyles>;
  onBack: () => void;
  onSaved: () => void;
}) {
  const { theme } = useTheme();
  const today = toLocalDateStr(new Date());
  const [customerName, setCustomerName] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [brand, setBrand] = useState('');
  const [model, setModel] = useState('');
  const [serialNo, setSerialNo] = useState('');
  const [purchaseDate, setPurchaseDate] = useState(today);
  const [warrantyMonths, setWarrantyMonths] = useState('12');
  const [price, setPrice] = useState('');
  const [note, setNote] = useState('');

  const save = () => {
    if (!customerName.trim()) return Alert.alert('请填写客户姓名');
    if (!brand.trim()) return Alert.alert('请填写品牌');
    if (!model.trim()) return Alert.alert('请填写型号');
    if (!serialNo.trim()) return Alert.alert('请填写设备序列号');
    const device: WarrantyDevice = {
      id: uuid(),
      customerName: customerName.trim(),
      customerPhone: customerPhone.trim(),
      brand: brand.trim(),
      model: model.trim(),
      serialNo: serialNo.trim(),
      purchaseDate,
      warrantyMonths: parseInt(warrantyMonths, 10) || 12,
      price: parseFloat(price) || 0,
      note: note.trim(),
      createdAt: Date.now(),
    };
    insertWarrantyDevice(device);
    Alert.alert('已登记', `${brand} ${model} 的保修信息已保存到本机`);
    onSaved();
  };

  return (
    <View>
      <BackBar styles={styles} label="购买登记" onBack={onBack} />
      <View style={styles.formCard}>
        <Field label="客户姓名" required>
          <TextInput
            style={styles.input}
            value={customerName}
            onChangeText={setCustomerName}
            placeholder="如：王记便利店"
            placeholderTextColor={theme.color.textAppTertiary}
          />
        </Field>
        <Field label="客户电话">
          <TextInput
            style={styles.input}
            value={customerPhone}
            onChangeText={setCustomerPhone}
            placeholder="选填"
            placeholderTextColor={theme.color.textAppTertiary}
            keyboardType="phone-pad"
          />
        </Field>
        <Field label="品牌" required>
          <TextInput
            style={styles.input}
            value={brand}
            onChangeText={setBrand}
            placeholder="如：美的"
            placeholderTextColor={theme.color.textAppTertiary}
          />
        </Field>
        <Field label="型号" required>
          <TextInput
            style={styles.input}
            value={model}
            onChangeText={setModel}
            placeholder="如：BCD-218"
            placeholderTextColor={theme.color.textAppTertiary}
          />
        </Field>
        <Field label="设备序列号" required>
          <TextInput
            style={styles.input}
            value={serialNo}
            onChangeText={setSerialNo}
            placeholder="机身 SN"
            placeholderTextColor={theme.color.textAppTertiary}
            autoCapitalize="none"
          />
        </Field>
        <Field label="购买日期">
          <DatePickerField value={purchaseDate} onChange={setPurchaseDate} title="购买日期" />
        </Field>
        <Field label="保修月数">
          <TextInput
            style={styles.input}
            value={warrantyMonths}
            onChangeText={setWarrantyMonths}
            placeholder="12"
            placeholderTextColor={theme.color.textAppTertiary}
            keyboardType="numeric"
          />
        </Field>
        <Field label="购价（元）">
          <TextInput
            style={styles.input}
            value={price}
            onChangeText={setPrice}
            placeholder="选填"
            placeholderTextColor={theme.color.textAppTertiary}
            keyboardType="numeric"
          />
        </Field>
        <Field label="备注">
          <TextInput
            style={[styles.input, styles.inputArea]}
            value={note}
            onChangeText={setNote}
            placeholder="选填"
            placeholderTextColor={theme.color.textAppTertiary}
            multiline
            numberOfLines={3}
          />
        </Field>
      </View>
      <TouchableOpacity
        style={[styles.saveBtn, { backgroundColor: theme.color.primaryVivid }]}
        onPress={save}
        accessibilityRole="button"
      >
        <Text style={styles.saveBtnText}>保存登记</Text>
      </TouchableOpacity>
      <Text style={styles.hint}>数据仅保存在本机，用于现场快速登记；完整报修工单请在电脑端处理。</Text>
    </View>
  );
}

function LookupList({
  styles,
  onBack,
}: {
  styles: ReturnType<typeof makeStyles>;
  onBack: () => void;
}) {
  const { theme } = useTheme();
  const [kw, setKw] = useState('');
  const [list, setList] = useState<WarrantyDevice[]>([]);

  useEffect(() => {
    setList(searchWarrantyDevices(kw));
  }, [kw]);

  const handleDelete = (d: WarrantyDevice) => {
    Alert.alert('删除登记', `确定删除「${d.brand} ${d.model}」的保修登记？`, [
      { text: '取消', style: 'cancel' },
      {
        text: '删除',
        style: 'destructive',
        onPress: () => {
          deleteWarrantyDevice(d.id);
          setList((prev) => prev.filter((x) => x.id !== d.id));
        },
      },
    ]);
  };

  return (
    <View>
      <BackBar styles={styles} label="设备查询" onBack={onBack} />
      <View style={styles.searchBox}>
        <Text style={styles.searchIcon}>🔍</Text>
        <TextInput
          style={styles.searchInput}
          value={kw}
          onChangeText={setKw}
          placeholder="客户名 / 电话 / 设备号 / 品牌型号"
          placeholderTextColor={'rgba(0,0,0,0.35)'}
          autoCapitalize="none"
        />
        {kw.length > 0 && (
          <TouchableOpacity onPress={() => setKw('')} hitSlop={8} accessibilityRole="button">
            <Text style={styles.searchClear}>✕</Text>
          </TouchableOpacity>
        )}
      </View>
      <Text style={styles.countText}>{list.length} 条登记</Text>

      {list.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyText}>暂无匹配设备{'\n'}去「购买登记」添加一条</Text>
        </View>
      ) : (
        list.map((d) => {
          const { status, endDate } = getWarrantyStatus(d);
          return (
            <View key={d.id} style={styles.item}>
              <View style={styles.itemTop}>
                <Text style={styles.itemTitle}>
                  {d.brand} {d.model}
                </Text>
                <View style={[styles.pill, { backgroundColor: STATUS_BG[status] }]}>
                  <Text style={[styles.pillText, { color: theme.color[statusColorKey(status)] }]}>
                    {status}
                  </Text>
                </View>
              </View>
              <Text style={styles.itemSub}>序列号 {d.serialNo}</Text>
              <Text style={styles.itemSub}>
                {d.customerName}
                {d.customerPhone ? ` · ${d.customerPhone}` : ''}
              </Text>
              <View style={styles.itemFoot}>
                <Text style={styles.itemMeta}>
                  购于 {d.purchaseDate} · 保至 {endDate}
                </Text>
                <TouchableOpacity onPress={() => handleDelete(d)} hitSlop={8} accessibilityRole="button">
                  <Text style={styles.delText}>删除</Text>
                </TouchableOpacity>
              </View>
            </View>
          );
        })
      )}
    </View>
  );
}

/** 状态 → 主题色键（在保=success / 即将到期=warning / 已过保=danger） */
function statusColorKey(s: WarrantyStatus): 'success' | 'warning' | 'danger' {
  if (s === '在保') return 'success';
  if (s === '即将到期') return 'warning';
  return 'danger';
}

function makeStyles(theme: any) {
  const S = theme.size;
  return StyleSheet.create({
    root: { padding: theme.spaceScale[4], paddingBottom: 32 },

    // 主入口卡片
    card: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: theme.color.surfaceApp,
      borderRadius: theme.radius.lg,
      padding: theme.spaceScale[4],
      marginBottom: theme.spaceScale[4],
    },
    icon: {
      width: 40,
      height: 40,
      borderRadius: theme.radius.md,
      alignItems: 'center',
      justifyContent: 'center',
      marginRight: theme.spaceScale[4],
    },
    iconText: { fontSize: theme.font.sizeV4.bodyLg, fontWeight: theme.font.weight.semibold },
    main: { flex: 1 },
    title: { fontSize: theme.font.sizeV4.h4, fontWeight: theme.font.weight.semibold, color: theme.color.textApp },
    sub: { fontSize: theme.font.sizeV4.caption, color: theme.color.textAppSecondary, marginTop: 2 },
    arrow: { color: theme.color.textAppTertiary, fontSize: 22 },
    hint: {
      fontSize: theme.font.sizeV4.caption,
      color: theme.color.textAppTertiary,
      lineHeight: 18,
      marginTop: theme.spaceScale[2],
    },

    // 内部返回条
    backBar: { flexDirection: 'row', alignItems: 'center', marginBottom: theme.spaceScale[3] },
    backText: {
      fontSize: theme.font.sizeV4.body,
      color: theme.color.primaryVivid,
      fontWeight: theme.font.weight.medium,
      marginRight: theme.spaceScale[3],
    },
    backLabel: {
      fontSize: theme.font.sizeV4.h4,
      fontWeight: theme.font.weight.semibold,
      color: theme.color.textApp,
    },

    // 登记表单
    formCard: {
      backgroundColor: theme.color.surfaceApp,
      borderRadius: theme.radius.lg,
      padding: theme.spaceScale[4],
      marginBottom: theme.spaceScale[3],
    },
    input: {
      minHeight: S.controlLg,
      backgroundColor: theme.color.surfaceRaised,
      borderRadius: theme.radius.md,
      borderWidth: 1,
      borderColor: theme.color.border,
      paddingHorizontal: theme.spaceScale[3],
      paddingVertical: theme.spaceScale[1],
      fontSize: theme.font.sizeV4.body,
      color: theme.color.textApp,
    },
    inputArea: { height: 76, textAlignVertical: 'top', paddingTop: theme.spaceScale[2] },
    saveBtn: {
      minHeight: S.controlLg,
      borderRadius: theme.radius.md,
      alignItems: 'center',
      justifyContent: 'center',
      marginBottom: theme.spaceScale[3],
    },
    saveBtnText: {
      color: '#FFFFFF',
      fontSize: theme.font.sizeV4.h4,
      fontWeight: theme.font.weight.semibold,
    },

    // 设备查询
    searchBox: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: theme.color.surfaceRaised,
      borderRadius: theme.radius.md,
      borderWidth: 1,
      borderColor: theme.color.border,
      paddingHorizontal: theme.spaceScale[3],
      minHeight: S.controlLg,
      marginBottom: theme.spaceScale[3],
    },
    searchIcon: { fontSize: 16, marginRight: theme.spaceScale[2] },
    searchInput: { flex: 1, fontSize: theme.font.sizeV4.body, color: theme.color.textApp },
    searchClear: { fontSize: 16, color: theme.color.textAppTertiary, marginLeft: theme.spaceScale[2] },
    countText: {
      fontSize: theme.font.sizeV4.caption,
      color: theme.color.textAppTertiary,
      marginBottom: theme.spaceScale[3],
    },
    empty: { alignItems: 'center', paddingVertical: 48 },
    emptyText: {
      fontSize: theme.font.sizeV4.body,
      color: theme.color.textAppTertiary,
      textAlign: 'center',
      lineHeight: 22,
    },

    // 设备条目
    item: {
      backgroundColor: theme.color.surfaceApp,
      borderRadius: theme.radius.lg,
      padding: theme.spaceScale[4],
      marginBottom: theme.spaceScale[3],
      borderWidth: 1,
      borderColor: theme.color.dividerApp,
    },
    itemTop: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginBottom: 6,
    },
    itemTitle: {
      flex: 1,
      marginRight: theme.spaceScale[2],
      fontSize: theme.font.sizeV4.bodyLg,
      fontWeight: theme.font.weight.semibold,
      color: theme.color.textApp,
    },
    pill: { paddingHorizontal: 10, paddingVertical: 3, borderRadius: 999 },
    pillText: { fontSize: theme.font.sizeV4.micro, fontWeight: theme.font.weight.semibold },
    itemSub: {
      fontSize: theme.font.sizeV4.caption,
      color: theme.color.textAppSecondary,
      marginTop: 2,
    },
    itemFoot: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginTop: theme.spaceScale[2],
      borderTopWidth: 1,
      borderTopColor: theme.color.dividerApp,
      paddingTop: theme.spaceScale[2],
    },
    itemMeta: { fontSize: theme.font.sizeV4.caption, color: theme.color.textAppTertiary },
    delText: {
      fontSize: theme.font.sizeV4.caption,
      color: theme.color.danger,
      fontWeight: theme.font.weight.medium,
    },
  });
}
