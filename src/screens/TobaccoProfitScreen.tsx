import React, { useState, useEffect, useCallback } from 'react';
import { StyleSheet, View, Text, ScrollView, TouchableOpacity, TextInput, ActivityIndicator, Alert } from 'react-native';
import { useTheme } from '../theme/ThemeProvider';
import { apiFetch } from '../api/client';
import { SafeAreaHeader } from '../components/SafeArea';

interface Props {
  baseUrl: string;
  onBack: () => void;
}

function fmtMoney(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '——';
  return `¥${Number(n).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export default function TobaccoProfitScreen({ baseUrl, onBack }: Props) {
  const { theme } = useTheme();
  const styles = makeStyles(theme);

  const [group, setGroup] = useState<'cigarette' | 'plan'>('cigarette');
  const [loading, setLoading] = useState(false);
  const [rows, setRows] = useState<any[]>([]);
  const [sum, setSum] = useState<any>(null);

  // 批次追溯
  const [kw, setKw] = useState('');
  const [batchLoading, setBatchLoading] = useState(false);
  const [batch, setBatch] = useState<any>(null);

  const loadSummary = useCallback(async () => {
    if (!baseUrl) return;
    setLoading(true);
    try {
      const res = await apiFetch(`${baseUrl}/api/tobacco/profit?group=${group}`);
      if (res.json && res.json.ok) {
        setSum(res.json.summary);
        setRows(res.json.list || []);
      } else {
        Alert.alert('加载失败', (res.json && res.json.error) || `状态码 ${res.status}`);
      }
    } catch (e: any) {
      Alert.alert('网络错误', e?.message || '无法连接店铺后端（确认电脑已开机、地址为 :3001）');
    } finally {
      setLoading(false);
    }
  }, [baseUrl, group]);

  useEffect(() => { loadSummary(); }, [loadSummary]);

  const loadBatch = async () => {
    if (!kw.trim()) { Alert.alert('提示', '请输入卷烟名'); return; }
    if (!baseUrl) return;
    setBatchLoading(true);
    try {
      const res = await apiFetch(`${baseUrl}/api/tobacco/sales/profit?cigarette=${encodeURIComponent(kw.trim())}`);
      if (res.json && res.json.ok) setBatch(res.json);
      else Alert.alert('查询失败', (res.json && res.json.error) || `状态码 ${res.status}`);
    } catch (e: any) {
      Alert.alert('网络错误', e?.message || '无法连接店铺后端');
    } finally {
      setBatchLoading(false);
    }
  };

  return (
    <View style={styles.root}>
      <SafeAreaHeader style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={onBack} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <Text style={styles.backText}>‹ 我的</Text>
        </TouchableOpacity>
        <Text style={styles.title}>烟草利润</Text>
        <View style={styles.spacer} />
      </SafeAreaHeader>

      <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
        {/* KPI */}
        <View style={styles.kpiRow}>
          <View style={[styles.kpi, { borderColor: theme.color.success }]}>
            <Text style={styles.kpiVal}>{fmtMoney(sum?.totalProfit)}</Text>
            <Text style={styles.kpiLabel}>总利润</Text>
          </View>
          <View style={styles.kpi}>
            <Text style={styles.kpiVal}>{sum?.totalQty ?? 0}</Text>
            <Text style={styles.kpiLabel}>总条数</Text>
          </View>
          <View style={styles.kpi}>
            <Text style={styles.kpiVal}>{sum?.groups ?? 0}</Text>
            <Text style={styles.kpiLabel}>分组数</Text>
          </View>
        </View>

        {/* 维度切换 */}
        <View style={styles.seg}>
          <TouchableOpacity style={[styles.segBtn, group === 'cigarette' && styles.segActive]} onPress={() => setGroup('cigarette')}>
            <Text style={[styles.segText, group === 'cigarette' && styles.segTextActive]}>按卷烟</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.segBtn, group === 'plan' && styles.segActive]} onPress={() => setGroup('plan')}>
            <Text style={[styles.segText, group === 'plan' && styles.segTextActive]}>按方案</Text>
          </TouchableOpacity>
        </View>

        {loading ? (
          <ActivityIndicator style={{ marginVertical: 24 }} color={theme.color.primaryVivid} />
        ) : rows.length === 0 ? (
          <Text style={styles.empty}>暂无出货利润数据</Text>
        ) : (
          rows.map((r, i) => (
            <View key={i} style={styles.row}>
              <View style={{ flex: 1 }}>
                <Text style={styles.rowName}>{r.cigarette_name || r.plan_name}</Text>
                <Text style={styles.rowSub}>{r.item_type === 'gift' ? '奖励' : '主订'} · 出货 {r.qty} 条</Text>
              </View>
              <View style={{ alignItems: 'flex-end' }}>
                <Text style={[styles.rowProfit, { color: theme.color.success }]}>{fmtMoney(r.profit)}</Text>
                <Text style={styles.rowSub}>{fmtMoney(r.revenue)}</Text>
              </View>
            </View>
          ))
        )}

        {/* 批次追溯 */}
        <Text style={styles.section}>按卷烟追溯批次</Text>
        <View style={styles.searchRow}>
          <TextInput
            style={styles.input}
            value={kw}
            onChangeText={setKw}
            placeholder="输入卷烟名"
            autoCapitalize="none"
            autoCorrect={false}
          />
          <TouchableOpacity style={styles.searchBtn} onPress={loadBatch} disabled={batchLoading}>
            <Text style={styles.searchBtnText}>查询</Text>
          </TouchableOpacity>
        </View>
        {batchLoading ? (
          <ActivityIndicator style={{ marginVertical: 16 }} color={theme.color.primaryVivid} />
        ) : batch ? (
          <View style={styles.card}>
            <Text style={styles.rowSub}>出货 {batch.summary.sale_cnt} 笔 · {batch.summary.qty} 条 · 利润 {fmtMoney(batch.summary.profit)}</Text>
            {batch.list.length === 0 ? (
              <Text style={styles.empty}>该卷烟暂无出货记录</Text>
            ) : (
              batch.list.map((s: any) => (
                <View key={s.sale_id} style={styles.row}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.rowName}>{s.cigarette_name}</Text>
                    <Text style={styles.rowSub}>{s.order_no} · {s.sale_date?.slice(0, 10)} · 压货 {s.hold_days ?? '—'}天</Text>
                  </View>
                  <View style={{ alignItems: 'flex-end' }}>
                    <Text style={[styles.rowProfit, { color: theme.color.success }]}>{fmtMoney(s.profit)}</Text>
                    <Text style={styles.rowSub}>{s.qty}条 · {fmtMoney(s.unit_price)}</Text>
                  </View>
                </View>
              ))
            )}
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}

function makeStyles(theme: any) {
  const S = theme.size;
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: theme.color.bgApp },
    header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: theme.spaceScale[4], paddingVertical: theme.spaceScale[3], borderBottomWidth: 1, borderBottomColor: theme.color.dividerApp, backgroundColor: theme.color.surfaceApp },
    backBtn: { minHeight: 44, justifyContent: 'center' },
    backText: { fontSize: theme.font.sizeV4.body, color: theme.color.textAppSecondary },
    title: { fontSize: theme.font.sizeV4.h4, fontWeight: theme.font.weight.semibold, color: theme.color.textApp },
    spacer: { width: 56 },
    scroll: { flex: 1 },
    content: { padding: theme.spaceScale[4], paddingBottom: 40 },
    kpiRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: theme.spaceScale[4] },
    kpi: { flex: 1, marginHorizontal: 4, backgroundColor: theme.color.surfaceApp, borderRadius: theme.radius.lg, padding: theme.spaceScale[3], borderWidth: 1, borderColor: theme.color.dividerApp, alignItems: 'center' },
    kpiVal: { fontSize: theme.font.sizeV4.h3, fontWeight: theme.font.weight.bold, color: theme.color.textApp, fontFamily: theme.font.family.num },
    kpiLabel: { fontSize: theme.font.sizeV4.caption, color: theme.color.textAppTertiary, marginTop: 2 },
    seg: { flexDirection: 'row', backgroundColor: theme.color.surfaceSunken, borderRadius: theme.radius.md, padding: 3, marginBottom: theme.spaceScale[4] },
    segBtn: { flex: 1, alignItems: 'center', paddingVertical: theme.spaceScale[2], borderRadius: theme.radius.sm },
    segActive: { backgroundColor: theme.color.surfaceApp },
    segText: { fontSize: theme.font.sizeV4.body, color: theme.color.textAppSecondary },
    segTextActive: { color: theme.color.textApp, fontWeight: theme.font.weight.semibold },
    row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: theme.color.surfaceApp, borderRadius: theme.radius.lg, padding: theme.spaceScale[3], marginBottom: theme.spaceScale[2] },
    rowName: { fontSize: theme.font.sizeV4.body, color: theme.color.textApp, fontWeight: theme.font.weight.medium },
    rowSub: { fontSize: theme.font.sizeV4.caption, color: theme.color.textAppTertiary, marginTop: 2 },
    rowProfit: { fontSize: theme.font.sizeV4.body, fontWeight: theme.font.weight.semibold, fontFamily: theme.font.family.num },
    empty: { fontSize: theme.font.sizeV4.bodySm, color: theme.color.textAppTertiary, textAlign: 'center', marginVertical: 16 },
    section: { fontSize: theme.font.sizeV4.h4, fontWeight: theme.font.weight.semibold, color: theme.color.textApp, marginTop: theme.spaceScale[4], marginBottom: theme.spaceScale[3] },
    searchRow: { flexDirection: 'row', alignItems: 'center' },
    input: { flex: 1, backgroundColor: theme.color.surfaceSunken, borderWidth: 1, borderColor: theme.color.borderApp, borderRadius: theme.radius.md, height: S.controlLg, paddingHorizontal: theme.spaceScale[4], color: theme.color.textApp, fontSize: theme.font.sizeV4.body, fontFamily: theme.font.family.num },
    searchBtn: { marginLeft: theme.spaceScale[2], backgroundColor: theme.color.primaryVivid, borderRadius: theme.radius.md, paddingVertical: theme.spaceScale[2], paddingHorizontal: theme.spaceScale[4] },
    searchBtnText: { color: '#fff', fontSize: theme.font.sizeV4.body, fontWeight: theme.font.weight.medium },
    card: { backgroundColor: theme.color.surfaceApp, borderRadius: theme.radius.lg, padding: theme.spaceScale[3], marginTop: theme.spaceScale[2] },
  });
}
