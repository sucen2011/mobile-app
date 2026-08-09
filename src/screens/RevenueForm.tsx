import React, { useState, useEffect } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, ScrollView, Alert } from 'react-native';
import { theme } from '../theme';
import { toLocalDateStr } from '../utils/dateLabel';
import DatePickerField from '../components/DatePickerField';
import { SafeAreaHeader } from '../components/SafeArea';
import { fetchCustomChannels, type CustomChannel } from '../api/settings';
import {
  getEnabledCustomChannels,
  setCachedCustomChannels,
  insertRevenueDraft,
} from '../db/localDb';
import { DEVICE_ID } from '../config';

interface Props {
  baseUrl: string;
  lanOn: boolean;
  onSaved: () => void;
  onCancel: () => void;
}

function uuid() {
  return 'r_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export default function RevenueForm({ baseUrl, lanOn, onSaved, onCancel }: Props) {
  const [date, setDate] = useState(toLocalDateStr(new Date()));
  const [cash, setCash] = useState('');
  const [wechat, setWechat] = useState('');
  const [alipay, setAlipay] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);

  // 自定义收款渠道（网页端设置页「自定义收款 1/2/3」，存在 /api/settings.customChannels）。
  // 先用本地缓存同步渲染（离线可用、无闪烁），挂载后再拉一次服务端刷新最新命名/启停。
  const [customs, setCustoms] = useState<CustomChannel[]>(() => getEnabledCustomChannels());
  const [customAmounts, setCustomAmounts] = useState<Record<string, string>>({});

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const list = await fetchCustomChannels(baseUrl);
        if (!alive) return;
        setCachedCustomChannels(list); // 回写缓存，详情页读的是同一份
        setCustoms(list.filter((c) => c.enabled !== false));
      } catch {
        /* 离线：沿用缓存里的渠道配置 */
      }
    })();
    return () => {
      alive = false;
    };
  }, [baseUrl]);

  const num = (s: string) => parseFloat(s || '0') || 0;
  // 合计 = 现金 + 微信 + 支付宝 + 各启用自定义渠道
  const customTotal = customs.reduce((s, c) => s + num(customAmounts[c.key] || ''), 0);
  const total = num(cash) + num(wechat) + num(alipay) + customTotal;

  const setCustomAmount = (key: string, v: string) =>
    setCustomAmounts((prev) => ({ ...prev, [key]: v }));

  /**
   * 离线优先：**永远只写本机**，一个字节都不 await 后端。
   *
   * 改这里的原因（原实现的两个真实丢数据场景）：
   *   1. 不在店铺网段（在家 / 4G）：直接 Alert「需联网记账」把人挡回去，
   *      店主当场记不了账，只能拿纸笔另记 —— 而这正是这个 App 要解决的问题。
   *   2. 在店铺网段但电脑关机：lanOn 为 true 会放行（isOnStoreLan 只看 IP 前缀，
   *      跟后端活没活着无关），然后 POST 超时失败弹「记账失败」——
   *      用户填的那一笔**没有任何地方留底，直接丢了**。
   * 现在统一成和进货草稿一样的模型：先落本地 SQLite，联网后由 runSync 补推。
   */
  const save = () => {
    if (saving) return;
    if (total <= 0) {
      Alert.alert('至少填写一个收款渠道金额');
      return;
    }
    setSaving(true);
    try {
      // 后端 POST /api/revenue 按 custom1/custom2/custom3 三个固定键归一化
      // （server.js:650-654，再由 insertRevenue 映射到 agg_wechat/agg_alipay/custom3），
      // 所以这里必须用渠道自身的 key 提交，与网页端 payments 结构完全一致。
      // 草稿里原样存这份 payments，推送时直接透传，不做二次转换。
      const payments: Record<string, number> = {
        cash: num(cash),
        wechat: num(wechat),
        alipay: num(alipay),
      };
      customs.forEach((c) => {
        payments[c.key] = num(customAmounts[c.key] || '');
      });
      insertRevenueDraft({
        id: uuid(),
        date,
        payments: JSON.stringify(payments),
        total,
        note,
        deviceId: DEVICE_ID,
      });
    } catch (e: any) {
      // 写本机都失败属于真故障（存储满/库损坏），必须明确告知并**保持表单不关**，
      // 否则用户以为记下了，其实哪儿都没有。
      setSaving(false);
      Alert.alert('保存失败', `本机存储写入失败，请重试。${e?.message || ''}`);
      return;
    }
    setSaving(false);
    onSaved();
  };

  return (
    <View style={styles.root}>
      {/* 顶部安全区：本页是 App.tsx 的绝对定位 overlay，iOS 下拿不到根 SafeAreaRoot 的 inset */}
      <SafeAreaHeader style={styles.header}>
        <TouchableOpacity
          style={styles.headerBtn}
          onPress={onCancel}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          accessibilityRole="button"
        >
          <Text style={styles.back}>‹ 取消</Text>
        </TouchableOpacity>
        <Text style={styles.title}>记一笔营收</Text>
        <View style={{ width: 56 }} />
      </SafeAreaHeader>

      <ScrollView contentContainerStyle={styles.pad}>
        <Field label="日期">
          <DatePickerField value={date} onChange={setDate} title="营收日期" />
        </Field>
        <Field label="现金">
          <TextInput style={styles.input} value={cash} onChangeText={setCash} keyboardType="numeric" placeholder="0.00" placeholderTextColor={theme.color.textAppTertiary} />
        </Field>
        <Field label="微信">
          <TextInput style={styles.input} value={wechat} onChangeText={setWechat} keyboardType="numeric" placeholder="0.00" placeholderTextColor={theme.color.textAppTertiary} />
        </Field>
        <Field label="支付宝">
          <TextInput style={styles.input} value={alipay} onChangeText={setAlipay} keyboardType="numeric" placeholder="0.00" placeholderTextColor={theme.color.textAppTertiary} />
        </Field>
        {/* 自定义收款渠道：按网页端设置里「启用」的渠道动态渲染，名称随设置走 */}
        {customs.map((c) => (
          <Field key={c.key} label={c.name}>
            <TextInput
              style={styles.input}
              value={customAmounts[c.key] || ''}
              onChangeText={(v) => setCustomAmount(c.key, v)}
              keyboardType="numeric"
              placeholder="0.00"
              placeholderTextColor={theme.color.textAppTertiary}
            />
          </Field>
        ))}
        <Field label="备注">
          <TextInput style={styles.input} value={note} onChangeText={setNote} placeholder="可选" placeholderTextColor={theme.color.textAppTertiary} />
        </Field>

        <View style={styles.totalRow}>
          <Text style={styles.totalLabel}>合计</Text>
          <Text style={[styles.totalValue, { color: theme.color.income, fontFamily: theme.font.family.num }]}>¥{total.toFixed(2)}</Text>
        </View>

        {/* 明确告诉用户「这一笔已经稳了」：离线不再是拦路的错误态，只是同步晚一点 */}
        <Text style={styles.hint}>
          {lanOn
            ? '保存后先存本机，联网即自动同步到电脑'
            : '当前不在店铺网络：先存本机，回店联网后自动同步'}
        </Text>

        <TouchableOpacity style={[styles.save, saving && styles.saveDisabled]} onPress={save} disabled={saving}>
          <Text style={styles.saveText}>{saving ? '保存中…' : '保存营收'}</Text>
        </TouchableOpacity>
      </ScrollView>
    </View>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      {children}
    </View>
  );
}

