import React, { useState, useEffect, useCallback } from 'react';
import { StyleSheet, View, Text, ScrollView, TouchableOpacity, ActivityIndicator, Alert } from 'react-native';
import { useTheme } from '../theme/ThemeProvider';
import { apiFetch } from '../api/client';
import { SafeAreaHeader } from '../components/SafeArea';

interface Props {
  baseUrl: string;
  onBack: () => void;
}

export default function TobaccoTrackingScreen({ baseUrl, onBack }: Props) {
  const { theme } = useTheme();
  const styles = makeStyles(theme);

  const [type, setType] = useState<'all' | 'gift' | 'order'>('all');
  const [loading, setLoading] = useState(false);
  const [sum, setSum] = useState<any>(null);
  const [rows, setRows] = useState<any[]>([]);

  const load = useCallback(async () => {
    if (!baseUrl) return;
    setLoading(true);
    try {
      const res = await apiFetch(`${baseUrl}/api/tobacco/tracking?type=${type}`);
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
  }, [baseUrl, type]);

  useEffect(() => { load(); }, [load]);

  return (
    <View style={styles.root}>
      <SafeAreaHeader style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={onBack} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <Text style={styles.backText}>‹ 我的</Text>
        </TouchableOpacity>
        <Text style={styles.title}>到货跟踪</Text>
        <View style={styles.spacer} />
      </SafeAreaHeader>

      <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
        {/* KPI */}
        <View style={styles.kpiRow}>
          <View style={styles.kpi}>
            <Text style={styles.kpiVal}>{sum?.pending_item_cnt ?? 0}</Text>
            <Text style={styles.kpiLabel}>未到条目</Text>
          </View>
          <View style={styles.kpi}>
            <Text style={styles.kpiVal}>{sum?.pending_qty ?? 0}</Text>
            <Text style={styles.kpiLabel}>未到条数</Text>
          </View>
          <View style={[styles.kpi, { borderColor: theme.color.danger }]}>
            <Text style={[styles.kpiVal, { color: theme.color.danger }]}>{sum?.urgent_cnt ?? 0}</Text>
            <Text style={styles.kpiLabel}>超7天</Text>
          </View>
        </View>

        {/* 类型切换 */}
        <View style={styles.seg}>
          {(['all', 'gift', 'order'] as const).map((t) => (
            <TouchableOpacity key={t} style={[styles.segBtn, type === t && styles.segActive]} onPress={() => setType(t)}>
              <Text style={[styles.segText, type === t && styles.segTextActive]}>
                {t === 'all' ? '全部' : t === 'gift' ? '仅奖励' : '仅主订'}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        {loading ? (
          <ActivityIndicator style={{ marginVertical: 24 }} color={theme.color.primaryVivid} />
        ) : rows.length === 0 ? (
          <Text style={styles.empty}>没有未到货的明细</Text>
        ) : (
          rows.map((r) => (
            <View key={r.order_item_id} style={styles.row}>
              <View style={{ flex: 1 }}>
                <Text style={styles.rowName}>{r.cigarette_name}</Text>
                <Text style={styles.rowSub}>
                  {r.group_name || r.plan_name} / {r.tier_name || r.tier_no || '—'} · {r.order_no}
                </Text>
                <Text style={styles.rowSub}>
                  订 {r.qty} / 到 {r.arrived_qty} / 未 {r.pending_qty} · 未到 {r.age_days ?? '—'}天
                </Text>
              </View>
              <View style={[styles.badge, r.urgent ? styles.badgeUrgent : (r.status === 'partial' ? styles.badgePartial : styles.badgeNone)]}>
                <Text style={styles.badgeText}>{r.urgent ? '催货' : r.status === 'partial' ? '部分' : '未到'}</Text>
              </View>
            </View>
          ))
        )}
        <Text style={styles.hint}>到货登记请在电脑端「订货执行」页完成。本页仅查看未到齐明细。</Text>
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
    badge: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 10 },
    badgeText: { fontSize: theme.font.sizeV4.caption, color: '#fff', fontWeight: theme.font.weight.medium },
    badgeUrgent: { backgroundColor: theme.color.danger },
    badgePartial: { backgroundColor: theme.color.warning },
    badgeNone: { backgroundColor: theme.color.textAppTertiary },
    empty: { fontSize: theme.font.sizeV4.bodySm, color: theme.color.textAppTertiary, textAlign: 'center', marginVertical: 16 },
    hint: { fontSize: theme.font.sizeV4.caption, color: theme.color.textAppTertiary, lineHeight: 18, marginTop: theme.spaceScale[3] },
  });
}
