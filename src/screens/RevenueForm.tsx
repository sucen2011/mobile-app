import React, { useState, useEffect, useRef } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, ScrollView, Alert } from 'react-native';
import { useTheme } from '../theme/ThemeProvider';
import { toLocalDateStr } from '../utils/dateLabel';
import DatePickerField from '../components/DatePickerField';
import { SafeAreaHeader } from '../components/SafeArea';
import { fetchCustomChannels, type CustomChannel } from '../api/settings';
import {
  getEnabledCustomChannels,
  setCachedCustomChannels,
  insertRevenueDraft,
  updateRevenueDraft,
  getRevenueDraftById,
  getRevenueStash,
  setRevenueStash,
  type RevenueDraft,
} from '../db/localDb';
import { DEVICE_ID } from '../config';

interface Props {
  baseUrl: string;
  lanOn: boolean;
  // 编辑既有营收草稿（Phase 4 接入编辑回填；此处先声明以对齐 App 传参契约）
  editId?: string;
  onSaved: () => void;
  onCancel: () => void;
}

function uuid() {
  return 'r_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export default function RevenueForm({ baseUrl, lanOn, editId, onSaved, onCancel }: Props) {
  const { theme } = useTheme();
  const styles = makeStyles(theme);
  const [date, setDate] = useState(toLocalDateStr(new Date()));
  const [cash, setCash] = useState('');
  const [wechat, setWechat] = useState('');
  const [alipay, setAlipay] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [stashAt, setStashAt] = useState<number | null>(null);
  // 编辑模式下留存原草稿：保存时用于保留"当前已禁用的自定义渠道"金额，避免被静默丢弃
  const editDraftRef = useRef<RevenueDraft | null>(null);

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

  // 回填：打开录入页时根据模式自动填回。
  // - 编辑模式（editId）：从 revenue_drafts 读出该草稿，填回各字段 + 自定义渠道金额；
  //   customs 异步回来渲染时 customAmounts 已就位，无需等它。
  // - 新增模式：若有上次暂存则填回暂存，并显示草稿提示。
  // 两种模式互斥：编辑不读暂存、暂存也不进编辑态，避免互相覆盖。
  useEffect(() => {
    if (editId) {
      const d = getRevenueDraftById(editId);
      if (d) {
        editDraftRef.current = d; // 留存原草稿，保存时保留已禁用的自定义渠道金额
        const p = parsePayments(d.payments);
        setDate(d.date);
        setCash(numToStr(p.cash));
        setWechat(numToStr(p.wechat));
        setAlipay(numToStr(p.alipay));
        const custom: Record<string, string> = {};
        Object.keys(p).forEach((k) => {
          if (k === 'cash' || k === 'wechat' || k === 'alipay') return;
          custom[k] = numToStr(p[k]);
        });
        setCustomAmounts(custom);
        setNote(d.note || '');
      }
      return;
    }
    // 新增模式：回填上次暂存
    const s = getRevenueStash();
    if (!s) return;
    setDate(s.date);
    setCash(s.cash);
    setWechat(s.wechat);
    setAlipay(s.alipay);
    setCustomAmounts(s.customAmounts || {});
    setNote(s.note);
    setStashAt(s.savedAt);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

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
  const clearStash = () => {
    setRevenueStash(null);
    setStashAt(null);
    setDate(toLocalDateStr(new Date()));
    setCash('');
    setWechat('');
    setAlipay('');
    setCustomAmounts({});
    setNote('');
  };

  const stashDraft = () => {
    setRevenueStash({
      date,
      cash,
      wechat,
      alipay,
      customAmounts,
      note,
      savedAt: Date.now(),
    });
    setStashAt(Date.now());
  };

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
      // 编辑模式：保留草稿里"当前已禁用的自定义渠道"金额，避免被静默丢弃
      // （表单里没有它的输入框，但原草稿可能记过，丢掉就等于改账）。
      if (editId && editDraftRef.current) {
        const orig = parsePayments(editDraftRef.current.payments);
        Object.keys(orig).forEach((k) => {
          if (k === 'cash' || k === 'wechat' || k === 'alipay') return;
          if (payments[k] === undefined) payments[k] = num(String(orig[k]));
        });
      }
      customs.forEach((c) => {
        payments[c.key] = num(customAmounts[c.key] || '');
      });
      if (editId) {
        // 原地更新，保留 id 与 status（pending 继续待同步 / synced 不重推，避免重复记账）
        updateRevenueDraft(editId, {
          date,
          payments: JSON.stringify(payments),
          total,
          note,
        });
      } else {
        insertRevenueDraft({
          id: uuid(),
          date,
          payments: JSON.stringify(payments),
          total,
          note,
          deviceId: DEVICE_ID,
        });
      }
    } catch (e: any) {
      // 写本机都失败属于真故障（存储满/库损坏），必须明确告知并**保持表单不关**，
      // 否则用户以为记下了，其实哪儿都没有。
      setSaving(false);
      Alert.alert('保存失败', `本机存储写入失败，请重试。${e?.message || ''}`);
      return;
    }
    setSaving(false);
    setRevenueStash(null);
    setStashAt(null);
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
        <Text style={styles.title}>{editId ? '编辑营收草稿' : '记一笔营收'}</Text>
        <View style={{ width: 56 }} />
      </SafeAreaHeader>

      <ScrollView contentContainerStyle={styles.pad}>
        {stashAt != null && (
          <View style={styles.stashBar}>
            <Text style={styles.stashBarText}>📝 已暂存草稿（{fmtTime(stashAt)}），仅存本机，点"保存营收"才上传</Text>
            <TouchableOpacity onPress={clearStash} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Text style={styles.stashClear}>清除</Text>
            </TouchableOpacity>
          </View>
        )}
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

        {!editId && (
          <TouchableOpacity style={styles.stashBtn} onPress={stashDraft} disabled={saving}>
            <Text style={styles.stashText}>暂存（先存本机，不上传）</Text>
          </TouchableOpacity>
        )}

        <TouchableOpacity style={[styles.save, saving && styles.saveDisabled]} onPress={save} disabled={saving}>
          <Text style={styles.saveText}>{saving ? '保存中…' : '保存营收'}</Text>
        </TouchableOpacity>
      </ScrollView>
    </View>
  );
}

function fmtTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}月${d.getDate()}日 ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function parsePayments(raw: string): Record<string, number> {
  try {
    const p = JSON.parse(raw);
    return p && typeof p === 'object' && !Array.isArray(p) ? (p as Record<string, number>) : {};
  } catch {
    return {};
  }
}

/** 数值 → 字符串（金额输入框用），非法值退回 '0' */
function numToStr(v: unknown): string {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? '0'));
  return Number.isFinite(n) ? String(n) : '0';
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  const { theme } = useTheme();
  const styles = makeStyles(theme);
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      {children}
    </View>
  );
}

function makeStyles(theme: any) {
  const S = theme.size;
  return StyleSheet.create({
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
  stashBar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: theme.color.surfaceSunken, borderRadius: theme.radius.md,
    paddingVertical: theme.spaceScale[2], paddingHorizontal: theme.spaceScale[3],
    marginBottom: theme.spaceScale[3],
  },
  stashBarText: { flex: 1, fontSize: theme.font.sizeV4.caption, color: theme.color.textAppSecondary },
  stashClear: { color: theme.color.primaryVivid, fontSize: theme.font.sizeV4.caption, marginLeft: theme.spaceScale[3] },
  stashBtn: {
    backgroundColor: theme.color.surfaceApp, borderWidth: 1, borderColor: theme.color.borderApp,
    borderRadius: theme.radius.lg, height: S.controlLg, alignItems: 'center', justifyContent: 'center',
    marginBottom: theme.spaceScale[3],
  },
  stashText: { color: theme.color.textApp, fontSize: theme.font.sizeV4.bodyLg, fontWeight: theme.font.weight.semibold },
});
}