const S = theme.size;
const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.color.bgApp },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    minHeight: S.controlLg,
    paddingHorizontal: theme.spaceScale[4],
    borderBottomWidth: 1, borderBottomColor: theme.color.borderApp,
  },
  headerBtn: { minHeight: S.tapMin, minWidth: 56, justifyContent: 'center' },
  back: { color: theme.color.primaryVivid, fontSize: theme.font.size.md },
  title: { fontSize: theme.font.sizeV4.h3, fontWeight: theme.font.weight.bold, color: theme.color.textApp },
  pad: { padding: theme.spaceScale[4] },
  field: { marginBottom: theme.spaceScale[4] },
  label: { fontSize: theme.font.sizeV4.caption, color: theme.color.textAppSecondary, marginBottom: theme.spaceScale[2] },
  input: {
    backgroundColor: theme.color.surfaceSunken, borderWidth: 1, borderColor: theme.color.borderApp,
    borderRadius: theme.radius.md, height: S.controlLg, paddingHorizontal: theme.spaceScale[4],
    color: theme.color.textApp, fontSize: theme.font.sizeV4.body, fontFamily: theme.font.family.num,
  },
  totalRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: theme.spaceScale[2], marginBottom: theme.spaceScale[4] },
  totalLabel: { fontSize: theme.font.sizeV4.body, color: theme.color.textAppSecondary },
  totalValue: { fontSize: theme.font.sizeV4.metric, fontWeight: theme.font.weight.semibold },
  hint: {
    fontSize: theme.font.sizeV4.caption,
    color: theme.color.textAppTertiary,
    marginBottom: theme.spaceScale[3],
  },
  save: { backgroundColor: theme.color.primary, borderRadius: theme.radius.lg, height: S.controlLg, alignItems: 'center', justifyContent: 'center' },
  saveDisabled: { opacity: 0.5 },
  saveText: { color: theme.color.ctaText, fontSize: theme.font.sizeV4.bodyLg, fontWeight: theme.font.weight.semibold },
});
