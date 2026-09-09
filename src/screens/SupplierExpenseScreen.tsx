import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, ScrollView, StyleSheet, TouchableOpacity, Alert, TextInput,
  Switch, Modal, Image, RefreshControl, Share, ActivityIndicator, Platform,
} from 'react-native';
import dayjs from 'dayjs';
// ⚠️ 必须从 expo-file-system/legacy 导入：SDK 54+ 主入口的 writeAsStringAsync 是调用即 throw 的弃用桩
import * as FileSystem from 'expo-file-system/legacy';
import { CameraView, useCameraPermissions, type CameraType } from 'expo-camera';
import { useTheme } from '../theme/ThemeProvider';
import { SafeAreaHeader } from '../components/SafeArea';
import DatePickerField from '../components/DatePickerField';
import {
  fetchExpenses, getExpenseDetail, fetchExpenseSummary, createExpense, updateExpense, settleExpense,
  deleteExpense, reverseExpense, uploadExpenseImage, fetchExpenseBrands,
  EXPENSE_TYPE_LABEL, SETTLE_METHOD_LABEL, REBATE_CYCLE_LABEL, PAYMENT_LABEL, SETTLEMENT_TIMING_LABEL, DISPOSAL_STATUS_LABEL,
  isRebateLikeExpense,
  type SupplierExpense, type ExpenseDetail, type ExpenseSummary,
  type ExpenseType, type SettleMethod, type SettlementTiming, type PaymentMethod, type ExpenseStatus, type RebateCycle, type ExpenseImageDraft,
  type PlanPeriod, type ConsignItem, type ReturnItem,
} from '../api/supplierExpense';
import { fetchSuppliers } from '../api/suppliers';
import { listSuppliers, listProducts } from '../db/localDb';
import type { Product } from '../db/localDb';

interface Props {
  baseUrl: string;
  onBack: () => void;
}

type ViewKey = 'list' | 'form' | 'detail';
type TypeFilter = '' | '1' | '2' | '3';

function todayStr(): string {
  const d = new Date();
  const m = `${d.getMonth() + 1}`.padStart(2, '0');
  const day = `${d.getDate()}`.padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

const MONTH_OPTIONS = Array.from({ length: 12 }, (_, i) => i + 1);

function money(n: number): string {
  return `¥${Number(n || 0).toFixed(2)}`;
}
function round(n: number): number {
  return Math.round(Number(n) || 0);
}
function statusLabel(s: ExpenseStatus): string {
  return s === 2 ? '已结清' : s === 1 ? '部分结算' : '待结算';
}
function toAbsoluteUrl(baseUrl: string, url: string): string {
  if (!url) return '';
  if (/^https?:\/\//i.test(url)) return url;
  return `${baseUrl.replace(/\/$/, '')}${url.startsWith('/') ? url : `/${url}`}`;
}

// 返货周期 step（月）：与 PC buildRebatePlan 对齐
const REBATE_STEP_MONTHS: Record<number, number> = { 1: 1, 2: 12, 3: 3, 4: 0 };

function addMonths(dateStr: string, n: number): string {
  if (!dateStr) return '';
  const d = new Date(`${dateStr}T00:00:00`);
  if (isNaN(d.getTime())) return dateStr;
  const baseY = d.getFullYear();
  const baseM = d.getMonth() + n;
  const ny = baseY + Math.floor(baseM / 12);
  const nm = ((baseM % 12) + 12) % 12;
  const nd = Math.min(d.getDate(), new Date(ny, nm + 1, 0).getDate());
  const mm = `${nm + 1}`.padStart(2, '0');
  const dd = `${nd}`.padStart(2, '0');
  return `${ny}-${mm}-${dd}`;
}

export interface RebatePeriod {
  seq: number;
  planDate: string;
  planQty: number;
  settled: boolean;
  remark: string;
  images?: { url: string }[];
}

// 由 返货 协议字段生成虚拟期次（与 PC DetailDrawer.buildRebatePlan 逻辑一致）
// settlements 用于把每一期的「备注 + 凭证图片」挂到对应期次卡片上（按 rebate_seq 关联），三端一致
function buildRebatePeriods(e: any, settlements: any[] = []): RebatePeriod[] {
  if (!e || !isRebateLikeExpense(e)) return [];
  const { rebateStartDate, rebateCycle, rebateQty, rebateTotalPeriods, settledAmount, nextRebateDate, rebateSettledPeriods } = e;
  if (!rebateStartDate || !rebateQty) return [];
  const stepMonths = REBATE_STEP_MONTHS[rebateCycle] || 0;
  // 已确认期次来自 rebateSettledPeriods（数组）；老数据回退按 settledAmount 视为 1..N（与 PC 一致）
  const settledSeqs: number[] = Array.isArray(rebateSettledPeriods)
    ? rebateSettledPeriods.map(Number).filter((n: number) => n >= 1)
    : ((Math.round(Number(settledAmount) || 0) > 0)
        ? Array.from({ length: Math.round(Number(settledAmount) || 0) }, (_: any, i: number) => i + 1)
        : []);
  // 每期对应一笔 is_rebate=1 且非冲正的结算（取最新一笔），用于回显备注与凭证
  const settleBySeq = new Map<number, any>();
  (settlements || []).forEach((s: any) => {
    if (!s.isRebate || s.isReversal) return;
    const seq = Number(s.rebateSeq) || 0;
    if (!seq) return;
    settleBySeq.set(seq, s);
  });
  const total = Number(rebateTotalPeriods) || 0;
  // 固定周期：生成全部期次；不限期数（长期有效）：展示 已收 + 全部逾期 + 下一期待结，
  // 即向后推到包含首个未到期（待结）期为止；自定义周期不推断未来日期，仅保留已收+下一期。
  let count: number;
  if (total > 0) {
    count = total;
  } else {
    const maxSettled = settledSeqs.length ? Math.max.apply(null, settledSeqs) : 0;
    count = maxSettled + 1;
    if (stepMonths > 0) {
      const today = todayStr();
      for (let guard = 0; guard < 200; guard++) {
        const idx = count - 1;
        const d = addMonths(rebateStartDate, idx * stepMonths);
        if (d && d < today) count++; else break;
      }
    }
  }
  const rows: RebatePeriod[] = [];
  for (let i = 0; i < count; i++) {
    const seq = i + 1;
    const isSettled = settledSeqs.indexOf(seq) >= 0;
    let planDate: string;
    if (stepMonths > 0) planDate = addMonths(rebateStartDate, i * stepMonths);
    else if (i === 0) planDate = rebateStartDate;
    else if (nextRebateDate) planDate = nextRebateDate;
    else planDate = '';
    const seqSettle = settleBySeq.get(seq);
    rows.push({
      seq,
      planDate,
      planQty: Number(rebateQty) || 0,
      settled: isSettled,
      remark: seqSettle?.remark || '',
      images: (seqSettle?.images || []).map((im: any) => ({ url: im.imageUrl })),
    });
  }
  return rows;
}

export default function SupplierExpenseScreen({ baseUrl, onBack }: Props) {
  const { theme } = useTheme();
  const styles = makeStyles(theme);

  const [view, setView] = useState<ViewKey>('list');
  const [refreshing, setRefreshing] = useState(false);

  const [summary, setSummary] = useState<ExpenseSummary>({ totalCount: 0, totalAmount: 0, settledAmount: 0, unsettledAmount: 0, pendingCount: 0, overdueCount: 0, overdueAmount: 0 });
  const [list, setList] = useState<SupplierExpense[]>([]);
  const [keyword, setKeyword] = useState('');
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('');
  const [onlyOverdue, setOnlyOverdue] = useState(false);
  const [brandFilter, setBrandFilter] = useState('');
  const [brandOptions, setBrandOptions] = useState<string[]>([]);

  const [detailId, setDetailId] = useState<number | null>(null);
  const [detail, setDetail] = useState<ExpenseDetail | null>(null);

  const [settleTarget, setSettleTarget] = useState<SupplierExpense | null>(null);
  const [settleTargetSettlements, setSettleTargetSettlements] = useState<any[]>([]); // 确认收货期次明细回显用
  const [settlePlanSeq, setSettlePlanSeq] = useState<number | null>(null); // 从详情「结算本期/补交本期」带入期次
  const [editingTarget, setEditingTarget] = useState<SupplierExpense | null>(null);
  const [editingImages, setEditingImages] = useState<string[]>([]);
  const [reverseTarget, setReverseTarget] = useState<SupplierExpense | null>(null);

  const loadAll = useCallback(async () => {
    const params: any = {};
    if (keyword.trim()) params.keyword = keyword.trim();
    if (typeFilter) params.expenseType = Number(typeFilter);
    if (onlyOverdue) params.overdue = 1;
    if (brandFilter) params.brand = brandFilter;
    const [s, l] = await Promise.all([
      fetchExpenseSummary(baseUrl, params),
      fetchExpenses(baseUrl, params),
    ]);
    setSummary(s);
    setList(Array.isArray(l) ? l : []);
  }, [baseUrl, keyword, typeFilter, onlyOverdue, brandFilter]);

  // 品牌筛选选项（按当前关键词/类型刷新后前端的去重品牌，轻量；后端支持精确 brand 过滤）
  useEffect(() => {
    (async () => {
      try {
        const brands = await fetchExpenseBrands(baseUrl);
        setBrandOptions(Array.isArray(brands) ? brands : []);
      } catch { /* 离线静默 */ }
    })();
  }, [baseUrl]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try { await loadAll(); } catch (e: any) {
        if (alive) Alert.alert('加载失败', e?.message || '请确认已连接店铺服务器（连店铺 WiFi）');
      }
    })();
    return () => { alive = false; };
  }, [loadAll]);

  const onRefresh = async () => {
    setRefreshing(true);
    try { await loadAll(); } catch (e: any) { /* 静默 */ }
    finally { setRefreshing(false); }
  };

  const openDetail = async (id: number) => {
    setDetailId(id);
    setDetail(null);
    setView('detail');
    try {
      const d = await getExpenseDetail(baseUrl, id);
      if (d) setDetail(d);
    } catch (e: any) { Alert.alert('详情加载失败', e?.message || ''); }
  };

  const backToList = () => {
    setView('list');
    setDetailId(null);
    setDetail(null);
    setEditingTarget(null);
    setEditingImages([]);
    setReverseTarget(null);
    setSettlePlanSeq(null);
    void loadAll();
  };

  // 从详情计划卡「结算本期 / 补交本期」进入：带期次打开结算弹窗
  const handleSettlePeriod = (exp: SupplierExpense, seq: number) => {
    setSettlePlanSeq(seq);
    setSettleTarget(exp);
  };

  const showItemActions = (e: SupplierExpense) => {
    Alert.alert(
      `${e.expenseNo}`,
      `${e.supplierName} · ${e.expenseType === 2 ? `每期 ${e.rebateQty}${e.rebateUnit || '件'}` : e.expenseType === 3 ? `铺货货值 ¥${e.consignTotalValue ?? 0}` : money(e.totalAmount)}`,
      [
        { text: '编辑', onPress: () => startEdit(e) },
        { text: '删除', style: 'destructive', onPress: () => confirmDelete(e) },
        { text: '取消', style: 'cancel' },
      ]
    );
  };

  const startEdit = async (e: SupplierExpense) => {
    let imgs: string[] = [];
    try {
      const d = await getExpenseDetail(baseUrl, e.id);
      imgs = (d?.images || []).map((im) => im.imageUrl);
    } catch { /* 离线时直接进编辑，图片留空 */ }
    setEditingTarget(e);
    setEditingImages(imgs);
    setView('form');
  };

  const confirmDelete = (e: SupplierExpense) => {
    Alert.alert('确认删除？', `删除 ${e.expenseNo}，此操作不可恢复`, [
      { text: '取消', style: 'cancel' },
      { text: '删除', style: 'destructive', onPress: async () => {
        try { await deleteExpense(baseUrl, e); Alert.alert('已删除'); void loadAll(); }
        catch (err: any) { Alert.alert('删除失败', err?.message || ''); }
      }},
    ]);
  };

  // 品牌汇总：基于当前筛选结果（list）本地聚合，返货单不计金额
  const brandAgg = buildBrandAgg(list);
  const [exporting, setExporting] = useState(false);
  const onExportCsv = async () => {
    if (list.length === 0) { Alert.alert('无可导出数据', '当前筛选结果为空，换个筛选条件再导出。'); return; }
    setExporting(true);
    try {
      const r = await exportExpenseCsv(list);
      Alert.alert('导出成功', `共 ${r.count} 条费用单（含品牌列）。${r.hint}`);
    } catch (err: any) {
      if (String(err?.message || '').startsWith('已取消')) return; // 用户主动取消，不打扰
      Alert.alert('导出失败', err?.message || '写入文件失败，请检查手机存储空间与权限。');
    } finally { setExporting(false); }
  };

  // ============ 列表视图 ============
  if (view === 'list') {
    return (
      <View style={styles.root}>
        <SafeAreaHeader style={styles.header}>
          <TouchableOpacity style={styles.backBtn} onPress={onBack} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <Text style={styles.backText}>‹ 我的</Text>
          </TouchableOpacity>
          <Text style={styles.headerTitle}>陈列费用</Text>
          <TouchableOpacity style={styles.addTopBtn} onPress={() => setView('form')}>
            <Text style={styles.addTopBtnText}>＋ 登记</Text>
          </TouchableOpacity>
        </SafeAreaHeader>

        <ScrollView style={styles.body} contentContainerStyle={styles.content}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}>

          {/* 统计卡 */}
          <View style={styles.statGrid}>
            <StatCell label="总应收" value={money(summary.totalAmount)} />
            <StatCell label="已收" value={money(summary.settledAmount)} valueColor={theme.color.success} />
            <StatCell label="未收" value={money(summary.unsettledAmount)} valueColor={theme.color.warning} />
            <StatCell label="逾期" value={`${summary.overdueCount} 笔`} valueColor={theme.color.danger} />
          </View>

          {/* 导出 + 品牌汇总：均吃当前筛选结果 */}
          <View style={styles.exportRow}>
            <Text style={styles.exportHint}>当前筛选共 {list.length} 笔</Text>
            <TouchableOpacity style={styles.exportBtn} onPress={onExportCsv} disabled={exporting} activeOpacity={0.7}>
              {exporting
                ? <ActivityIndicator size="small" color={theme.color.primaryVivid} />
                : <Text style={styles.exportBtnText}>导出 CSV</Text>}
            </TouchableOpacity>
          </View>

          {brandAgg.length > 0 ? (
            <View style={styles.brandCard}>
              <Text style={styles.brandCardTitle}>品牌汇总（{brandAgg.length}）</Text>
              <Text style={styles.brandCardSub}>按当前筛选结果统计 · 返货不计金额</Text>
              {brandAgg.map((b, i) => (
                <View key={b.brand} style={[styles.brandRow, i > 0 && styles.brandRowBorder]}>
                  <View style={styles.brandRowHead}>
                    <Text style={styles.brandName} numberOfLines={1}>{b.label}</Text>
                    <Text style={styles.brandCount}>
                      {b.count} 笔{b.rebateCount > 0 ? `（返货 ${b.rebateCount}）` : ''}
                    </Text>
                  </View>
                  <View style={styles.brandRowNums}>
                    <Text style={styles.brandNumTotal}>总额 {money(b.total)}</Text>
                    <Text style={styles.brandNumOk}>已结 {money(b.settled)}</Text>
                    <Text style={[styles.brandNumLeft, b.unsettled > 0 && { color: theme.color.danger }]}>
                      未结 {money(b.unsettled)}
                    </Text>
                    {b.overdue > 0 ? <Text style={styles.brandNumOverdue}>逾期 {b.overdue}</Text> : null}
                  </View>
                </View>
              ))}
            </View>
          ) : null}

          {/* 筛选 */}
          <View style={styles.filterCard}>
            <TextInput
              style={styles.searchInput}
              value={keyword}
              onChangeText={setKeyword}
              placeholder="搜索供应商 / 单号 / 项目"
              placeholderTextColor={theme.color.textAppTertiary}
            />
            <View style={styles.segRow}>
              {([{ k: '', t: '全部' }, { k: '1', t: '返钱' }, { k: '2', t: '返货' }, { k: '3', t: '寄售' }] as { k: TypeFilter; t: string }[]).map((o) => (
                <TouchableOpacity key={o.k} style={[styles.segBtn, typeFilter === o.k && styles.segBtnActive]} onPress={() => setTypeFilter(o.k)}>
                  <Text style={[styles.segBtnText, typeFilter === o.k && styles.segBtnTextActive]}>{o.t}</Text>
                </TouchableOpacity>
              ))}
            </View>
            <View style={styles.switchRow}>
              <Text style={styles.switchLabel}>仅看逾期</Text>
              <Switch value={onlyOverdue} onValueChange={setOnlyOverdue} thumbColor={onlyOverdue ? theme.color.primaryVivid : undefined} />
            </View>
            {brandOptions.length > 0 ? (
              <View style={styles.brandFilterRow}>
                <Text style={styles.brandFilterLabel}>品牌</Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.brandChipScroll}>
                  <TouchableOpacity key="__all" style={[styles.brandChip, !brandFilter && styles.brandChipActive]} onPress={() => setBrandFilter('')}>
                    <Text style={[styles.brandChipText, !brandFilter && styles.brandChipTextActive]}>全部</Text>
                  </TouchableOpacity>
                  {brandOptions.map((b) => (
                    <TouchableOpacity key={b} style={[styles.brandChip, brandFilter === b && styles.brandChipActive]} onPress={() => setBrandFilter(brandFilter === b ? '' : b)}>
                      <Text style={[styles.brandChipText, brandFilter === b && styles.brandChipTextActive]}>{b}</Text>
                    </TouchableOpacity>
                  ))}
                </ScrollView>
              </View>
            ) : null}
          </View>

          {/* 列表 */}
          {list.length === 0 ? (
            <View style={styles.empty}>
              <Text style={styles.emptyText}>暂无陈列费用单</Text>
              <Text style={styles.emptySub}>点右上角「＋ 登记」新增一笔</Text>
            </View>
          ) : (
            list.map((e, i) => {
              const isRebate = e.expenseType === 2;
              const isConsign = e.expenseType === 3;
              const isConsignRebate = isConsign && e.returnType === 2;
              return (
                <View key={e.id} style={[styles.itemCard, i > 0 && { marginTop: theme.spaceScale[3] }]}>
                  <TouchableOpacity style={styles.itemMain} onPress={() => openDetail(e.id)} activeOpacity={0.7}>
                    <View style={styles.itemTop}>
                      <Text style={styles.itemNo}>{e.expenseNo}</Text>
                      <TypeTag type={e.expenseType} />
                    </View>
                    <Text style={styles.itemSupplier}>{e.supplierName}</Text>
                    {e.brand ? <Text style={styles.itemBrand}>{e.brand}</Text> : null}
                    <Text style={styles.itemItem}>{e.item || (isRebate ? (e.productName || '—') : '—')}</Text>
                    <View style={styles.itemAmountRow}>
                      {isConsign ? (
                        isConsignRebate ? (
                          <Text style={styles.itemAmount}>{`返货 ${round(e.rebateQty)}${e.rebateUnit || '件'}`}</Text>
                        ) : (
                          <Text style={styles.itemAmount}>{money(e.totalAmount)}</Text>
                        )
                      ) : isRebate ? (
                        <>
                          <Text style={styles.itemAmount}>{`每期 ${round(e.rebateQty)}${e.rebateUnit || '件'}`}</Text>
                          <Text style={styles.itemUnsettled}>{`已返 ${round(e.settledAmount)} 期`}</Text>
                        </>
                      ) : (
                        <>
                          <Text style={styles.itemAmount}>{money(e.totalAmount)}</Text>
                          <Text style={styles.itemUnsettled}>未收 {money(e.unsettledAmount)}</Text>
                        </>
                      )}
                      {isConsign ? (
                        <Text style={styles.itemUnsettled}>未收 {money(e.unsettledAmount)}</Text>
                      ) : isRebate ? (
                        <Text style={styles.itemUnsettled}>{`已返 ${round(e.settledAmount)} 期`}</Text>
                      ) : (
                        <Text style={styles.itemUnsettled}>未收 {money(e.unsettledAmount)}</Text>
                      )}
                    </View>
                    {isConsign ? (
                      (() => {
                        const items = Array.isArray(e.consignItems) ? e.consignItems : [];
                        const nQty = items.filter((i) => i.type !== 'gift').reduce((s, i) => s + (Number(i.qty) || 0), 0);
                        const gQty = items.filter((i) => i.type === 'gift').reduce((s, i) => s + (Number(i.qty) || 0), 0);
                        const base = items.length > 0 ? { nQty, gQty } : { nQty: Number(e.consignQty) || 0, gQty: 0 };
                        return (
                          <Text style={styles.itemConsignInfo}>{`铺货 ${round(base.nQty)} 件 · 搭赠 ${round(base.gQty)} 件 · 货值 ¥${e.consignTotalValue ?? 0}`}</Text>
                        );
                      })()
                    ) : null}
                    <View style={styles.itemFoot}>
                      <StatusTag status={e.status} />
                      {!isRebate && Array.isArray(e.planJson) && e.planJson.length > 0 ? (
                        <Text style={styles.planListTag}>{`已 ${e.planJson.filter((p) => p.status === 1).length}/${e.planJson.length} 期`}</Text>
                      ) : null}
                      {e.overdue ? <Text style={styles.overdueTag}>逾期</Text> : <Text style={styles.methodTag}>{isConsign ? (isConsignRebate ? '寄售·返货' : '寄售') : isRebate ? '返货' : SETTLE_METHOD_LABEL[e.settleMethod as SettleMethod]}</Text>}
                    </View>
                  </TouchableOpacity>
                  <View style={styles.itemActions}>
                    {e.status < 2 ? (
                      <TouchableOpacity style={styles.settlePill} onPress={() => { setSettleTarget(e); setSettleTargetSettlements([]); }}>
                        <Text style={styles.settlePillText}>{isRebateLikeExpense(e) ? '确认收货' : '结算'}</Text>
                      </TouchableOpacity>
                    ) : null}
                    <TouchableOpacity style={styles.morePill} onPress={() => showItemActions(e)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                      <Text style={styles.morePillText}>⋮</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              );
            })
          )}
          <View style={{ height: 24 }} />
        </ScrollView>

        <SettleModal
          theme={theme}
          styles={styles}
          baseUrl={baseUrl}
          target={settleTarget}
          settlements={settleTargetSettlements}
          presetPlanSeq={settlePlanSeq}
          onClose={() => { setSettleTarget(null); setSettleTargetSettlements([]); setSettlePlanSeq(null); }}
          onConfirm={async (payload: { settleAmount?: number; paymentMethod?: PaymentMethod; settleDate?: string; remark?: string; images?: ExpenseImageDraft[]; planSeq?: number }) => {
            try {
              await settleExpense(baseUrl, settleTarget!.id, payload);
              Alert.alert('已结算', '该笔费用已记录一笔结算');
              setSettleTarget(null);
              setSettlePlanSeq(null);
              await loadAll();
            } catch (e: any) { Alert.alert('结算失败', e?.message || ''); }
          }}
        />
      </View>
    );
  }

  // ============ 新增/编辑登记 ============
  if (view === 'form') {
    return <ExpenseForm theme={theme} styles={styles} baseUrl={baseUrl} editing={editingTarget} editingImages={editingImages} onBack={backToList} onSaved={async () => {
      Alert.alert(editingTarget ? '已更新' : '已登记', editingTarget ? '费用单已更新' : '陈列费用单已保存');
      backToList();
    }} onError={(m: string) => Alert.alert(editingTarget ? '更新失败' : '登记失败', m)} />;
  }

  // ============ 详情 ============
  return (
    <View style={styles.root}>
      <SafeAreaHeader style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={backToList} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <Text style={styles.backText}>‹ 列表</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>费用详情</Text>
        <View style={styles.subSpacer} />
      </SafeAreaHeader>

      <ScrollView style={styles.body} contentContainerStyle={styles.content}>
        {!detail ? (
          <View style={styles.empty}><Text style={styles.emptyText}>加载中…</Text></View>
        ) : (
          <DetailBody
            theme={theme} styles={styles} baseUrl={baseUrl} detail={detail}
            onSettle={() => { setSettleTarget(detail.expense); setSettleTargetSettlements(detail.settlements || []); }}
            onSettlePeriod={handleSettlePeriod}
            onEdit={() => startEdit(detail.expense)}
            onDelete={() => confirmDelete(detail.expense)}
            onReverse={() => setReverseTarget(detail.expense)}
          />
        )}
      </ScrollView>

      <SettleModal
        theme={theme}
        styles={styles}
        baseUrl={baseUrl}
        target={settleTarget}
        settlements={settleTargetSettlements}
        presetPlanSeq={settlePlanSeq}
        onClose={() => { setSettleTarget(null); setSettleTargetSettlements([]); setSettlePlanSeq(null); }}
        onConfirm={async (payload: { settleAmount: number; paymentMethod?: PaymentMethod; settleDate?: string; remark?: string; images?: ExpenseImageDraft[]; planSeq?: number }) => {
          try {
            await settleExpense(baseUrl, settleTarget!.id, payload);
            Alert.alert('已结算', '该笔费用已记录一笔结算');
            setSettleTarget(null);
            setSettlePlanSeq(null);
            if (detailId) { const d = await getExpenseDetail(baseUrl, detailId); if (d) setDetail(d); }
            await loadAll();
          } catch (e: any) { Alert.alert('结算失败', e?.message || ''); }
        }}
      />
      <ReverseModal
        theme={theme}
        styles={styles}
        target={reverseTarget}
        onClose={() => setReverseTarget(null)}
        onConfirm={async (payload: { settleAmount?: number; paymentMethod?: PaymentMethod; remark?: string }) => {
          try {
            await reverseExpense(baseUrl, reverseTarget!.id, payload);
            Alert.alert('已冲正', '已记录一笔冲正结算');
            setReverseTarget(null);
            if (detailId) { const d = await getExpenseDetail(baseUrl, detailId); if (d) setDetail(d); }
            await loadAll();
          } catch (e: any) { Alert.alert('冲正失败', e?.message || ''); }
        }}
      />
    </View>
  );
}

// ============ 统计格 ============
function StatCell({ label, value, valueColor }: { label: string; value: string; valueColor?: string }) {
  const { theme } = useTheme();
  const styles = makeStyles(theme);
  return (
    <View style={styles.statCell}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={[styles.statValue, valueColor ? { color: valueColor } : null]}>{value}</Text>
    </View>
  );
}

// ============ 品牌维度：汇总 + CSV 导出（与 PC 端口径一致） ============
export interface BrandAgg {
  brand: string;      // 聚合 key
  label: string;      // 展示名（未填品牌的兜底成「未填品牌」）
  count: number;      // 单数（含返货）
  rebateCount: number;// 其中返货单数（返货不计金额，单独记）
  total: number;      // 总额（排除返货）
  settled: number;    // 已结
  unsettled: number;  // 未结
  overdue: number;    // 逾期笔数
}

const NO_BRAND = '__none__';

// 返货单（expenseType=2）的 totalAmount 恒为 0、settledAmount 复用为「已收期数」，
// 因此任何金额聚合都必须把返货排除，否则会把期数当钱加进去。
function buildBrandAgg(list: SupplierExpense[]): BrandAgg[] {
  const map = new Map<string, BrandAgg>();
  (list || []).forEach((e) => {
    const key = (e.brand || '').trim() || NO_BRAND;
    let row = map.get(key);
    if (!row) {
      row = { brand: key, label: key === NO_BRAND ? '未填品牌' : key, count: 0, rebateCount: 0, total: 0, settled: 0, unsettled: 0, overdue: 0 };
      map.set(key, row);
    }
    row.count += 1;
    // 返货（expenseType=2）与寄售到期返货（expenseType=3 & returnType=2）：settledAmount 复用为「已收期数」，
    // totalAmount 现存放供应商给付货值，但金额聚合仍须排除二者，否则会把期数当钱加进去；
    // 两者都计入 rebateCount（品牌汇总「返货 N」口径统一）。
    if (isRebateLikeExpense(e)) row.rebateCount += 1;
    if (!isRebateLikeExpense(e)) {
      row.total += Number(e.totalAmount) || 0;
      row.settled += Number(e.settledAmount) || 0;
    }
    // 逾期笔数与 PC 一致：直接吃后端 overdue 标记（返货也有「到期未收货」的逾期，同样计入）
    if (e.overdue) row.overdue += 1;
  });
  return Array.from(map.values()).map((r) => ({
    ...r,
    unsettled: Math.max(0, Math.round((r.total - r.settled) * 100) / 100),
  })).sort((a, b) => (b.total - a.total) || (b.count - a.count));
}

// CSV 单元格转义：含逗号/引号/换行时加英文双引号并把内部引号翻倍
function csvCell(v: any): string {
  let s = v === null || v === undefined ? '' : String(v);
  if (/[",\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

// 生成费用单 CSV 文本（含品牌列）。加 UTF-8 BOM，否则 Excel 打开中文会乱码。
function buildExpenseCsv(list: SupplierExpense[]): string {
  const BOM = '\uFEFF';
  const header = ['费用单号', '供应商', '品牌', '费用项目', '费用类型', '结算方式', '发生日期', '到期日', '总金额', '已结算', '未结算', '状态'];
  const lines = [header.map(csvCell).join(',')];
  (list || []).forEach((e) => {
    const isRebate = e.expenseType === 2;
    // 寄售到期返货（expenseType=3 & returnType=2）与返货同理：settledAmount 为已收期数，按返货口径导出（totalAmount 现存放货值）
    const nonMoney = isRebate || (e.expenseType === 3 && e.returnType === 2);
    // 返货的「未结算」= 还剩几期没确认收货；不限期数（rebateTotalPeriods=0）显示「长期」（与 PC 一致）
    const rebateLeft = (Number(e.rebateTotalPeriods) || 0) > 0
      ? `${Math.max(0, (Number(e.rebateTotalPeriods) || 0) - Math.round(Number(e.settledAmount) || 0))} 期`
      : '长期';
    const unsettled = isRebate ? '' : Math.max(0, (Number(e.totalAmount) || 0) - (Number(e.settledAmount) || 0)).toFixed(2);
    lines.push([
      e.expenseNo,
      e.supplierName,
      e.brand || '',
      e.item || '',
      EXPENSE_TYPE_LABEL[e.expenseType] || '',
      // 结算方式：返货 / 寄售到期返货填「返货」（与 PC 导出列口径一致，避免两份表合并后同一列语义不同）
      nonMoney ? '返货' : (SETTLE_METHOD_LABEL[e.settleMethod] || ''),
      e.expenseDate || '',
      nonMoney ? (e.nextRebateDate || '') : (e.dueDate || ''),
      nonMoney ? '' : (Number(e.totalAmount) || 0).toFixed(2),
      nonMoney ? `${Math.round(Number(e.settledAmount) || 0)} 期` : (Number(e.settledAmount) || 0).toFixed(2),
      nonMoney ? rebateLeft : unsettled,
      statusLabel(e.status),
    ].map(csvCell).join(','));
  });
  return BOM + lines.join('\r\n');
}

// 导出费用单 CSV。分平台走不同通道，但都不新增第三方依赖：
//  · Android：RN 自带的 Share 在 Android 上根本不认 url（ShareModule 只把 title 塞 EXTRA_SUBJECT、
//    message 塞 EXTRA_TEXT，type 还是 text/plain），分享文件只会发出空内容。
//    所以走系统文件选择器（StorageAccessFramework，无需存储权限）让用户选目录保存。
//  · iOS：Share 支持 url，写缓存后调系统分享面板（微信/邮件/存储到文件由用户选）。
async function exportExpenseCsv(list: SupplierExpense[]): Promise<{ count: number; hint: string }> {
  if (!list || list.length === 0) throw new Error('当前筛选结果为空，无可导出数据');
  const csv = buildExpenseCsv(list);
  const name = `供应商陈列费用-${todayStr()}.csv`;

  if (Platform.OS === 'android' && FileSystem.StorageAccessFramework) {
    const perms = await FileSystem.StorageAccessFramework.requestDirectoryPermissionsAsync();
    if (!perms?.granted || !perms.directoryUri) throw new Error('已取消：未选择保存位置');
    const uri = await FileSystem.StorageAccessFramework.createFileAsync(perms.directoryUri, name, 'text/csv');
    await FileSystem.writeAsStringAsync(uri, csv, { encoding: FileSystem.EncodingType.UTF8 });
    return { count: list.length, hint: `已保存为 ${name}，在「文件管理 / 下载」中可查看` };
  }

  const dir = FileSystem.cacheDirectory || FileSystem.documentDirectory;
  if (!dir) throw new Error('当前设备不支持文件写入');
  const uri = `${dir}${name}`;
  await FileSystem.writeAsStringAsync(uri, csv, { encoding: FileSystem.EncodingType.UTF8 });
  await Share.share({ url: uri, title: name }, { dialogTitle: '导出陈列费用 CSV' });
  return { count: list.length, hint: '请在系统分享面板中选择保存位置或发送给他人' };
}

// ============ 类型 / 状态 Tag ============
function TypeTag({ type }: { type: ExpenseType }) {
  const { theme } = useTheme();
  const isRebate = type === 2;
  return (
    <View style={{ backgroundColor: isRebate ? theme.color.info + '1A' : theme.color.primarySoft, paddingHorizontal: 8, paddingVertical: 2, borderRadius: 6 }}>
      <Text style={{ fontSize: 12, color: isRebate ? theme.color.info : theme.color.primaryVivid, fontWeight: theme.font.weight.medium }}>
        {EXPENSE_TYPE_LABEL[type]}
      </Text>
    </View>
  );
}
function StatusTag({ status }: { status: ExpenseStatus }) {
  const { theme } = useTheme();
  const color = status === 2 ? theme.color.success : theme.color.warning;
  return (
    <View style={{ backgroundColor: color + '1A', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 6 }}>
      <Text style={{ fontSize: 12, color, fontWeight: theme.font.weight.medium }}>{statusLabel(status)}</Text>
    </View>
  );
}

// ============ 详情正文 ============
function DetailBody({ theme, styles, baseUrl, detail, onSettle, onSettlePeriod, onEdit, onDelete, onReverse }: any) {
  const e = detail.expense;
  const isRebate = e.expenseType === 2;
  const isConsign = e.expenseType === 3;
  const isRebateLike = isRebateLikeExpense(e);
  const [previewUri, setPreviewUri] = useState<string | null>(null);
  // 货物处置状态（独立于结算状态）：本地乐观态，改完直接走独立接口 PUT /disposal
  const [disposalLocal, setDisposalLocal] = useState<number>(e.disposalStatus || 0);
  const planList: PlanPeriod[] = Array.isArray(e.planJson) ? e.planJson : [];
  return (
    <View>
      {/* 金额 / 期数 */}
      {isRebate ? (
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>返货进度</Text>
          <InfoRow label="已返期数" value={e.rebateTotalPeriods > 0 ? `${round(e.settledAmount)} 期 / 共 ${e.rebateTotalPeriods} 期` : `${round(e.settledAmount)} 期 / 不限期数`} />
          <InfoRow label="关联商品" value={e.productName || '—'} />
        </View>
      ) : (
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>金额</Text>
          <View style={styles.amountRow}>
            <View style={styles.amountCol}><Text style={styles.amountLabel}>总额</Text><Text style={[styles.amountVal, { color: theme.color.textApp }]}>{money(e.totalAmount)}</Text></View>
            <View style={styles.amountCol}><Text style={styles.amountLabel}>已结</Text><Text style={[styles.amountVal, { color: theme.color.success }]}>{money(e.settledAmount)}</Text></View>
            <View style={styles.amountCol}><Text style={styles.amountLabel}>未结</Text><Text style={[styles.amountVal, { color: theme.color.warning }]}>{money(e.unsettledAmount)}</Text></View>
          </View>
          {e.overdue ? <Text style={[styles.overdueLine, { color: theme.color.danger }]}>⚠ 已逾期（到期 {e.dueDate}）</Text> : null}
        </View>
      )}

      {/* 结算计划（返钱分期）：每期 计划/已结/未结 + 凭证 + 结算/补交入口 */}
      {!isRebate && planList.length > 0 ? (
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>
            {`结算计划（${planList.filter((p) => p.status === 1).length}/${planList.length} 期已结）`}
          </Text>
          <Text style={styles.planSummary}>{`计划合计 ${money(e.planTotal)} · 已结 ${money(e.planSettled)}`}</Text>
          {planList.map((p) => {
            const settled = Number(p.settledAmount) || 0;
            const planAmt = Number(p.planAmount) || 0;
            const unsettled = Math.round((planAmt - settled) * 100) / 100;
            const od = p.status === 0 && p.planDate && p.planDate < todayStr();
            const statusText = p.status === 1 ? '已结' : p.status === 3 ? '作废' : od ? '逾期' : '待结';
            const tagColor = p.status === 1 ? theme.color.success : p.status === 3 ? theme.color.textAppTertiary : od ? theme.color.danger : theme.color.warning;
            const cardBg = p.status === 1 ? theme.color.primarySoft : od ? theme.color.danger + '14' : theme.color.surfaceApp;
            const imgs = Array.isArray(p.images) ? p.images : [];
            return (
              <View key={p.seq} style={[styles.planCard, { backgroundColor: cardBg, borderColor: od ? theme.color.danger : theme.color.dividerApp }]}>
                <View style={styles.planCardHead}>
                  <Text style={styles.planCardTitle}>
                    {`第 ${p.seq} 期`}
                    <Text style={styles.planCardDate}>{`  ${p.planDate || '—'}`}</Text>
                  </Text>
                  <View style={[styles.planTag, { backgroundColor: tagColor + '1A' }]}>
                    <Text style={[styles.planTagText, { color: tagColor }]}>{statusText}</Text>
                  </View>
                </View>
                <View style={styles.planAmountRow}>
                  <Text style={styles.planAmtLabel}>{'计划 '}</Text>
                  <Text style={styles.planAmtVal}>{money(planAmt)}</Text>
                  <Text style={[styles.planAmtLabel, { color: theme.color.success }]}>{'  已结 '}</Text>
                  <Text style={[styles.planAmtVal, { color: theme.color.success }]}>{money(settled)}</Text>
                  <Text style={[styles.planAmtLabel, { color: unsettled > 0 ? theme.color.danger : theme.color.textAppTertiary }]}>{'  未结 '}</Text>
                  <Text style={[styles.planAmtVal, { color: unsettled > 0 ? theme.color.danger : theme.color.textAppTertiary }]}>{money(unsettled)}</Text>
                </View>
                {p.remark ? <Text style={styles.planRemark}>{`备注：${p.remark}`}</Text> : null}
                <View style={styles.planBottomRow}>
                  {p.status === 1 && imgs.length > 0 ? (
                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', flex: 1 }}>
                      {imgs.map((im, k) => (
                        (im.url || '').toLowerCase().endsWith('.pdf') ? (
                          <Text key={k} style={styles.planNoVoucher}>📄 PDF凭证 </Text>
                        ) : (
                          <TouchableOpacity key={k} onPress={() => setPreviewUri(toAbsoluteUrl(baseUrl, im.url))} activeOpacity={0.8} hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}>
                            <Image source={{ uri: toAbsoluteUrl(baseUrl, im.url) }} style={{ width: 44, height: 44, borderRadius: 6, marginRight: 6, borderWidth: 1, borderColor: theme.color.dividerApp }} />
                          </TouchableOpacity>
                        )
                      ))}
                    </View>
                  ) : (
                    <Text style={styles.planNoVoucher}>{`暂无凭证${unsettled > 0 ? '（未结算）' : '（已结清）'}`}</Text>
                  )}
                  {p.status !== 1 && p.status !== 3 && e.status < 2 ? (
                    <TouchableOpacity
                      style={[styles.planActionBtn, { backgroundColor: od ? theme.color.danger : theme.color.primaryVivid }]}
                      onPress={() => onSettlePeriod && onSettlePeriod(e, p.seq)}
                      activeOpacity={0.8}
                    >
                      <Text style={styles.planActionText}>{od ? '补交本期' : '结算本期'}</Text>
                    </TouchableOpacity>
                  ) : null}
                </View>
              </View>
            );
          })}
        </View>
      ) : null}

      {/* 基本信息 */}
      <View style={styles.card}>
        <Text style={styles.sectionTitle}>基本信息</Text>
        <InfoRow label="费用单号" value={e.expenseNo} />
        <InfoRow label="供应商" value={e.supplierName} />
        <InfoRow label="类型" value={EXPENSE_TYPE_LABEL[e.expenseType as ExpenseType]} />
        <InfoRow label="项目" value={e.item || '—'} />
        <InfoRow label="结算时机" value={SETTLEMENT_TIMING_LABEL[(e.settlementTiming || 1) as SettlementTiming]} />
        {e.brand ? <InfoRow label="品牌" value={e.brand} /> : null}
        <InfoRow label="结算方式" value={isRebateLike ? '返货' : SETTLE_METHOD_LABEL[e.settleMethod as SettleMethod]} />
        <InfoRow label="发生日期" value={e.expenseDate} />
        {!isRebate && e.settleMethod !== 3 ? <InfoRow label="到期日" value={e.dueDate || '—'} /> : null}
        {e.remark ? <InfoRow label="备注" value={e.remark} /> : null}
      </View>

      {/* 寄售协议（expenseType=3） */}
      {isConsign ? (
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>寄售协议</Text>
          <InfoRow label="铺货商品" value={e.productName || '—'} />
          <InfoRow label="铺货数量" value={`${round(e.consignQty)}${e.consignUnit || '件'}`} />
          <InfoRow label="铺货总货值（进货价合计）" value={`¥${money(e.consignTotalValue)}`} />
          <InfoRow label="铺货到期日" value={`${e.maturityDate || '—'}（货物处置提醒）`} />
          <InfoRow label="结算方式" value={e.returnType === 2 ? '货物（供应商给付货物）' : '现金（陈列费金额）'} />
          {/* 货物处置状态（独立于结算状态）：仅作展示，到期前无操作入口 */}
          <Text style={[styles.fieldLabel, { marginTop: 8 }]}>货物处置状态</Text>
          <View style={[styles.segRow, { opacity: 0.85 }]}>
            {([{ k: 0, t: '待处置' }, { k: 1, t: '已拉走' }, { k: 2, t: '已续约' }] as { k: number; t: string }[]).map((o) => (
              <View key={o.k} style={[styles.segBtn, disposalLocal === o.k && styles.segBtnActive]}>
                <Text style={[styles.segBtnText, disposalLocal === o.k && styles.segBtnTextActive]}>{DISPOSAL_STATUS_LABEL[o.k]}</Text>
              </View>
            ))}
          </View>
          <Text style={{ fontSize: 12, color: theme.color.textAppTertiary, marginTop: 4 }}>到期前仅作提醒，到期后（拉走 / 续约）方可处置</Text>
          {Array.isArray(e.consignItems) && e.consignItems.length > 0 ? (
            <View style={styles.consignItemList}>
              <Text style={styles.subTitle}>铺货商品明细</Text>
              {e.consignItems.map((it: ConsignItem, i: number) => (
                <View key={i} style={styles.consignItemRow}>
                  <Text style={styles.consignItemName}>{it.name}{it.type === 'gift' ? ' [搭赠]' : ''}</Text>
                  <Text style={styles.consignItemMeta}>{`${round(it.qty)}${it.unit || '件'}${it.type === 'gift' ? '' : ` · 进${money(it.costPrice)}/零${money(it.salePrice)}`}`}</Text>
                </View>
              ))}
            </View>
          ) : null}
          {isConsign && e.returnType === 2 && Array.isArray(e.consignReturnItems) && e.consignReturnItems.length > 0 ? (
            <View style={styles.consignItemList}>
              <Text style={styles.subTitle}>返货商品明细（结算时供应商给付）</Text>
              {e.consignReturnItems.map((it: ReturnItem, i: number) => (
                <View key={i} style={styles.consignItemRow}>
                  <Text style={styles.consignItemName}>{it.name}</Text>
                  <Text style={styles.consignItemMeta}>{`${round(it.qty)}${it.unit || '件'}${it.spec ? ` · ${it.spec}` : ''}`}</Text>
                </View>
              ))}
            </View>
          ) : null}
        </View>
      ) : null}

      {/* 返货协议（expenseType=2） */}
      {isRebate ? (
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>返货协议（{REBATE_CYCLE_LABEL[e.rebateCycle as RebateCycle] || '每月'}返）</Text>
          <InfoRow label="关联商品" value={e.productName || '—'} />
          <InfoRow label="每期" value={`${round(e.rebateQty)}${e.rebateUnit || '件'}`} />
          <InfoRow label="首期日期" value={e.rebateStartDate || '—'} />
          <InfoRow label="下次返货" value={e.nextRebateDate || '—'} />
          <InfoRow label="到期时间" value={e.maturityDate ? e.maturityDate : '长期（不限）'} />
          <InfoRow label="期限数" value={e.rebateTotalPeriods > 0 ? `${e.rebateTotalPeriods} 期` : '不限'} />
        </View>
      ) : null}

      {/* 返货期次明细（与 PC 详情一致：每期备注 + 凭证图片，按 rebate_seq 关联） */}
      {isRebate ? (
        (() => {
          const periods = buildRebatePeriods(e, detail.settlements || []);
          return (
            <View style={styles.card}>
              <Text style={styles.sectionTitle}>{`返货期次明细（已收 ${periods.filter((p) => p.settled).length} / 共 ${periods.length} 期）`}</Text>
              {periods.map((p, idx) => {
                const imgs = (p.images || []).filter((im: any) => im && im.url);
                return (
                  <View key={p.seq} style={{ borderTopWidth: idx === 0 ? 0 : 1, borderTopColor: theme.color.dividerApp, paddingVertical: 8 }}>
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                      <Text style={{ fontWeight: theme.font.weight.semibold, color: theme.color.textApp }}>{`第 ${p.seq} 期 · ${p.planDate || '—'}`}</Text>
                      <Text style={{ fontSize: 12, color: p.settled ? theme.color.success : (p.planDate && p.planDate < todayStr() ? theme.color.danger : theme.color.textAppTertiary) }}>{p.settled ? `已收 ${p.planQty}${e.rebateUnit || ''}` : (p.planDate && p.planDate < todayStr() ? '逾期' : '待收')}</Text>
                    </View>
                    {p.remark ? <Text style={[styles.planRemark, { marginTop: 2 }]}>{`备注：${p.remark}`}</Text> : null}
                    {imgs.length > 0 ? (
                      <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginTop: 6 }}>
                        {imgs.map((im: any, k: number) => (
                          (im.url || '').toLowerCase().endsWith('.pdf') ? (
                            <Text key={k} style={styles.planNoVoucher}>📄 PDF凭证 </Text>
                          ) : (
                            <TouchableOpacity key={k} onPress={() => setPreviewUri(toAbsoluteUrl(baseUrl, im.url))} activeOpacity={0.8} hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}>
                              <Image source={{ uri: toAbsoluteUrl(baseUrl, im.url) }} style={{ width: 44, height: 44, borderRadius: 6, marginRight: 6, borderWidth: 1, borderColor: theme.color.dividerApp }} />
                            </TouchableOpacity>
                          )
                        ))}
                      </View>
                    ) : null}
                  </View>
                );
              })}
            </View>
          );
        })()
      ) : null}

      {/* 结算历史 */}
      <View style={styles.card}>
        <Text style={styles.sectionTitle}>结算历史（{detail.settlements.length}）</Text>
        {detail.settlements.length === 0 ? (
          <Text style={styles.emptyText}>暂无结算记录</Text>
        ) : detail.settlements.map((s: any, i: number) => (
          <View key={s.id} style={[styles.settleRow, i > 0 && { borderTopWidth: 1, borderTopColor: theme.color.dividerApp }]}>
            <View style={{ flex: 1 }}>
              <Text style={[styles.settleAmt, (s.isReversal || s.isRebate) && { color: s.isRebate ? theme.color.primaryVivid : theme.color.danger }]}>
                {s.isReversal ? `冲正${s.rebatePeriod ? `（${s.rebatePeriod}）` : ''} ` : s.isRebate ? `返货确认收货${s.rebatePeriod ? `（${s.rebatePeriod}）` : ''} ` : ''}{money(s.settleAmount)}
              </Text>
              <Text style={styles.settleMeta}>{s.isRebate ? '返货抵费' : `${PAYMENT_LABEL[s.paymentMethod as PaymentMethod]} · ${s.settleDate}`}{s.operator ? ` · ${s.operator}` : ''}</Text>
              {s.remark ? <Text style={styles.settleMeta}>{s.remark}</Text> : null}
                {s.images && s.images.length > 0 ? (
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginTop: 6 }}>
                    {s.images.map((img: any, k: number) => (
                      <TouchableOpacity key={img.id ?? k} onPress={() => setPreviewUri(toAbsoluteUrl(baseUrl, img.imageUrl))} activeOpacity={0.8} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
                        <Image source={{ uri: toAbsoluteUrl(baseUrl, img.imageUrl) }} style={{ width: 44, height: 44, borderRadius: 6, marginRight: 6, marginBottom: 6, borderWidth: 1, borderColor: theme.color.dividerApp }} />
                      </TouchableOpacity>
                    ))}
                  </View>
                ) : null}
            </View>
          </View>
        ))}
      </View>

      {/* 图片 */}
      {detail.images.length > 0 ? (
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>图片凭证（{detail.images.length}）</Text>
          <View style={styles.imgGrid}>
            {detail.images.map((im: any) => (
              <TouchableOpacity key={im.id} onPress={() => setPreviewUri(toAbsoluteUrl(baseUrl, im.imageUrl))} activeOpacity={0.8} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
                <Image source={{ uri: toAbsoluteUrl(baseUrl, im.imageUrl) }} style={styles.imgThumb} resizeMode="cover" />
              </TouchableOpacity>
            ))}
          </View>
        </View>
      ) : null}

      <View style={styles.detailActions}>
        <TouchableOpacity style={[styles.actionBtn, styles.actionBtnPrimary]} onPress={onEdit}>
          <Text style={[styles.actionBtnText, { color: theme.color.primaryVivid }]}>编辑</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.actionBtn, styles.actionBtnDanger]} onPress={onDelete}>
          <Text style={[styles.actionBtnText, { color: theme.color.danger }]}>删除</Text>
        </TouchableOpacity>
        {((!isRebateLike && e.settledAmount > 0) || (isRebateLike && (e.rebateSettledPeriods?.length || 0) > 0)) ? (
          <TouchableOpacity style={[styles.actionBtn, styles.actionBtnWarning]} onPress={onReverse}>
            <Text style={[styles.actionBtnText, { color: theme.color.warning }]}>冲正</Text>
          </TouchableOpacity>
        ) : null}
      </View>

      {e.status < 2 ? (
        <TouchableOpacity style={styles.settleActionBtn} onPress={onSettle}>
          <Text style={styles.settleActionText}>{isRebateLike ? '确认收货' : '现场结算'}</Text>
        </TouchableOpacity>
      ) : (
        <View style={styles.doneBanner}><Text style={styles.doneBannerText}>已结清</Text></View>
      )}

      {/* 图片全屏预览 */}
      <Modal visible={!!previewUri} transparent animationType="fade" onRequestClose={() => setPreviewUri(null)}>
        <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.92)', justifyContent: 'center', alignItems: 'center' }}>
          <TouchableOpacity style={{ position: 'absolute', top: 48, right: 20, zIndex: 10, padding: 12 }} onPress={() => setPreviewUri(null)}>
            <Text style={{ color: '#fff', fontSize: 18 }}>✕</Text>
          </TouchableOpacity>
          {previewUri ? (
            <Image source={{ uri: previewUri }} style={{ width: '100%', height: '80%' }} resizeMode="contain" />
          ) : null}
        </View>
      </Modal>
    </View>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  const { theme } = useTheme();
  const styles = makeStyles(theme);
  const accent = label === '类型';
  return (
    <View style={styles.infoRow}>
      <Text style={styles.infoLabel}>{label}</Text>
      <Text style={[styles.infoValue, accent && { color: theme.color.primaryVivid }]}>{value}</Text>
    </View>
  );
}

// ============ 新增/编辑登记表单 ============
function ExpenseForm({ theme, styles, baseUrl, editing, editingImages, onBack, onSaved, onError }: any) {
  const e = editing as SupplierExpense | undefined;
  const isRebate = (e?.expenseType ?? 1) === 2;

  // 供应商（FIX：始终受控写入 state，校验从 state 读取）
  const [supplierName, setSupplierName] = useState(e?.supplierName || '');
  const [expenseType, setExpenseType] = useState<ExpenseType>(e?.expenseType || 1);
  const [item, setItem] = useState(e?.item || '');
  const [settleMethod, setSettleMethod] = useState<SettleMethod>(e?.settleMethod || 3);
  // 结算时机：1=现给 2=到期给。寄售/expenseType=3 强制=2；返货默认到期给(2)；返钱默认现给(1)。与 PC 对齐。
  const [settlementTiming, setSettlementTiming] = useState<SettlementTiming>(
    e?.settlementTiming || (e?.expenseType === 3 ? 2 : (e?.expenseType === 2 ? 2 : 1))
  );
  const [expenseDate, setExpenseDate] = useState(e?.expenseDate || todayStr());
  const [dueDate, setDueDate] = useState(e?.dueDate || '');
  const [amount, setAmount] = useState(e && e.totalAmount ? e.totalAmount.toFixed(2) : '');
  // 返钱分期计划（与 PC 端结算计划段对齐；planAmount 草稿期允许字符串，提交时强转数字）
  const [planMode, setPlanMode] = useState<boolean>(Array.isArray(e?.planJson) && e!.planJson.length > 0);
  const [planList, setPlanList] = useState<any[]>(Array.isArray(e?.planJson) ? e!.planJson.map((p: PlanPeriod) => ({ ...p })) : []);
  const [peakAmt, setPeakAmt] = useState('200');
  const [offAmt, setOffAmt] = useState('100');
  const [planYear, setPlanYear] = useState(String(new Date().getFullYear()));
  const [planCount, setPlanCount] = useState('12');
  const [planStartMonth, setPlanStartMonth] = useState('1');
  const [peakMonths, setPeakMonths] = useState<number[]>([4, 5, 6, 7, 8, 9]);
  // 返货（expenseType=2）：关联商品 + 周期返还实物，无单价、不折算金额
  const [productName, setProductName] = useState(e?.productName || '');
  const [productId, setProductId] = useState<number>(e?.productId || 0);
  const [productOptions, setProductOptions] = useState<Product[]>([]);
  useEffect(() => { try { setProductOptions(listProducts()); } catch { setProductOptions([]); } }, []);
  // 品牌联想：随供应商变化刷新（离线时静默）
  useEffect(() => {
    (async () => {
      try {
        const brands = await fetchExpenseBrands(baseUrl, supplierName.trim());
        setBrandOptions(Array.isArray(brands) ? brands : []);
      } catch { setBrandOptions([]); }
    })();
  }, [baseUrl, supplierName]);
  const filteredProducts = productOptions.filter((p) => p.name.toLowerCase().includes(productName.trim().toLowerCase())).slice(0, 6);
  const [rebateCycle, setRebateCycle] = useState<RebateCycle>(e?.rebateCycle || 1);
  const [rebateQty, setRebateQty] = useState(e && e.rebateQty ? String(e.rebateQty) : '');
  const [rebateStartDate, setRebateStartDate] = useState(e?.rebateStartDate || todayStr());
  const [maturityDate, setMaturityDate] = useState(e?.maturityDate || '');
  const [rebateTotalPeriods, setRebateTotalPeriods] = useState(e && e.rebateTotalPeriods ? String(e.rebateTotalPeriods) : '');
  const [remark, setRemark] = useState(e?.remark || '');
  // 寄售铺货（expenseType=3）：多行商品明细（含正常/搭赠）；后端从明细派生 productId/productName/consignUnit/consignQty/consignCostPrice/consignSalePrice
  const blankConsignItem = (): ConsignItem => ({ productId: 0, name: '', spec: '', unit: '件', qty: 0, costPrice: 0, salePrice: 0, type: 'normal' });
  const [consignItems, setConsignItems] = useState<ConsignItem[]>(
    Array.isArray(e?.consignItems) && e!.consignItems.length > 0
      ? e!.consignItems.map((it: ConsignItem) => ({ ...it }))
      : [blankConsignItem()]
  );
  const [consignMaturity, setConsignMaturity] = useState(e?.maturityDate || '');
  // 寄售期限（数量 + 天/月/年）：到期日 = 发生日期 + 期限
  const [consignTermQty, setConsignTermQty] = useState<number>(6);
  const [consignTermUnit, setConsignTermUnit] = useState<'day' | 'month' | 'year'>('month');
  const [returnType, setReturnType] = useState<number>(e?.returnType || 1);
  // 货物处置状态（寄售独立字段，0=待处置 1=已拉走 2=已续约），独立于结算状态
  const [disposalStatus, setDisposalStatus] = useState<number>(e?.disposalStatus || 0);
  // 铺货总数量（含搭赠）= 所有行 qty 合计；铺货总价值 = 仅正常行 Σ(数量 × 进货价)（本地派生展示）
  const consignTotalQty = consignItems.reduce((s, it) => s + (Number(it.qty) || 0), 0);
  const consignTotalValue = consignItems.reduce((s, it) => s + ((it.type === 'gift' ? 0 : (Number(it.qty) || 0) * (Number(it.costPrice) || 0))), 0);
  const updateConsignItem = (idx: number, patch: Partial<ConsignItem>) =>
    setConsignItems((prev) => prev.map((it, i) => (i === idx ? { ...it, ...patch } : it)));
  const removeConsignItem = (idx: number) =>
    setConsignItems((prev) => prev.filter((_, i) => i !== idx));
  // 寄售到期返货（returnType=2）：独立的「返货商品明细」多行列表，与铺货明细互不干扰
  const blankReturnItem = (): ReturnItem => ({ productId: 0, name: '', spec: '', unit: '件', qty: 0 });
  const [returnItems, setReturnItems] = useState<ReturnItem[]>(
    Array.isArray(e?.consignReturnItems) && e!.consignReturnItems.length > 0
      ? e!.consignReturnItems.map((it: ReturnItem) => ({ ...it }))
      : [blankReturnItem()]
  );
  const [returnNameFocus, setReturnNameFocus] = useState<number | null>(null);
  const updateReturnItem = (idx: number, patch: Partial<ReturnItem>) =>
    setReturnItems((prev) => prev.map((it, i) => (i === idx ? { ...it, ...patch } : it)));
  const removeReturnItem = (idx: number) =>
    setReturnItems((prev) => prev.filter((_, i) => i !== idx));
  const returnTotalQty = returnItems.reduce((s, it) => s + (Number(it.qty) || 0), 0);
  // 品牌（按供应商区分费用，自由文本 + 历史联想）
  const [brand, setBrand] = useState(e?.brand || '');
  const [brandOptions, setBrandOptions] = useState<string[]>([]);
  const [images, setImages] = useState<string[]>(editingImages || []);
  const [previewUri, setPreviewUri] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // 相机
  const [camOpen, setCamOpen] = useState(false);
  const [camType, setCamType] = useState<CameraType>('back');
  const [permission, requestPermission] = useCameraPermissions();
  const camRef = React.useRef<any>(null);

  const pickSupplier = async () => {
    let names: string[] = [];
    try {
      const remote = await fetchSuppliers(baseUrl);
      names = names.concat(remote);
    } catch { /* 离线回退 */ }
    try {
      const local = listSuppliers().map((s) => s.name).filter(Boolean);
      names = names.concat(local as string[]);
    } catch { /* ignore */ }
    names = Array.from(new Set(names.filter(Boolean)));
    if (names.length === 0) {
      Alert.alert('选择供应商', '暂无供应商，请先在电脑端维护后同步，或手动输入');
      return;
    }
    Alert.alert('选择供应商', undefined, [
      ...names.map((n) => ({ text: n, onPress: () => setSupplierName(n) })),
      { text: '手动输入', onPress: () => {}, style: 'cancel' as const },
    ]);
  };

  const openCamera = async () => {
    if (!permission?.granted) {
      const r = await requestPermission();
      if (!r.granted) { Alert.alert('需要相机权限才能拍照'); return; }
    }
    setCamOpen(true);
  };
  const snap = async () => {
    try {
      const photo = await camRef.current?.takePictureAsync({ quality: 0.7, skipProcessing: false });
      setCamOpen(false);
      if (!photo?.uri) { Alert.alert('拍照失败', '未能获取照片'); return; }
      const name = (supplierName || '单据').replace(/\s+/g, '');
      const url = await uploadExpenseImage(baseUrl, photo.uri, name, expenseDate);
      setImages((prev) => [...prev, url]);
    } catch (e: any) {
      setCamOpen(false);
      Alert.alert('上传失败', e?.message || '');
    }
  };

  // 切换费用类型时清掉不相关字段，避免提交脏数据（如寄售字段混进返钱单）
  const setExpenseTypeSafe = (k: ExpenseType) => {
    if (k === expenseType) return;
    setExpenseType(k);
    // 切换费用类型时复位结算时机到该类型默认值：寄售/返货→到期给(2)，返钱→现给(1)
    setSettlementTiming(k === 3 ? 2 : (k === 2 ? 2 : 1));
    setProductName(''); setProductId(0);
    setConsignItems([blankConsignItem()]);
    if (k === 3 && consignTermQty > 0) {
      setConsignMaturity(dayjs(expenseDate).add(consignTermQty, consignTermUnit).format('YYYY-MM-DD'));
    } else {
      setConsignMaturity('');
    }
    setReturnType(1);
    setReturnItems([blankReturnItem()]); setReturnNameFocus(null);
    setRebateQty(''); setRebateCycle(1); setRebateStartDate(todayStr()); setMaturityDate(''); setRebateTotalPeriods('');
    setPlanMode(false); setPlanList([]); setAmount(''); setSettleMethod(3); setDueDate('');
  };

  // 切换结算时机：现给(1) 时强制按次、无到期日/无分期；到期给(2) 恢复默认结账周期
  const setSettlementTimingSafe = (t: SettlementTiming) => {
    setSettlementTiming(t);
    if (t === 1) { setPlanMode(false); setPlanList([]); setSettleMethod(3); setDueDate(''); }
  };

  const submit = async () => {
    if (!supplierName.trim()) { onError('供应商必填'); return; }
    if (!expenseDate.trim()) { onError('请填写发生日期（yyyy-mm-dd）'); return; }
    const payload: any = {
      supplierName: supplierName.trim(),
      brand: brand.trim(),
      expenseType,
      item: item.trim(),
      settlementTiming,
      expenseDate: expenseDate.trim().slice(0, 10),
      remark: remark.trim(),
      images: images.map((u) => ({ imageUrl: u, imageId: null })),
    };
    if (expenseType === 3) {
      // 寄售铺货（两层模型）：一层=铺货商品明细(ConsignItem 多行，可含搭赠行)，二层=到期结算方式(仅返钱/返货)
      const isNow = settlementTiming === 1; // 现给：陈列费当场付清，后端置 status=2（已结清）
      const validItems = consignItems.filter((it) => it.name.trim());
      if (validItems.length === 0) { onError('请至少添加一行铺货商品'); return; }
      if (!consignMaturity.trim()) { onError('请填写寄售到期日（货物处置提醒）'); return; }
      // 后端会从 consignItems 推导 productId/productName/consignUnit/consignQty/consignCostPrice/consignSalePrice/consignTotalValue
      payload.settleMethod = 3;
      payload.consignItems = validItems.map((it) => ({
        ...it,
        qty: Number(it.qty) || 0,
        costPrice: it.type === 'gift' ? 0 : (Number(it.costPrice) || 0),
        salePrice: it.type === 'gift' ? 0 : (Number(it.salePrice) || 0),
      }));
      payload.maturityDate = consignMaturity.trim().slice(0, 10);
      payload.disposalStatus = disposalStatus; // 货物处置状态（独立于结算状态）
      const a = Number(amount.replace(/[^0-9.]/g, '')) || 0;
      if (isNow) {
        // 现给：陈列费当场结清，后端置已结清；不收集返货明细
        if (a <= 0) { onError('陈列费金额需大于 0'); return; }
        payload.returnType = 1;
        payload.totalAmount = a;
        payload.consignReturnItems = [];
      } else if (returnType === 1) {
        // 到期返钱：走普通金额结算（陈列费）
        if (a <= 0) { onError('陈列费金额需大于 0'); return; }
        payload.returnType = 1;
        payload.totalAmount = a;
      } else {
        // 到期返货：供应商以「具体商品」支付陈列费（返货商品明细多行），不再填货值金额
        const validReturns = returnItems.filter((it) => it.name.trim() && Number(it.qty) > 0);
        if (validReturns.length === 0) { onError('请至少添加一行返货商品（品名 + 数量 > 0）'); return; }
        payload.returnType = 2;
        payload.consignReturnItems = validReturns.map((it) => ({
          productId: Number(it.productId) || 0,
          name: it.name.trim().slice(0, 128),
          spec: (it.spec || '').trim().slice(0, 64),
          unit: (it.unit || '').trim().slice(0, 16) || '件',
          qty: Math.max(0, Number(it.qty) || 0),
        }));
        // 货值字段置 0：返货以实物结算，不折算金额；与 PC 一致
        payload.totalAmount = 0;
        payload.rebateUnit = validReturns[0]?.unit?.trim() || '件';
        payload.rebateTotalPeriods = 1;
      }
    } else if (expenseType === 2) {
      // 返货：关联商品（可手填，无匹配则 productId=0）、无单价、不折算金额
      const rq = Number(rebateQty.replace(/[^0-9.]/g, '')) || 0;
      if (!productName.trim()) { onError('返货需填写关联商品（无匹配可手填）'); return; }
      if (rq <= 0) { onError('返货需填写每期数量（大于 0）'); return; }
      payload.settleMethod = 3;
      payload.productId = productId;
      payload.productName = productName.trim();
      payload.rebateCycle = rebateCycle;
      payload.rebateQty = rq;
      payload.rebateUnit = '件';
      payload.rebateStartDate = rebateStartDate.trim().slice(0, 10) || undefined;
      payload.maturityDate = maturityDate.trim() ? maturityDate.trim().slice(0, 10) : '';
      payload.rebateTotalPeriods = rebateTotalPeriods.trim() ? Math.max(0, Math.floor(Number(rebateTotalPeriods.replace(/[^0-9.]/g, '')) || 0)) : 0;
    } else {
      // 返钱：金额模型 或 分期计划
      if (settlementTiming === 1) {
        // 现给：强制按次、当场一次性付清，无到期日 / 无分期计划
        payload.settleMethod = 3;
        payload.dueDate = undefined;
        payload.planJson = [];
        const a = Number(amount.replace(/[^0-9.]/g, '')) || 0;
        if (a <= 0) { onError('金额需大于 0'); return; }
        payload.totalAmount = a;
      } else {
        const valid = planList.filter((p) => p.planDate && Number(p.planAmount) > 0);
        if (planMode) {
          // 启用分期计划：总额由计划合计推导（后端强校验），结算方式强制分期类，dueDate=末期待结
          if (valid.length === 0) { onError('已启用分期计划，请先生成或添加有效期次（含日期与金额）'); return; }
          payload.settleMethod = [1, 2, 5, 6].includes(settleMethod) ? settleMethod : 2;
          payload.dueDate = undefined;
          payload.planJson = valid.map((p, i) => ({
            seq: i + 1,
            planDate: String(p.planDate).slice(0, 10),
            planAmount: Number(p.planAmount) || 0,
            remark: p.remark || '',
            status: Number(p.status || 0),
            settledAmount: Number(p.settledAmount || 0),
            settledDate: p.settledDate || null,
            images: Array.isArray(p.images) ? p.images : [],
          }));
        } else {
          const sm = settleMethod;
          payload.settleMethod = sm;
          payload.dueDate = sm === 3 ? undefined : (dueDate.trim().slice(0, 10) || undefined);
          const a = Number(amount.replace(/[^0-9.]/g, '')) || 0;
          if (a <= 0) { onError('金额需大于 0'); return; }
          payload.totalAmount = a;
          payload.planJson = []; // 关闭计划：清空残留
        }
      }
    }
    setSaving(true);
    try {
      if (e) {
        await updateExpense(baseUrl, e.id, payload);
      } else {
        await createExpense(baseUrl, payload);
      }
      onSaved();
    } catch (err: any) {
      setSaving(false);
      onError(err?.message || '保存失败');
    }
  };

  const numInput = (setter: (v: string) => void) => ({
    keyboardType: 'numeric' as const,
    onChangeText: (v: string) => setter(v.replace(/[^0-9.]/g, '')),
  });

  // ===== 返钱分期计划：生成器（与 PC 端结算计划段逻辑一致）=====
  const pad2 = (n: number) => String(n).padStart(2, '0');
  const lastDayOf = (y: number, m: number) => new Date(y, m, 0).getDate();
  const fmtMoney = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
  const clampMonth = (v: string) => Math.min(12, Math.max(1, Math.floor(Number(v) || 1)));
  const planCountNum = () => Math.min(60, Math.max(1, Math.floor(Number(planCount) || 12)));

  // 旺季淡季：自定义期数 / 起始年月 / 旺季月份，支持跨年
  const genSeasonal = () => {
    const peak = Number(peakAmt.replace(/[^0-9.]/g, '')) || 0;
    const off = Number(offAmt.replace(/[^0-9.]/g, '')) || 0;
    const list: any[] = [];
    let y = Number(planYear) || new Date().getFullYear();
    let m = clampMonth(planStartMonth);
    for (let i = 0; i < planCountNum(); i++) {
      const isPeak = peakMonths.includes(m);
      list.push({
        seq: i + 1, planDate: `${y}-${pad2(m)}-${pad2(lastDayOf(y, m))}`,
        planAmount: isPeak ? peak : off,
        remark: `${y}年${m}月·${isPeak ? '旺季返' : '淡季返'}`,
        status: 0, settledAmount: 0, settledDate: null, images: [],
      });
      m += 1; if (m > 12) { m = 1; y += 1; }
    }
    setPlanList(list);
  };

  // 按月均摊：按费用总额 N 期等额（末期补差）
  const genEqualMonthly = () => {
    const total = Number(amount.replace(/[^0-9.]/g, '')) || 0;
    if (total <= 0) { Alert.alert('请先填写费用总额', '按月均摊模板需要先填「费用总额（元）」'); return; }
    const count = planCountNum();
    const base = fmtMoney(total / count);
    const list: any[] = [];
    let y = Number(planYear) || new Date().getFullYear();
    let m = clampMonth(planStartMonth);
    for (let i = 0; i < count; i++) {
      const amt = i === count - 1 ? fmtMoney(total - base * (count - 1)) : base;
      list.push({ seq: i + 1, planDate: `${y}-${pad2(m)}-${pad2(lastDayOf(y, m))}`, planAmount: amt, remark: `${y}年${m}月·均摊`, status: 0, settledAmount: 0, settledDate: null, images: [] });
      m += 1; if (m > 12) { m = 1; y += 1; }
    }
    setPlanList(list);
  };

  // 按季：4 个季度等额（末期补差）
  const genQuarterly = () => {
    const total = Number(amount.replace(/[^0-9.]/g, '')) || 0;
    if (total <= 0) { Alert.alert('请先填写费用总额', '按季模板需要先填「费用总额（元）」'); return; }
    const base = fmtMoney(total / 4);
    const list: any[] = [];
    let y = Number(planYear) || new Date().getFullYear();
    let m = clampMonth(planStartMonth);
    for (let i = 0; i < 4; i++) {
      const amt = i === 3 ? fmtMoney(total - base * 3) : base;
      list.push({ seq: i + 1, planDate: `${y}-${pad2(m)}-${pad2(lastDayOf(y, m))}`, planAmount: amt, remark: `${y}年${m}月·季度返`, status: 0, settledAmount: 0, settledDate: null, images: [] });
      m += 3; if (m > 12) { m -= 12; y += 1; }
    }
    setPlanList(list);
  };

  const addPlanRow = () => setPlanList((prev) => [...prev, { seq: prev.length + 1, planDate: '', planAmount: '', remark: '', status: 0, settledAmount: 0, settledDate: null, images: [] }]);
  const updatePlanRow = (seq: number, patch: any) => setPlanList((prev) => prev.map((p) => (p.seq === seq ? { ...p, ...patch } : p)));
  const removePlanRow = (seq: number) => setPlanList((prev) => prev.filter((p) => p.seq !== seq).map((p, i) => ({ ...p, seq: i + 1 })));
  const planTotal = planList.reduce((s, p) => s + (Number(p.planAmount) || 0), 0);

  return (
    <View style={styles.root}>
      <SafeAreaHeader style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={onBack} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <Text style={styles.backText}>‹ 列表</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>{e ? '编辑费用单' : '新增登记'}</Text>
        <View style={styles.subSpacer} />
      </SafeAreaHeader>

      <ScrollView style={styles.body} contentContainerStyle={styles.content}>
        {/* 供应商（始终受控写入 state） */}
        <Text style={styles.fieldLabel}>供应商 *</Text>
        <TextInput
          style={styles.input} value={supplierName} onChangeText={setSupplierName}
          placeholder="输入供应商名，或点右侧选择" placeholderTextColor={theme.color.textAppTertiary}
        />
        <TouchableOpacity style={styles.pickerField} onPress={pickSupplier}>
          <Text style={[styles.pickerText, { color: theme.color.textAppTertiary }]}>从已有供应商中选择</Text>
          <Text style={styles.pickerArrow}>›</Text>
        </TouchableOpacity>

        {/* 品牌（可选）：同一供应商旗下多个品牌（如怡宝、农夫），填品牌可把费用归到具体品牌，避免混在一起 */}
        <Text style={styles.fieldLabel}>品牌（可选）</Text>
        <TextInput
          style={styles.input} value={brand} onChangeText={setBrand}
          placeholder="选历史品牌或手填，如 怡宝 / 农夫" placeholderTextColor={theme.color.textAppTertiary}
        />
        {brandOptions.length > 0 ? (
          <View style={styles.chipRow}>
            {brandOptions.map((b) => (
              <TouchableOpacity
                key={b}
                style={[styles.chip, brand === b && styles.chipActive]}
                onPress={() => setBrand(brand === b ? '' : b)}
              >
                <Text style={[styles.chipText, brand === b && styles.chipTextActive]}>{b}</Text>
              </TouchableOpacity>
            ))}
          </View>
        ) : null}

        {/* 结算时机（上层）：现给 / 到期给。寄售业务上建议「到期给」，但可手动切到「现给」 */}
        <Text style={styles.fieldLabel}>结算时机</Text>
        <View style={styles.segRow}>
          {([{ k: 1, t: '现给' }, { k: 2, t: '到期给' }] as { k: SettlementTiming; t: string }[]).map((o) => (
            <TouchableOpacity key={o.k} style={[styles.segBtn, settlementTiming === o.k && styles.segBtnActive]} onPress={() => setSettlementTimingSafe(o.k)}>
              <Text style={[styles.segBtnText, settlementTiming === o.k && styles.segBtnTextActive]}>{o.t}</Text>
            </TouchableOpacity>
          ))}
        </View>
        {expenseType === 3 ? (
          <Text style={{ fontSize: 12, color: theme.color.textAppTertiary, marginTop: 4 }}>寄售可选「现给」：陈列费当场结清（单状态直接已结清），到期日仅作货物处置提醒</Text>
        ) : null}

        {/* 费用类型 */}
        <Text style={styles.fieldLabel}>费用类型</Text>
        <View style={styles.segRow}>
          {([{ k: 1, t: '返钱' }, { k: 2, t: '返货' }, { k: 3, t: '寄售铺货' }] as { k: ExpenseType; t: string }[]).map((o) => (
            <TouchableOpacity key={o.k} style={[styles.segBtn, expenseType === o.k && styles.segBtnActive]} onPress={() => setExpenseTypeSafe(o.k)}>
              <Text style={[styles.segBtnText, expenseType === o.k && styles.segBtnTextActive]}>{o.t}</Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* 返钱：一次性结清 或 按计划分期（结算计划段，与 PC 端模板对齐） */}
        {expenseType === 1 ? (
          <View>
            {settlementTiming === 2 ? (
              <>
                <Text style={styles.fieldLabel}>结算方式</Text>
                <View style={styles.segRow}>
                  <TouchableOpacity style={[styles.segBtn, !planMode && styles.segBtnActive]} onPress={() => setPlanMode(false)}>
                    <Text style={[styles.segBtnText, !planMode && styles.segBtnTextActive]}>一次性结清</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={[styles.segBtn, planMode && styles.segBtnActive]} onPress={() => { setPlanMode(true); if (planList.length === 0) genSeasonal(); }}>
                    <Text style={[styles.segBtnText, planMode && styles.segBtnTextActive]}>按计划分期</Text>
                  </TouchableOpacity>
                </View>
              </>
            ) : (
              <Text style={{ fontSize: 12, color: theme.color.textAppTertiary, marginTop: 4 }}>现给：当场一次性付清，无到期日 / 分期</Text>
            )}
            {!planMode ? (
              <>
                {settlementTiming === 2 && (
                  <>
                    <Text style={styles.fieldLabel}>结账周期</Text>
                    <View style={styles.segRow}>
                      {([{ k: 1, t: '年结' }, { k: 2, t: '月结' }, { k: 3, t: '按次' }, { k: 5, t: '季度结' }, { k: 6, t: '自定义' }] as { k: SettleMethod; t: string }[]).map((o) => (
                        <TouchableOpacity key={o.k} style={[styles.segBtn, settleMethod === o.k && styles.segBtnActive]} onPress={() => setSettleMethod(o.k)}>
                          <Text style={[styles.segBtnText, settleMethod === o.k && styles.segBtnTextActive]}>{o.t}</Text>
                        </TouchableOpacity>
                      ))}
                    </View>
                  </>
                )}
                {settleMethod !== 3 ? (
                  <View>
                    <Text style={styles.fieldLabel}>到期日（年结/月结/季度结）</Text>
                    <DatePickerField value={dueDate} onChange={setDueDate} title="到期日" />
                  </View>
                ) : null}
                <Text style={styles.fieldLabel}>费用金额（元）*</Text>
                <TextInput style={styles.input} value={amount} {...numInput(setAmount)} placeholder="0.00" placeholderTextColor={theme.color.textAppTertiary} />
              </>
            ) : (
              <>
                {/* 快速模板（可选）：一键生成计划，随后可逐行微调 */}
                <Text style={styles.fieldLabel}>快速模板（可选）</Text>
                <View style={styles.chipRow}>
                  <TouchableOpacity style={styles.chip} onPress={genEqualMonthly}><Text style={styles.chipText}>按月均摊</Text></TouchableOpacity>
                  <TouchableOpacity style={styles.chip} onPress={genQuarterly}><Text style={styles.chipText}>按季</Text></TouchableOpacity>
                  <TouchableOpacity style={styles.chip} onPress={genSeasonal}><Text style={styles.chipText}>旺季淡季</Text></TouchableOpacity>
                  <TouchableOpacity style={styles.chip} onPress={() => setPlanList([])}><Text style={styles.chipText}>自定义</Text></TouchableOpacity>
                </View>

                <View style={styles.dualRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.fieldLabel}>费用总额（元）</Text>
                    <TextInput style={styles.input} value={amount} {...numInput(setAmount)} placeholder="按月均摊/按季需要" placeholderTextColor={theme.color.textAppTertiary} />
                  </View>
                  <View style={{ width: 12 }} />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.fieldLabel}>年份</Text>
                    <TextInput style={styles.input} value={planYear} keyboardType="number-pad" onChangeText={(v) => setPlanYear(v.replace(/[^0-9]/g, '').slice(0, 4))} placeholder="2026" placeholderTextColor={theme.color.textAppTertiary} />
                  </View>
                </View>
                <View style={styles.dualRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.fieldLabel}>期数</Text>
                    <TextInput style={styles.input} value={planCount} keyboardType="number-pad" onChangeText={(v) => setPlanCount(v.replace(/[^0-9]/g, '').slice(0, 2))} placeholder="6/8/12" placeholderTextColor={theme.color.textAppTertiary} />
                  </View>
                  <View style={{ width: 12 }} />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.fieldLabel}>起始月（1-12）</Text>
                    <TextInput style={styles.input} value={planStartMonth} keyboardType="number-pad" onChangeText={(v) => setPlanStartMonth(v.replace(/[^0-9]/g, '').slice(0, 2))} placeholder="1" placeholderTextColor={theme.color.textAppTertiary} />
                  </View>
                </View>
                <View style={styles.dualRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.fieldLabel}>旺季月返（元）</Text>
                    <TextInput style={styles.input} value={peakAmt} {...numInput(setPeakAmt)} placeholder="如 200" placeholderTextColor={theme.color.textAppTertiary} />
                  </View>
                  <View style={{ width: 12 }} />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.fieldLabel}>淡季月返（元）</Text>
                    <TextInput style={styles.input} value={offAmt} {...numInput(setOffAmt)} placeholder="如 100" placeholderTextColor={theme.color.textAppTertiary} />
                  </View>
                </View>
                <Text style={styles.fieldLabel}>旺季月份（可多选）</Text>
                <View style={styles.chipRow}>
                  {MONTH_OPTIONS.map((m) => {
                    const on = peakMonths.includes(m);
                    return (
                      <TouchableOpacity key={m} style={[styles.chip, on && styles.chipActive]} onPress={() => setPeakMonths((prev) => (prev.includes(m) ? prev.filter((x) => x !== m) : prev.concat(m)))}>
                        <Text style={[styles.chipText, on && styles.chipTextActive]}>{`${m}月`}</Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>

                {/* 计划子表：期次 / 金额 / 日期 / 备注 单行编辑 */}
                {planList.map((p) => (
                  <View key={p.seq} style={styles.planEditRow}>
                    <View style={styles.planEditSeqPill}>
                      <Text style={styles.planEditSeqText}>{p.seq}</Text>
                    </View>
                    <TextInput
                      style={[styles.input, styles.planEditAmt]}
                      value={p.planAmount === 0 || p.planAmount ? String(p.planAmount) : ''}
                      {...numInput((v) => updatePlanRow(p.seq, { planAmount: v }))}
                      placeholder="金额" placeholderTextColor={theme.color.textAppTertiary}
                    />
                    <DatePickerField
                      value={p.planDate || ''}
                      onChange={(v) => updatePlanRow(p.seq, { planDate: v })}
                      placeholder="yyyy-mm-dd"
                      title={`第${p.seq}期日期`}
                    />
                    <TextInput
                      style={[styles.input, styles.planEditRemark]}
                      value={p.remark || ''}
                      onChangeText={(v) => updatePlanRow(p.seq, { remark: v })}
                      placeholder="备注"
                      placeholderTextColor={theme.color.textAppTertiary}
                    />
                    <TouchableOpacity style={styles.planDelBtn} onPress={() => removePlanRow(p.seq)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                      <Text style={styles.planDelText}>×</Text>
                    </TouchableOpacity>
                  </View>
                ))}
                <TouchableOpacity style={styles.planAddBtn} onPress={addPlanRow}>
                  <Text style={styles.planAddText}>＋ 添加一期</Text>
                </TouchableOpacity>
                <View style={styles.planTotalRow}>
                  <Text style={styles.planNoVoucher}>{`共 ${planList.length} 期 · 各期可独立结算留凭证`}</Text>
                  <Text style={[styles.planAmtVal, { color: theme.color.primaryVivid }]}>{`计划合计 ${money(planTotal)}`}</Text>
                </View>
              </>
            )}
          </View>
        ) : expenseType === 2 ? (
          /* 返货：关联商品 + 周期返还实物，无单价/金额 */
          <View>
            <Text style={styles.fieldLabel}>关联商品 *（可手填/可搜索选择）</Text>
            <TextInput
              style={styles.input} value={productName}
              onChangeText={(v) => { setProductName(v); setProductId(0); }}
              placeholder="输入品名搜索，或选择下方匹配商品" placeholderTextColor={theme.color.textAppTertiary}
            />
            {productName.trim() && filteredProducts.length > 0 && (
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginTop: 8, marginBottom: 4 }}>
                {filteredProducts.map((p) => (
                  <TouchableOpacity
                    key={p.id}
                    style={[styles.chip, productId === p.id && styles.chipActive]}
                    onPress={() => { setProductName(p.name); setProductId(Number(p.id)); }}
                  >
                    <Text style={[styles.chipText, productId === p.id && styles.chipTextActive]}>{p.name}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            )}
            {productName.trim() && filteredProducts.length === 0 && productOptions.length > 0 && (
              <Text style={{ fontSize: 12, color: theme.color.textAppTertiary, marginTop: 4 }}>无匹配商品，将以手填保存</Text>
            )}
            <Text style={styles.fieldLabel}>返货周期</Text>
            <View style={styles.segRow}>
              {([
              { k: 1, t: '每月' }, { k: 2, t: '每年' }, { k: 3, t: '每季度' }, { k: 4, t: '自定义' },
            ] as { k: RebateCycle; t: string }[]).map((o) => (
                <TouchableOpacity key={o.k} style={[styles.segBtn, rebateCycle === o.k && styles.segBtnActive]} onPress={() => setRebateCycle(o.k)}>
                  <Text style={[styles.segBtnText, rebateCycle === o.k && styles.segBtnTextActive]}>{o.t}</Text>
                </TouchableOpacity>
              ))}
            </View>
            <View style={styles.dualRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.fieldLabel}>每期数量（件）*</Text>
                <TextInput style={styles.input} value={rebateQty} {...numInput(setRebateQty)} placeholder="如 6" placeholderTextColor={theme.color.textAppTertiary} />
              </View>
              <View style={{ width: 12 }} />
              <View style={{ flex: 1 }}>
                <Text style={styles.fieldLabel}>期限数（0=不限）</Text>
                <TextInput style={styles.input} value={rebateTotalPeriods} {...numInput(setRebateTotalPeriods)} placeholder="如 12" placeholderTextColor={theme.color.textAppTertiary} />
              </View>
            </View>
            <View style={styles.dualRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.fieldLabel}>首期日期</Text>
                <DatePickerField value={rebateStartDate} onChange={setRebateStartDate} title="首期日期" />
              </View>
              <View style={{ width: 12 }} />
              <View style={{ flex: 1 }}>
                <Text style={styles.fieldLabel}>到期时间（空=长期）</Text>
                <DatePickerField value={maturityDate} onChange={setMaturityDate} title="到期时间（空=长期）" allowEmpty />
              </View>
            </View>
          </View>
        ) : (
          /* 寄售铺货（两层模型）：一层=铺货商品明细(多行 ConsignItem，含正常/搭赠)，二层=到期结算方式(仅返钱/返货) */
          <View>
            <Text style={styles.fieldLabel}>铺货商品明细 *（每行一件，可手填品名；搭赠行不计货值）</Text>

            {consignItems.map((it, idx) => (
              <View key={idx} style={styles.consignItemCard}>
                <View style={styles.consignItemHead}>
                  <Text style={styles.consignItemTitle}>{`商品 ${idx + 1}${it.type === 'gift' ? ' · 搭赠' : ''}`}</Text>
                  <TouchableOpacity onPress={() => removeConsignItem(idx)}>
                    <Text style={styles.consignItemDel}>删除</Text>
                  </TouchableOpacity>
                </View>

                <Text style={styles.fieldLabel}>品名 *</Text>
                <TextInput
                  style={styles.input}
                  value={it.name}
                  onChangeText={(v) => updateConsignItem(idx, { name: v, productId: 0 })}
                  placeholder="如：可乐 330ml"
                  placeholderTextColor={theme.color.textAppTertiary}
                />

                <View style={styles.dualRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.fieldLabel}>数量 *</Text>
                    <TextInput style={styles.input} value={String(it.qty)} {...numInput((v) => updateConsignItem(idx, { qty: Number(v) || 0 }))} placeholder="如 100" placeholderTextColor={theme.color.textAppTertiary} />
                  </View>
                  <View style={{ width: 12 }} />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.fieldLabel}>单位</Text>
                    <TextInput style={styles.input} value={it.unit} onChangeText={(v) => updateConsignItem(idx, { unit: v })} placeholder="件" placeholderTextColor={theme.color.textAppTertiary} />
                  </View>
                </View>

                <View style={styles.dualRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.fieldLabel}>规格</Text>
                    <TextInput style={styles.input} value={it.spec} onChangeText={(v) => updateConsignItem(idx, { spec: v })} placeholder="选填" placeholderTextColor={theme.color.textAppTertiary} />
                  </View>
                  <View style={{ width: 12 }} />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.fieldLabel}>类型</Text>
                    <View style={styles.segRow}>
                      <TouchableOpacity style={[styles.segBtn, it.type !== 'gift' && styles.segBtnActive]} onPress={() => updateConsignItem(idx, { type: 'normal' })}>
                        <Text style={[styles.segBtnText, it.type !== 'gift' && styles.segBtnTextActive]}>正常</Text>
                      </TouchableOpacity>
                      <TouchableOpacity style={[styles.segBtn, it.type === 'gift' && styles.segBtnActive]} onPress={() => updateConsignItem(idx, { type: 'gift' })}>
                        <Text style={[styles.segBtnText, it.type === 'gift' && styles.segBtnTextActive]}>搭赠</Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                </View>

                <View style={styles.dualRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.fieldLabel}>{`进货价（元/${it.unit || '件'}）`}</Text>
                    <TextInput
                      style={[styles.input, it.type === 'gift' && styles.inputDisabled]}
                      value={it.type === 'gift' ? '0.00' : String(it.costPrice)}
                      editable={it.type !== 'gift'}
                      {...numInput((v) => updateConsignItem(idx, { costPrice: Number(v) || 0 }))}
                      placeholder="0.00" placeholderTextColor={theme.color.textAppTertiary}
                    />
                  </View>
                  <View style={{ width: 12 }} />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.fieldLabel}>{`零售价（元/${it.unit || '件'}）`}</Text>
                    <TextInput
                      style={[styles.input, it.type === 'gift' && styles.inputDisabled]}
                      value={it.type === 'gift' ? '0.00' : String(it.salePrice)}
                      editable={it.type !== 'gift'}
                      {...numInput((v) => updateConsignItem(idx, { salePrice: Number(v) || 0 }))}
                      placeholder="0.00" placeholderTextColor={theme.color.textAppTertiary}
                    />
                  </View>
                </View>
              </View>
            ))}

            <TouchableOpacity style={styles.addItemBtn} onPress={() => setConsignItems((prev) => [...prev, blankConsignItem()])}>
              <Text style={styles.addItemBtnText}>＋ 添加商品</Text>
            </TouchableOpacity>

            <View style={styles.summaryBox}>
              <Text style={styles.summaryText}>{`铺货总数量 ${consignTotalQty} 件 · 铺货总价值 ¥${round(consignTotalValue)}`}</Text>
            </View>


            <Text style={styles.fieldLabel}>寄售期限</Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <TextInput
                style={[styles.input, { flex: 1 }]}
                value={String(consignTermQty)}
                {...numInput((v) => {
                  const qty = Number(v) || 0;
                  setConsignTermQty(qty);
                  if (qty > 0) {
                    setConsignMaturity(dayjs(expenseDate).add(qty, consignTermUnit).format('YYYY-MM-DD'));
                  }
                })}
                placeholder="如 6"
                placeholderTextColor={theme.color.textAppTertiary}
              />
              <View style={[styles.segRow, { flex: 1 }]}>
                {(['天', '月', '年'] as const).map((u) => {
                  const unitMap: Record<typeof u, 'day' | 'month' | 'year'> = { 天: 'day', 月: 'month', 年: 'year' };
                  const unit = unitMap[u];
                  const active = consignTermUnit === unit;
                  return (
                    <TouchableOpacity
                      key={u}
                      style={[styles.segBtn, active && styles.segBtnActive]}
                      onPress={() => {
                        setConsignTermUnit(unit);
                        if (consignTermQty > 0) {
                          setConsignMaturity(dayjs(expenseDate).add(consignTermQty, unit).format('YYYY-MM-DD'));
                        }
                      }}
                    >
                      <Text style={[styles.segBtnText, active && styles.segBtnTextActive]}>{u}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>
            <Text style={styles.fieldLabel}>{settlementTiming === 1 ? '寄售到期日（货物处置提醒）*' : '寄售到期日 *'}</Text>
            <DatePickerField value={consignMaturity} onChange={setConsignMaturity} title="寄售到期日" />

            {expenseType === 3 && (
              <>
                <Text style={styles.fieldLabel}>结算方式（陈列费以现金或货物给付）</Text>
                <View style={styles.segRow}>
                  <TouchableOpacity style={[styles.segBtn, returnType === 1 && styles.segBtnActive]} onPress={() => setReturnType(1)}>
                    <Text style={[styles.segBtnText, returnType === 1 && styles.segBtnTextActive]}>现金（陈列费金额）</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={[styles.segBtn, returnType === 2 && styles.segBtnActive]} onPress={() => setReturnType(2)}>
                    <Text style={[styles.segBtnText, returnType === 2 && styles.segBtnTextActive]}>货物（供应商给付货物）</Text>
                  </TouchableOpacity>
                </View>
              </>
            )}

            {(returnType === 1) ? (
              <>
                <Text style={styles.fieldLabel}>陈列费金额（元）*</Text>
                <TextInput style={styles.input} value={amount} {...numInput(setAmount)} placeholder="0.00" placeholderTextColor={theme.color.textAppTertiary} />
              </>
            ) : (
              <>
                <Text style={styles.fieldLabel}>返货商品明细 *（每行一件，可手填或从商品库选择）</Text>
                {returnItems.map((it, idx) => {
                  const sugg = it.name.trim()
                    ? productOptions.filter((p) => p.name.toLowerCase().includes(it.name.trim().toLowerCase())).slice(0, 5)
                    : [];
                  return (
                    <View key={idx} style={styles.consignItemCard}>
                      <View style={styles.consignItemHead}>
                        <Text style={styles.consignItemTitle}>{`返货商品 ${idx + 1}`}</Text>
                        <TouchableOpacity onPress={() => removeReturnItem(idx)}>
                          <Text style={styles.consignItemDel}>删除</Text>
                        </TouchableOpacity>
                      </View>
                      <Text style={styles.fieldLabel}>品名 *</Text>
                      <TextInput
                        style={styles.input}
                        value={it.name}
                        onFocus={() => setReturnNameFocus(idx)}
                        onBlur={() => setReturnNameFocus(null)}
                        onChangeText={(v) => updateReturnItem(idx, { name: v, productId: 0 })}
                        placeholder="如：可乐 330ml"
                        placeholderTextColor={theme.color.textAppTertiary}
                      />
                      {returnNameFocus === idx && sugg.length > 0 ? (
                        <View style={styles.suggestBox}>
                          {sugg.map((p: Product) => (
                            <TouchableOpacity
                              key={String(p.id ?? p.name)}
                              style={styles.suggestItem}
                              onPress={() => {
                                updateReturnItem(idx, {
                                  name: p.name,
                                  productId: Number(p.id) || 0,
                                  unit: it.unit || p.unit || '件',
                                  spec: it.spec || p.spec || '',
                                });
                                setReturnNameFocus(null);
                              }}
                            >
                              <Text style={styles.suggestText}>{`${p.name}${p.spec ? `（${p.spec}）` : ''}`}</Text>
                            </TouchableOpacity>
                          ))}
                        </View>
                      ) : null}
                      <View style={styles.dualRow}>
                        <View style={{ flex: 1 }}>
                          <Text style={styles.fieldLabel}>数量 *</Text>
                          <TextInput style={styles.input} value={String(it.qty)} {...numInput((v) => updateReturnItem(idx, { qty: Number(v) || 0 }))} placeholder="如 100" placeholderTextColor={theme.color.textAppTertiary} />
                        </View>
                        <View style={{ width: 12 }} />
                        <View style={{ flex: 1 }}>
                          <Text style={styles.fieldLabel}>单位</Text>
                          <TextInput style={styles.input} value={it.unit} onChangeText={(v) => updateReturnItem(idx, { unit: v })} placeholder="件" placeholderTextColor={theme.color.textAppTertiary} />
                        </View>
                      </View>
                      <Text style={styles.fieldLabel}>规格</Text>
                      <TextInput style={styles.input} value={it.spec} onChangeText={(v) => updateReturnItem(idx, { spec: v })} placeholder="选填" placeholderTextColor={theme.color.textAppTertiary} />
                    </View>
                  );
                })}
                <TouchableOpacity style={styles.addItemBtn} onPress={() => setReturnItems((prev) => [...prev, blankReturnItem()])}>
                  <Text style={styles.addItemBtnText}>＋ 添加返货商品</Text>
                </TouchableOpacity>
                <View style={styles.summaryBox}>
                  <Text style={styles.summaryText}>{`返货总数量 ${returnTotalQty} 件`}</Text>
                </View>
              </>
            )}
            {/* 货物处置状态（独立于结算状态）：仅作展示，到期前无操作入口 */}
            <Text style={styles.fieldLabel}>货物处置状态</Text>
            <View style={[styles.segRow, { opacity: 0.85 }]}>
              {([{ k: 0, t: '待处置' }, { k: 1, t: '已拉走' }, { k: 2, t: '已续约' }] as { k: number; t: string }[]).map((o) => (
                <View key={o.k} style={[styles.segBtn, disposalStatus === o.k && styles.segBtnActive]}>
                  <Text style={[styles.segBtnText, disposalStatus === o.k && styles.segBtnTextActive]}>{DISPOSAL_STATUS_LABEL[o.k]}</Text>
                </View>
              ))}
            </View>
            <Text style={{ fontSize: 12, color: theme.color.textAppTertiary, marginTop: 4 }}>到期前仅作提醒，到期后（拉走 / 续约）方可处置，与费用结算无关</Text>
          </View>
        )}

        {/* 项目说明 */}
        <Text style={styles.fieldLabel}>项目说明</Text>
        <TextInput style={styles.input} value={item} onChangeText={setItem} placeholder="如：端架陈列费 / 堆头费" placeholderTextColor={theme.color.textAppTertiary} />

        {/* 发生日期 */}
        <Text style={styles.fieldLabel}>发生日期 *</Text>
        <DatePickerField
          value={expenseDate}
          onChange={(d: string) => {
            setExpenseDate(d);
            if (expenseType === 3 && consignTermQty > 0) {
              setConsignMaturity(dayjs(d).add(consignTermQty, consignTermUnit).format('YYYY-MM-DD'));
            }
          }}
          title="发生日期"
        />

        {/* 备注 */}
        <Text style={styles.fieldLabel}>备注</Text>
        <TextInput style={[styles.input, styles.textArea]} value={remark} onChangeText={setRemark} placeholder="选填" placeholderTextColor={theme.color.textAppTertiary} multiline numberOfLines={3} />

        {/* 图片拍照上传 */}
        <Text style={styles.fieldLabel}>图片凭证（合同 / 实拍）</Text>
        <View style={styles.imgGrid}>
          {images.map((u, idx) => (
            <View key={idx} style={styles.imgWrap}>
              <TouchableOpacity onPress={() => setPreviewUri(toAbsoluteUrl(baseUrl, u))} activeOpacity={0.8} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
                <Image source={{ uri: toAbsoluteUrl(baseUrl, u) }} style={styles.imgThumb} resizeMode="cover" />
              </TouchableOpacity>
              <TouchableOpacity style={styles.imgDel} onPress={() => setImages((prev) => prev.filter((_, i) => i !== idx))}>
                <Text style={styles.imgDelText}>×</Text>
              </TouchableOpacity>
            </View>
          ))}
          <TouchableOpacity style={styles.imgAdd} onPress={openCamera} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
            <Text style={styles.imgAddText}>＋ 拍照</Text>
          </TouchableOpacity>
        </View>

        <TouchableOpacity style={[styles.saveBtn, saving && { opacity: 0.6 }]} disabled={saving} onPress={submit}>
          <Text style={styles.saveBtnText}>{saving ? '保存中…' : (e ? '保存修改' : '保存')}</Text>
        </TouchableOpacity>
      </ScrollView>

      {/* 相机 Modal */}
      <Modal visible={camOpen} animationType="slide">
        <View style={styles.camRoot}>
          <CameraView ref={camRef} style={styles.camView} facing={camType} />
          <View style={styles.camBar}>
            <TouchableOpacity style={styles.camBtn} onPress={() => setCamOpen(false)}>
              <Text style={styles.camBtnText}>取消</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.camShutter} onPress={snap}>
              <Text style={styles.camShutterText}>拍</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.camBtn} onPress={() => setCamType((t) => (t === 'back' ? 'front' : 'back'))}>
              <Text style={styles.camBtnText}>翻转</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* 图片全屏预览 */}
      <Modal visible={!!previewUri} transparent animationType="fade" onRequestClose={() => setPreviewUri(null)}>
        <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.92)', justifyContent: 'center', alignItems: 'center' }}>
          <TouchableOpacity style={{ position: 'absolute', top: 48, right: 20, zIndex: 10, padding: 12 }} onPress={() => setPreviewUri(null)}>
            <Text style={{ color: '#fff', fontSize: 18 }}>✕</Text>
          </TouchableOpacity>
          {previewUri ? (
            <Image source={{ uri: previewUri }} style={{ width: '100%', height: '80%' }} resizeMode="contain" />
          ) : null}
        </View>
      </Modal>
    </View>
  );
}

// ============ 现场结算 Modal ============
function SettleModal({ theme, styles, baseUrl, target, settlements, presetPlanSeq, onClose, onConfirm }: any) {
  const [amount, setAmount] = useState('');
  const [payment, setPayment] = useState<PaymentMethod>(1);
  const [settleDate, setSettleDate] = useState(todayStr());
  const [remark, setRemark] = useState('');
  const [settleImages, setSettleImages] = useState<string[]>([]);
  const [previewUri, setPreviewUri] = useState<string | null>(null);
  const [planSeq, setPlanSeq] = useState<number | null>(null); // 分期计划：本次结算对应期次
  const [camOpen, setCamOpen] = useState(false);
  const [camType, setCamType] = useState<CameraType>('back');
  const [permission, requestPermission] = useCameraPermissions();
  const camRef = React.useRef<any>(null);

  const planPeriods: PlanPeriod[] = Array.isArray(target?.planJson) ? target.planJson : [];
  const hasPlan = planPeriods.length > 0;
  const selPeriod = planPeriods.find((p) => p.seq === planSeq);
  const selOverdue = !!selPeriod && selPeriod.status === 0 && !!selPeriod.planDate && selPeriod.planDate < todayStr();

  const amountForPeriod = (p: PlanPeriod | undefined) =>
    p ? Math.max(0, (Number(p.planAmount) || 0) - (Number(p.settledAmount) || 0)).toFixed(2) : '';

  React.useEffect(() => {
    if (target) {
      const plans: PlanPeriod[] = Array.isArray(target.planJson) ? target.planJson : [];
      const open = plans.filter((p) => p.status === 0);
      const defSeq = presetPlanSeq != null ? presetPlanSeq : (open[0] ? open[0].seq : null);
      setPlanSeq(defSeq);
      const sel = plans.find((p) => p.seq === defSeq);
      if (sel) setAmount(amountForPeriod(sel));
      else setAmount(target.unsettledAmount ? target.unsettledAmount.toFixed(2) : '');
      setPayment(isRebateLikeExpense(target) ? 3 : 1);
      setSettleDate(todayStr());
      setRemark('');
      setSettleImages([]);
    }
  }, [target, presetPlanSeq]);

  const isRebate = isRebateLikeExpense(target);
  const rebatePeriods = isRebate ? buildRebatePeriods(target, settlements || []) : [];
  const rebateSettled = rebatePeriods.filter((p) => p.settled).length;
  // 返货确认收货：允许像返钱那样「指定某个月」——默认选中当前待收期（已收+1），可改选其它未收期
  const rebateCurrentSeq = rebatePeriods.find((p) => !p.settled)?.seq ?? null;
  const rebateEffSeq = planSeq != null ? planSeq : rebateCurrentSeq;
  const rebateSelPeriod = rebatePeriods.find((p) => p.seq === rebateEffSeq) || null;
  const rebateSelOverdue = !!(rebateSelPeriod && !rebateSelPeriod.settled && rebateSelPeriod.planDate && rebateSelPeriod.planDate < todayStr());

  const openCamera = async () => {
    if (!permission?.granted) {
      const r = await requestPermission();
      if (!r.granted) { Alert.alert('需要相机权限才能拍照'); return; }
    }
    setCamOpen(true);
  };
  const snap = async () => {
    try {
      const photo = await camRef.current?.takePictureAsync({ quality: 0.7, skipProcessing: false });
      setCamOpen(false);
      if (!photo?.uri) { Alert.alert('拍照失败', '未能获取照片'); return; }
      const name = (target?.supplierName || '费用单').replace(/\s+/g, '');
      const url = await uploadExpenseImage(baseUrl, photo.uri, name, todayStr());
      setSettleImages((prev) => [...prev, url].slice(0, 3));
    } catch (e: any) {
      setCamOpen(false);
      Alert.alert('上传失败', e?.message || '');
    }
  };
  const renderSettleImages = () => (
    <View>
      <Text style={styles.fieldLabel}>凭证图片（最多3张）</Text>
      <View style={styles.imgGrid}>
          {settleImages.map((u, idx) => (
            <View key={idx} style={styles.imgWrap}>
              <TouchableOpacity onPress={() => setPreviewUri(toAbsoluteUrl(baseUrl, u))} activeOpacity={0.8} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
                <Image source={{ uri: toAbsoluteUrl(baseUrl, u) }} style={styles.imgThumb} resizeMode="cover" />
              </TouchableOpacity>
              <TouchableOpacity style={styles.imgDel} onPress={() => setSettleImages((prev) => prev.filter((_, i) => i !== idx))}>
                <Text style={styles.imgDelText}>×</Text>
              </TouchableOpacity>
            </View>
          ))}
        {settleImages.length < 3 ? (
          <TouchableOpacity style={styles.imgAdd} onPress={openCamera} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
            <Text style={styles.imgAddText}>＋ 拍照</Text>
          </TouchableOpacity>
        ) : null}
      </View>
    </View>
  );

  if (!target) return null;
  const numInput = (setter: (v: string) => void) => ({
    keyboardType: 'numeric' as const,
    onChangeText: (v: string) => setter(v.replace(/[^0-9.]/g, '')),
  });

  return (
    <>
    <Modal visible={!!target || camOpen} animationType="slide" onRequestClose={camOpen ? () => setCamOpen(false) : onClose}>
      <View style={styles.modalRoot}>
        {camOpen ? (
          <View style={styles.camRoot}>
            <CameraView ref={camRef} style={styles.camView} facing={camType} />
            <View style={styles.camBar}>
              <TouchableOpacity style={styles.camBtn} onPress={() => setCamOpen(false)}>
                <Text style={styles.camBtnText}>取消</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.camShutter} onPress={snap}>
                <Text style={styles.camShutterText}>拍</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.camBtn} onPress={() => setCamType((t) => (t === 'back' ? 'front' : 'back'))}>
                <Text style={styles.camBtnText}>翻转</Text>
              </TouchableOpacity>
            </View>
          </View>
        ) : (
          <>
            <SafeAreaHeader style={styles.header}>
              <TouchableOpacity style={styles.backBtn} onPress={onClose} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                <Text style={styles.backText}>取消</Text>
              </TouchableOpacity>
              <Text style={styles.headerTitle}>{isRebate ? '确认收货' : '现场结算'}</Text>
              <View style={styles.subSpacer} />
            </SafeAreaHeader>
            <ScrollView style={styles.body} contentContainerStyle={styles.content}>
              {isRebate ? (
                <>
                  <Text style={styles.hint}>{target.supplierName} · 选择期次后确认收货</Text>
                  <View style={styles.card}>
                    <Text style={styles.sectionTitle}>返货期次（已收 {rebateSettled} / 共 {rebatePeriods.length} 期）</Text>
                    <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
                      {rebatePeriods.map((p, i) => {
                        const isCurrent = !p.settled && i === rebateSettled;
                        const isOverdue = !p.settled && p.planDate && p.planDate < todayStr();
                        const selected = p.seq === rebateEffSeq;
                        const pillColor = p.settled ? theme.color.success : isOverdue ? theme.color.danger : isCurrent ? theme.color.primaryVivid : theme.color.textAppTertiary;
                        const pillText = p.settled ? '已结' : isOverdue ? '逾期' : '待结';
                        const borderColor = selected ? theme.color.primaryVivid : pillColor;
                        const bg = selected ? theme.color.primarySoft : pillColor + '0D';
                        return (
                          <TouchableOpacity key={p.seq} style={{ width: '25%', padding: 4 }} activeOpacity={0.7}
                            onPress={() => {
                              if (p.settled) { Alert.alert(`第${p.seq}期`, '该期已确认收货，无需重复操作'); return; }
                              setPlanSeq(p.seq);
                            }}>
                            <View style={{ borderWidth: selected ? 2 : 1, borderColor, borderRadius: 8, paddingVertical: 8, paddingHorizontal: 4, alignItems: 'center', backgroundColor: bg }}>
                              <Text style={{ fontSize: 12, fontWeight: theme.font.weight.semibold, color: pillColor }}>第{p.seq}期{selected ? '（选）' : ''}</Text>
                              <Text style={{ fontSize: 11, color: theme.color.textAppSecondary, marginTop: 2 }}>{p.planDate ? p.planDate.slice(0, 7) : '—'}</Text>
                              <Text style={{ fontSize: 11, color: theme.color.textAppSecondary, marginTop: 2 }}>应返 {p.planQty}{target.rebateUnit || ''}</Text>
                              <View style={{ marginTop: 4, backgroundColor: pillColor, borderRadius: 4, paddingHorizontal: 6, paddingVertical: 1 }}>
                                <Text style={{ fontSize: 10, color: '#fff' }}>{pillText}</Text>
                              </View>
                            </View>
                          </TouchableOpacity>
                        );
                      })}
                    </View>
                  </View>
                  {/* 已收期次明细：每期备注 + 凭证（与 PC 详情一致，按 rebate_seq 关联） */}
                  {rebatePeriods.some((p) => p.settled) ? (
                    <View style={styles.card}>
                      <Text style={styles.sectionTitle}>已收期次明细</Text>
                      {rebatePeriods.filter((p) => p.settled).map((p, idx) => {
                        const imgs = (p.images || []).filter((im: any) => im && im.url);
                        return (
                          <View key={p.seq} style={{ borderTopWidth: idx === 0 ? 0 : 1, borderTopColor: theme.color.dividerApp, paddingVertical: 8 }}>
                            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                              <Text style={{ fontWeight: theme.font.weight.semibold, color: theme.color.textApp }}>{`第 ${p.seq} 期 · ${p.planDate || '—'}`}</Text>
                              <Text style={{ fontSize: 12, color: theme.color.success }}>已收 {p.planQty}{target.rebateUnit || ''}</Text>
                            </View>
                            {p.remark ? <Text style={[styles.planRemark, { marginTop: 2 }]}>{`备注：${p.remark}`}</Text> : null}
                            {imgs.length > 0 ? (
                              <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginTop: 6 }}>
                                {imgs.map((im: any, k: number) => (
                                  (im.url || '').toLowerCase().endsWith('.pdf') ? (
                                    <Text key={k} style={styles.planNoVoucher}>📄 PDF凭证 </Text>
                                  ) : (
                                    <TouchableOpacity key={k} onPress={() => setPreviewUri(toAbsoluteUrl(baseUrl, im.url))} activeOpacity={0.8} hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}>
                                      <Image source={{ uri: toAbsoluteUrl(baseUrl, im.url) }} style={{ width: 44, height: 44, borderRadius: 6, marginRight: 6, borderWidth: 1, borderColor: theme.color.dividerApp }} />
                                    </TouchableOpacity>
                                  )
                                ))}
                              </View>
                            ) : null}
                          </View>
                        );
                      })}
                    </View>
                  ) : null}
                  {rebateSelOverdue ? (
                    <Text style={[styles.hint, { color: theme.color.danger, marginTop: 4 }]}>⚠ 所选期次已逾期，本次确认将记为补收</Text>
                  ) : null}
                  <View style={styles.card}>
                    <InfoRow label="关联商品" value={`${target.productName || '—'}`} />
                    <InfoRow label="每期" value={`${round(target.rebateQty)}${target.rebateUnit || '件'}`} />
                    <InfoRow label="本期（下次）" value={rebateSelPeriod?.planDate || target.nextRebateDate || '—'} />
                    <InfoRow label="说明" value={Number(target?.rebateTotalPeriods) === 1 ? '确认后本期结清，无需再推进' : '确认后记为「返货确认收货」并自动推进下一期'} />
                  </View>
                  <Text style={styles.fieldLabel}>收货日期 *</Text>
                  <DatePickerField value={settleDate} onChange={setSettleDate} title="收货日期" />
                  <Text style={styles.fieldLabel}>备注</Text>
                  <TextInput style={styles.input} value={remark} onChangeText={setRemark} placeholder="选填" placeholderTextColor={theme.color.textAppTertiary} />
                  {renderSettleImages()}
                  <TouchableOpacity style={styles.saveBtn} onPress={() => {
                    if (rebateEffSeq == null) { Alert.alert('该返货协议已全部返完'); return; }
                    const selDate = rebateSelPeriod?.planDate || target.nextRebateDate || '';
                    const singlePeriod = Number(target?.rebateTotalPeriods) === 1;
                    const msg = singlePeriod
                      ? `确认第${rebateEffSeq}期返货收货？\n对应日期：${selDate}，确认后本期结清，无需再推进。`
                      : `确认第${rebateEffSeq}期返货收货？\n对应日期：${selDate}，确认后将登记该期返货并推进下一期。`;
                    Alert.alert('二次确认', msg, [
                      { text: '取消', style: 'cancel' },
                      { text: '确认收货', onPress: () => {
                        void onConfirm({
                          settleAmount: undefined,
                          paymentMethod: 3,
                          settleDate: settleDate.trim().slice(0, 10),
                          remark: remark.trim(),
                          images: settleImages.map((u) => ({ imageUrl: u, imageId: null })),
                          planSeq: rebateEffSeq,
                        });
                      }}
                    ]);
                  }}>
                    <Text style={styles.saveBtnText}>确认收货</Text>
                  </TouchableOpacity>
                </>
              ) : (
                <>
                  <Text style={styles.hint}>
                    {target.supplierName} · 未结算 {money(target.unsettledAmount)}（{EXPENSE_TYPE_LABEL[target.expenseType as ExpenseType]}）
                  </Text>

                  {hasPlan ? (
                    <>
                      <Text style={styles.fieldLabel}>结算期次</Text>
                      <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginBottom: 8 }}>
                        {planPeriods.map((p) => {
                          const od = p.status === 0 && !!p.planDate && p.planDate < todayStr();
                          const done = p.status === 1;
                          const active = planSeq === p.seq;
                          const borderColor = active ? theme.color.primaryVivid : od ? theme.color.danger : theme.color.dividerApp;
                          const bg = active ? theme.color.primarySoft : theme.color.surfaceApp;
                          return (
                            <TouchableOpacity
                              key={p.seq}
                              disabled={p.status !== 0}
                              onPress={() => { setPlanSeq(p.seq); setAmount(amountForPeriod(p)); }}
                              style={{ width: '23.5%', marginRight: '2%', marginBottom: 8, borderWidth: 1, borderColor, borderRadius: 8, paddingVertical: 8, paddingHorizontal: 6, backgroundColor: bg, opacity: done && !active ? 0.6 : 1 }}
                            >
                              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                                <Text style={{ fontWeight: '600', fontSize: 12 }}>{`第${p.seq}期`}</Text>
                                <Text style={{ fontSize: 10, color: done ? theme.color.success : od ? theme.color.danger : theme.color.warning }}>{done ? '已结' : od ? '逾期' : '待结'}</Text>
                              </View>
                              <Text style={{ fontSize: 11, color: theme.color.textAppTertiary }}>{p.planDate || '—'}</Text>
                              <Text style={{ fontSize: 12, marginTop: 2 }}>{`应结 ${money(Number(p.planAmount) || 0)}`}</Text>
                            </TouchableOpacity>
                          );
                        })}
                      </View>
                      {selOverdue ? (
                        <Text style={[styles.hint, { color: theme.color.danger, marginTop: 4 }]}>⚠ 所选期次已逾期，本次结算将视为补交</Text>
                      ) : null}
                    </>
                  ) : null}

                  <Text style={styles.fieldLabel}>结算金额（元）*</Text>
                  <TextInput style={styles.input} value={amount} {...numInput(setAmount)} placeholder="0.00" placeholderTextColor={theme.color.textAppTertiary} />

                  <Text style={styles.fieldLabel}>支付方式</Text>
                  <View style={styles.segRow}>
                    {([{ k: 1, t: '转账' }, { k: 2, t: '现金' }, { k: 3, t: '冲抵货款' }, { k: 4, t: '其他' }] as { k: PaymentMethod; t: string }[]).map((o) => (
                      <TouchableOpacity key={o.k} style={[styles.segBtn, payment === o.k && styles.segBtnActive]} onPress={() => setPayment(o.k)}>
                        <Text style={[styles.segBtnText, payment === o.k && styles.segBtnTextActive]}>{o.t}</Text>
                      </TouchableOpacity>
                    ))}
                  </View>

                  <Text style={styles.fieldLabel}>结算日期 *</Text>
                  <DatePickerField value={settleDate} onChange={setSettleDate} title="结算日期" />

                  <Text style={styles.fieldLabel}>备注</Text>
                  <TextInput style={styles.input} value={remark} onChangeText={setRemark} placeholder="选填" placeholderTextColor={theme.color.textAppTertiary} />

                  {renderSettleImages()}

                  <TouchableOpacity style={styles.saveBtn} onPress={() => {
                    const a = Number(amount.replace(/[^0-9.]/g, '')) || 0;
                    if (a <= 0) { Alert.alert('请输入结算金额'); return; }
                    if (hasPlan && planSeq == null) { Alert.alert('请选择结算期次'); return; }
                    void onConfirm({
                      settleAmount: a, paymentMethod: payment, settleDate: settleDate.trim().slice(0, 10), remark: remark.trim(),
                      images: settleImages.map((u) => ({ imageUrl: u, imageId: null })),
                      ...(hasPlan && planSeq != null ? { planSeq } : {}),
                    });
                  }}>
                    <Text style={styles.saveBtnText}>确认结算 {money(Number(amount.replace(/[^0-9.]/g, '') || 0))}</Text>
                  </TouchableOpacity>
                </>
              )}
            </ScrollView>
          </>
        )}
      </View>
    </Modal>

    {/* 图片全屏预览 */}
    <Modal visible={!!previewUri} transparent animationType="fade" onRequestClose={() => setPreviewUri(null)}>
      <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.92)', justifyContent: 'center', alignItems: 'center' }}>
        <TouchableOpacity style={{ position: 'absolute', top: 48, right: 20, zIndex: 10, padding: 12 }} onPress={() => setPreviewUri(null)}>
          <Text style={{ color: '#fff', fontSize: 18 }}>✕</Text>
        </TouchableOpacity>
        {previewUri ? (
          <Image source={{ uri: previewUri }} style={{ width: '100%', height: '80%' }} resizeMode="contain" />
        ) : null}
      </View>
    </Modal>
    </>
  );
}

// ============ 冲正 Modal ============
function ReverseModal({ theme, styles, target, onClose, onConfirm }: any) {
  const [amount, setAmount] = useState('');
  const [payment, setPayment] = useState<PaymentMethod>(1);
  const [remark, setRemark] = useState('');
  const [saving, setSaving] = useState(false);
  const isRebate = isRebateLikeExpense(target ?? { expenseType: 0 });
  const seqs = target?.rebateSettledPeriods || [];
  const lastSeq = isRebate && seqs.length ? Math.max(...seqs) : 0;

  React.useEffect(() => {
    if (target) {
      setAmount(target.settledAmount ? target.settledAmount.toFixed(2) : '');
      setPayment(1);
      setRemark('');
      setSaving(false);
    }
  }, [target]);

  if (!target) return null;
  const numInput = (setter: (v: string) => void) => ({
    keyboardType: 'numeric' as const,
    onChangeText: (v: string) => setter(v.replace(/[^0-9.]/g, '')),
  });

  return (
    <Modal visible={!!target} animationType="slide" onRequestClose={onClose}>
      <View style={styles.root}>
        <SafeAreaHeader style={styles.header}>
          <TouchableOpacity style={styles.backBtn} onPress={onClose} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <Text style={styles.backText}>取消</Text>
          </TouchableOpacity>
          <Text style={styles.headerTitle}>{isRebate ? '冲正返货' : '冲正结算'}</Text>
          <View style={styles.subSpacer} />
        </SafeAreaHeader>
        <ScrollView style={styles.body} contentContainerStyle={styles.content}>
          {isRebate ? (
            <Text style={styles.hint}>{target.supplierName} · 将撤销最近一次确认收货（第 {lastSeq} 期），该期回到待收、可重新确认</Text>
          ) : (
            <Text style={styles.hint}>{target.supplierName} · 已结算 {money(target.settledAmount)}，冲正用于纠错并记录负数</Text>
          )}
          {!isRebate && (
            <>
              <Text style={styles.fieldLabel}>冲正金额（元）*</Text>
              <TextInput style={styles.input} value={amount} {...numInput(setAmount)} placeholder="0.00" placeholderTextColor={theme.color.textAppTertiary} />
              <Text style={styles.fieldLabel}>支付方式</Text>
              <View style={styles.segRow}>
                {([{ k: 1, t: '转账' }, { k: 2, t: '现金' }, { k: 3, t: '冲抵货款' }, { k: 4, t: '其他' }] as { k: PaymentMethod; t: string }[]).map((o) => (
                  <TouchableOpacity key={o.k} style={[styles.segBtn, payment === o.k && styles.segBtnActive]} onPress={() => setPayment(o.k)}>
                    <Text style={[styles.segBtnText, payment === o.k && styles.segBtnTextActive]}>{o.t}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            </>
          )}
          <Text style={styles.fieldLabel}>备注</Text>
          <TextInput style={[styles.input, styles.textArea]} value={remark} onChangeText={setRemark} placeholder="冲正原因" placeholderTextColor={theme.color.textAppTertiary} multiline numberOfLines={3} />
          <TouchableOpacity style={[styles.saveBtn, saving && { opacity: 0.6 }]} disabled={saving} onPress={() => {
            if (isRebate) {
              setSaving(true);
              void onConfirm({ remark: remark.trim() });
              return;
            }
            const a = Number(amount.replace(/[^0-9.]/g, '')) || 0;
            if (a <= 0) { Alert.alert('请输入冲正金额'); return; }
            setSaving(true);
            void onConfirm({ settleAmount: a, paymentMethod: payment, remark: remark.trim() });
          }}>
            <Text style={styles.saveBtnText}>{saving ? '提交中…' : '确认冲正'}</Text>
          </TouchableOpacity>
        </ScrollView>
      </View>
    </Modal>
  );
}

// ============ 样式 ============
function makeStyles(theme: any) {
  const S = theme.size;
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: theme.color.bgApp },
    body: { flex: 1 },
    content: { padding: theme.spaceScale[4], paddingBottom: 32 },
    header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: theme.spaceScale[4], paddingVertical: theme.spaceScale[3], borderBottomWidth: 1, borderBottomColor: theme.color.dividerApp, backgroundColor: theme.color.surfaceApp },
    backBtn: { minHeight: 44, justifyContent: 'center' },
    backText: { fontSize: theme.font.sizeV4.body, color: theme.color.primaryVivid },
    headerTitle: { fontSize: theme.font.sizeV4.h4, fontWeight: theme.font.weight.semibold, color: theme.color.textApp },
    subSpacer: { width: 56 },
    addTopBtn: { backgroundColor: theme.color.primaryVivid, borderRadius: theme.radius.md, paddingHorizontal: 12, paddingVertical: 6 },
    addTopBtnText: { color: '#fff', fontSize: 13, fontWeight: theme.font.weight.medium },

    statGrid: { flexDirection: 'row', gap: theme.spaceScale[2], marginBottom: theme.spaceScale[3] },
    statCell: { backgroundColor: theme.color.surfaceApp, borderRadius: theme.radius.md, padding: theme.spaceScale[3], flex: 1 },
    statLabel: { fontSize: 12, color: theme.color.textAppTertiary },
    statValue: { fontSize: 16, fontWeight: theme.font.weight.bold, color: theme.color.textApp, marginTop: 4, fontVariant: ['tabular-nums'] },

    filterCard: { backgroundColor: theme.color.surfaceApp, borderRadius: theme.radius.lg, padding: theme.spaceScale[3], marginBottom: theme.spaceScale[3] },
    searchInput: { backgroundColor: theme.color.surfaceSunken, borderWidth: 1, borderColor: theme.color.borderApp, borderRadius: theme.radius.md, height: S.controlLg, paddingHorizontal: theme.spaceScale[3], color: theme.color.textApp, fontSize: theme.font.sizeV4.body, marginBottom: theme.spaceScale[3] },
    segRow: { flexDirection: 'row', gap: theme.spaceScale[2], marginTop: theme.spaceScale[2] },
    segBtn: { flex: 1, borderWidth: 1, borderColor: theme.color.borderApp, borderRadius: theme.radius.md, height: 40, alignItems: 'center', justifyContent: 'center' },
    segBtnActive: { backgroundColor: theme.color.primarySoft, borderColor: theme.color.primaryVivid },
    segBtnText: { color: theme.color.textAppSecondary, fontSize: theme.font.sizeV4.body },
    segBtnTextActive: { color: theme.color.primaryVivid, fontWeight: theme.font.weight.medium },
    switchRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: theme.spaceScale[3] },
    switchLabel: { fontSize: theme.font.sizeV4.body, color: theme.color.textApp },

    itemCard: { flexDirection: 'row', alignItems: 'stretch', backgroundColor: theme.color.surfaceApp, borderRadius: theme.radius.lg, overflow: 'hidden' },
    itemMain: { flex: 1, padding: theme.spaceScale[4] },
    itemTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    itemNo: { fontSize: theme.font.sizeV4.bodySm, color: theme.color.textAppTertiary },
    itemSupplier: { fontSize: theme.font.sizeV4.bodyLg, fontWeight: theme.font.weight.semibold, color: theme.color.textApp, marginTop: 4 },
    itemBrand: { fontSize: 12, color: theme.color.primaryVivid, backgroundColor: theme.color.primarySoft, alignSelf: 'flex-start', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 6, marginTop: 4, fontWeight: theme.font.weight.medium },
    itemItem: { fontSize: theme.font.sizeV4.caption, color: theme.color.textAppSecondary, marginTop: 2 },
    itemAmountRow: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', marginTop: theme.spaceScale[2] },
    itemAmount: { fontSize: 17, fontWeight: theme.font.weight.bold, color: theme.color.textApp, fontVariant: ['tabular-nums'] },
    itemUnsettled: { fontSize: theme.font.sizeV4.caption, color: theme.color.warning },
    itemConsignInfo: { fontSize: 12, color: theme.color.primaryVivid, backgroundColor: theme.color.primarySoft, alignSelf: 'flex-start', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 6, marginTop: theme.spaceScale[2], fontWeight: theme.font.weight.medium },
    itemFoot: { flexDirection: 'row', alignItems: 'center', gap: theme.spaceScale[2], marginTop: theme.spaceScale[2] },
    overdueTag: { fontSize: 12, color: '#fff', backgroundColor: theme.color.danger, paddingHorizontal: 8, paddingVertical: 2, borderRadius: 6, fontWeight: theme.font.weight.medium },
    methodTag: { fontSize: 12, color: theme.color.textAppTertiary },
    settlePill: { flex: 1, backgroundColor: theme.color.primaryVivid, alignItems: 'center', justifyContent: 'center', paddingVertical: 10 },
    settlePillText: { color: '#fff', fontSize: 14, fontWeight: theme.font.weight.medium },
    itemActions: { width: 64, justifyContent: 'center' },
    morePill: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.color.surfaceSunken },
    morePillText: { fontSize: 20, color: theme.color.textAppSecondary, lineHeight: 24 },

    empty: { backgroundColor: theme.color.surfaceApp, borderRadius: theme.radius.lg, padding: theme.spaceScale[6], alignItems: 'center', marginTop: theme.spaceScale[3] },
    emptyText: { color: theme.color.textAppTertiary, fontSize: 14 },
    emptySub: { color: theme.color.textAppTertiary, fontSize: 12, marginTop: 6 },

    card: { backgroundColor: theme.color.surfaceApp, borderRadius: theme.radius.lg, padding: theme.spaceScale[4], marginBottom: theme.spaceScale[3] },
    sectionTitle: { fontSize: theme.font.sizeV4.h4, fontWeight: theme.font.weight.semibold, color: theme.color.textApp, marginBottom: theme.spaceScale[3] },
    amountRow: { flexDirection: 'row' },
    amountCol: { flex: 1 },
    amountLabel: { fontSize: 12, color: theme.color.textAppTertiary },
    amountVal: { fontSize: 18, fontWeight: theme.font.weight.bold, marginTop: 2, fontVariant: ['tabular-nums'] },
    overdueLine: { fontSize: theme.font.sizeV4.caption, marginTop: theme.spaceScale[2] },

    settleRow: { paddingVertical: theme.spaceScale[2] },
    settleAmt: { fontSize: theme.font.sizeV4.bodyLg, fontWeight: theme.font.weight.semibold, color: theme.color.textApp },
    settleMeta: { fontSize: theme.font.sizeV4.caption, color: theme.color.textAppTertiary, marginTop: 2 },

    imgGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.spaceScale[2], marginTop: theme.spaceScale[2] },
    imgWrap: { position: 'relative' },
    imgThumb: { width: 84, height: 84, borderRadius: theme.radius.md, backgroundColor: theme.color.surfaceSunken },
    imgDel: { position: 'absolute', top: -6, right: -6, width: 22, height: 22, borderRadius: 11, backgroundColor: theme.color.danger, alignItems: 'center', justifyContent: 'center' },
    imgDelText: { color: '#fff', fontSize: 14, fontWeight: theme.font.weight.bold },
    imgAdd: { width: 84, height: 84, borderRadius: theme.radius.md, borderWidth: 1, borderStyle: 'dashed', borderColor: theme.color.borderApp, alignItems: 'center', justifyContent: 'center' },
    imgAddText: { color: theme.color.primaryVivid, fontSize: 13 },

    fieldLabel: { fontSize: theme.font.sizeV4.caption, color: theme.color.textAppSecondary, marginBottom: theme.spaceScale[2], marginTop: theme.spaceScale[3] },
    input: { backgroundColor: theme.color.surfaceSunken, borderWidth: 1, borderColor: theme.color.borderApp, borderRadius: theme.radius.md, height: S.controlLg, paddingHorizontal: theme.spaceScale[4], color: theme.color.textApp, fontSize: theme.font.sizeV4.body },
    consignRemainBox: { justifyContent: 'center', backgroundColor: theme.color.primarySoft, borderColor: theme.color.primaryVivid },
    consignRemainText: { color: theme.color.primaryVivid, fontSize: theme.font.sizeV4.body, fontWeight: theme.font.weight.semibold },

    // 寄售铺货（两层模型）：多行商品明细卡 / 添加按钮 / 汇总 / 详情行
    consignItemCard: { backgroundColor: theme.color.surfaceSunken, borderWidth: 1, borderColor: theme.color.borderApp, borderRadius: theme.radius.lg, padding: theme.spaceScale[3], marginTop: theme.spaceScale[3] },
    consignItemHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: theme.spaceScale[2] },
    consignItemTitle: { fontSize: theme.font.sizeV4.body, fontWeight: theme.font.weight.semibold, color: theme.color.textApp },
    consignItemDel: { fontSize: theme.font.sizeV4.caption, color: theme.color.danger, fontWeight: theme.font.weight.medium },
    suggestBox: { marginTop: theme.spaceScale[2], backgroundColor: theme.color.surfaceApp, borderWidth: 1, borderColor: theme.color.borderApp, borderRadius: theme.radius.md, overflow: 'hidden' },
    suggestItem: { paddingVertical: theme.spaceScale[2], paddingHorizontal: theme.spaceScale[4], borderBottomWidth: 1, borderBottomColor: theme.color.borderApp },
    suggestText: { fontSize: theme.font.sizeV4.body, color: theme.color.textApp },
    addItemBtn: { marginTop: theme.spaceScale[3], borderWidth: 1, borderStyle: 'dashed', borderColor: theme.color.primaryVivid, borderRadius: theme.radius.md, height: S.controlLg, alignItems: 'center', justifyContent: 'center' },
    addItemBtnText: { color: theme.color.primaryVivid, fontSize: theme.font.sizeV4.body, fontWeight: theme.font.weight.medium },
    summaryBox: { marginTop: theme.spaceScale[3], backgroundColor: theme.color.primarySoft, borderRadius: theme.radius.md, paddingVertical: theme.spaceScale[3], paddingHorizontal: theme.spaceScale[4] },
    summaryText: { color: theme.color.primaryVivid, fontSize: theme.font.sizeV4.body, fontWeight: theme.font.weight.semibold },
    inputDisabled: { color: theme.color.textAppTertiary },
    consignItemList: { marginTop: theme.spaceScale[3], backgroundColor: theme.color.surfaceSunken, borderRadius: theme.radius.md, padding: theme.spaceScale[3] },
    subTitle: { fontSize: theme.font.sizeV4.caption, color: theme.color.textAppSecondary, fontWeight: theme.font.weight.semibold, marginBottom: theme.spaceScale[2] },
    consignItemRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: theme.spaceScale[2] },
    consignItemName: { flex: 1, fontSize: theme.font.sizeV4.body, color: theme.color.textApp },
    consignItemMeta: { fontSize: theme.font.sizeV4.caption, color: theme.color.textAppTertiary, marginLeft: theme.spaceScale[3] },
    textArea: { height: 72, paddingTop: theme.spaceScale[3], textAlignVertical: 'top' },
    dualRow: { flexDirection: 'row' },
    pickerField: { flexDirection: 'row', alignItems: 'center', backgroundColor: theme.color.surfaceSunken, borderWidth: 1, borderColor: theme.color.borderApp, borderRadius: theme.radius.md, paddingHorizontal: theme.spaceScale[4], height: S.controlLg, marginTop: theme.spaceScale[2] },
    pickerText: { flex: 1, fontSize: theme.font.sizeV4.body, color: theme.color.textApp },
    pickerArrow: { color: theme.color.textAppTertiary, fontSize: 20 },
    saveBtn: { backgroundColor: theme.color.primaryVivid, borderRadius: theme.radius.md, height: S.controlLg, alignItems: 'center', justifyContent: 'center', marginTop: theme.spaceScale[4] },
    saveBtnText: { color: '#fff', fontSize: theme.font.sizeV4.body, fontWeight: theme.font.weight.medium },
    settleActionBtn: { backgroundColor: theme.color.primaryVivid, borderRadius: theme.radius.md, height: S.controlLg, alignItems: 'center', justifyContent: 'center', marginTop: theme.spaceScale[3] },
    settleActionText: { color: '#fff', fontSize: theme.font.sizeV4.bodyLg, fontWeight: theme.font.weight.medium },
    doneBanner: { alignItems: 'center', justifyContent: 'center', backgroundColor: theme.color.surfaceApp, borderRadius: theme.radius.md, paddingVertical: theme.spaceScale[3], marginTop: theme.spaceScale[3] },
    doneBannerText: { color: theme.color.success, fontSize: theme.font.sizeV4.bodyLg, fontWeight: theme.font.weight.semibold },
    detailActions: { flexDirection: 'row', gap: theme.spaceScale[2], marginTop: theme.spaceScale[3] },
    actionBtn: { flex: 1, borderRadius: theme.radius.md, height: 40, alignItems: 'center', justifyContent: 'center', borderWidth: 1 },
    actionBtnPrimary: { backgroundColor: theme.color.primarySoft, borderColor: theme.color.primaryVivid },
    actionBtnDanger: { backgroundColor: theme.color.danger + '15', borderColor: theme.color.danger },
    actionBtnWarning: { backgroundColor: theme.color.warning + '15', borderColor: theme.color.warning },
    actionBtnText: { fontSize: theme.font.sizeV4.body, fontWeight: theme.font.weight.medium },

    infoRow: { flexDirection: 'row', alignItems: 'flex-start', paddingVertical: 6 },
    infoLabel: { width: 72, fontSize: 13, color: theme.color.textAppTertiary },
    infoValue: { flex: 1, fontSize: 14, color: theme.color.textApp },

    hint: { fontSize: theme.font.sizeV4.caption, color: theme.color.textAppTertiary, lineHeight: 18, marginBottom: theme.spaceScale[3] },

    modalRoot: { flex: 1, backgroundColor: theme.color.bgApp },

    // 相机
    camRoot: { flex: 1, backgroundColor: '#000' },
    camView: { flex: 1 },
    camBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: theme.spaceScale[4], paddingBottom: theme.spaceScale[6] },
    camBtn: { padding: theme.spaceScale[2] },
    camBtnText: { color: '#fff', fontSize: theme.font.sizeV4.body },
    camShutter: { width: 68, height: 68, borderRadius: 34, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center' },
    camShutterText: { color: '#000', fontSize: 18, fontWeight: theme.font.weight.bold },

    chip: { backgroundColor: theme.color.surfaceSunken, borderWidth: 1, borderColor: theme.color.borderApp, borderRadius: theme.radius.md, paddingHorizontal: 10, paddingVertical: 6, marginRight: 8, marginBottom: 8 },
    chipRow: { flexDirection: 'row', flexWrap: 'wrap', marginTop: theme.spaceScale[2] },
    chipActive: { backgroundColor: theme.color.primarySoft, borderColor: theme.color.primaryVivid },
    chipText: { fontSize: 13, color: theme.color.textAppSecondary },
    chipTextActive: { color: theme.color.primaryVivid, fontWeight: theme.font.weight.medium },

    // 导出 CSV
    exportRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: theme.spaceScale[3] },
    exportHint: { fontSize: 12, color: theme.color.textAppTertiary },
    exportBtn: { minWidth: 92, height: 32, paddingHorizontal: theme.spaceScale[4], borderRadius: theme.radius.md, borderWidth: 1, borderColor: theme.color.primaryVivid, alignItems: 'center', justifyContent: 'center' },
    exportBtnText: { fontSize: 13, color: theme.color.primaryVivid, fontWeight: theme.font.weight.medium },

    // 品牌汇总
    brandCard: { backgroundColor: theme.color.surfaceApp, borderRadius: theme.radius.lg, padding: theme.spaceScale[4], marginTop: theme.spaceScale[2] },
    brandCardTitle: { fontSize: theme.font.sizeV4.h4, fontWeight: theme.font.weight.semibold, color: theme.color.textApp },
    brandCardSub: { fontSize: 11, color: theme.color.textAppTertiary, marginTop: 2, marginBottom: theme.spaceScale[2] },
    brandRow: { paddingVertical: theme.spaceScale[3] },
    brandRowBorder: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.color.borderApp },
    brandRowHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    brandName: { flex: 1, fontSize: 14, fontWeight: theme.font.weight.medium, color: theme.color.textApp, marginRight: theme.spaceScale[2] },
    brandCount: { fontSize: 12, color: theme.color.textAppSecondary },
    brandRowNums: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 6 },
    brandNumTotal: { fontSize: 12, fontWeight: theme.font.weight.semibold, color: theme.color.textApp, marginRight: theme.spaceScale[3] },
    brandNumOk: { fontSize: 12, color: theme.color.success, marginRight: theme.spaceScale[3] },
    brandNumLeft: { fontSize: 12, color: theme.color.textAppSecondary, marginRight: theme.spaceScale[3] },
    brandNumOverdue: { fontSize: 12, color: theme.color.danger },

    // 品牌筛选 chips
    brandFilterRow: { flexDirection: 'row', alignItems: 'center', marginTop: theme.spaceScale[3] },
    brandFilterLabel: { fontSize: 12, color: theme.color.textAppTertiary, marginRight: theme.spaceScale[2] },
    brandChipScroll: { flex: 1, flexGrow: 1 },
    brandChip: { backgroundColor: theme.color.surfaceSunken, borderWidth: 1, borderColor: theme.color.borderApp, borderRadius: theme.radius.md, paddingHorizontal: 10, paddingVertical: 6, marginRight: 8 },
    brandChipActive: { backgroundColor: theme.color.primarySoft, borderColor: theme.color.primaryVivid },
    brandChipText: { fontSize: 13, color: theme.color.textAppSecondary },
    brandChipTextActive: { color: theme.color.primaryVivid, fontWeight: theme.font.weight.medium },

    // 返钱分期计划
    planSummary: { fontSize: 12, color: theme.color.textAppTertiary, marginTop: -theme.spaceScale[2], marginBottom: theme.spaceScale[2] },
    planCard: { borderWidth: 1, borderRadius: theme.radius.md, padding: theme.spaceScale[3], marginTop: theme.spaceScale[2] },
    planCardHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    planCardTitle: { fontSize: 14, fontWeight: theme.font.weight.semibold, color: theme.color.textApp },
    planCardDate: { fontSize: 12, fontWeight: '400', color: theme.color.textAppTertiary },
    planTag: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 6 },
    planTagText: { fontSize: 12, fontWeight: theme.font.weight.medium },
    planAmountRow: { flexDirection: 'row', alignItems: 'baseline', flexWrap: 'wrap', marginTop: 6 },
    planAmtLabel: { fontSize: 13, color: theme.color.textAppSecondary },
    planAmtVal: { fontSize: 13, fontWeight: theme.font.weight.semibold, color: theme.color.textApp, fontVariant: ['tabular-nums'] },
    planRemark: { fontSize: 12, color: theme.color.textAppSecondary, marginTop: 6 },
    planBottomRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 8 },
    planNoVoucher: { fontSize: 12, color: theme.color.textAppTertiary, flexShrink: 1 },
    planActionBtn: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: theme.radius.md, marginLeft: 8 },
    planActionText: { color: '#fff', fontSize: 13, fontWeight: theme.font.weight.medium },
    planListTag: { fontSize: 12, color: theme.color.primaryVivid, backgroundColor: theme.color.primarySoft, paddingHorizontal: 8, paddingVertical: 2, borderRadius: 6, fontWeight: theme.font.weight.medium },
    planEditRow: {
      flexDirection: 'row', alignItems: 'center', gap: 6,
      borderWidth: 1, borderLeftWidth: 3, borderColor: theme.color.borderApp, borderLeftColor: theme.color.primaryVivid,
      borderRadius: theme.radius.md, padding: 6, marginTop: theme.spaceScale[2],
      backgroundColor: theme.color.surfaceApp,
    },
    planEditSeqPill: {
      width: 34, height: 34, borderRadius: 17,
      backgroundColor: theme.color.primarySoft,
      alignItems: 'center', justifyContent: 'center',
    },
    planEditSeqText: { fontSize: 13, fontWeight: theme.font.weight.semibold, color: theme.color.primaryVivid },
    planEditAmt: { width: 72, height: 40, paddingHorizontal: 8, fontSize: 13, fontVariant: ['tabular-nums'] },
    planEditDate: { width: 96, height: 40, paddingHorizontal: 8, fontSize: 13 },
    planEditRemark: { flex: 1, height: 40, paddingHorizontal: 8, fontSize: 13, marginRight: 0 },
    planDelBtn: { width: 28, height: 40, alignItems: 'center', justifyContent: 'center' },
    planDelText: { color: theme.color.danger, fontSize: 20 },
    planAddBtn: { borderWidth: 1, borderStyle: 'dashed', borderColor: theme.color.primaryVivid, borderRadius: theme.radius.md, height: 40, alignItems: 'center', justifyContent: 'center', marginTop: theme.spaceScale[2] },
    planAddText: { color: theme.color.primaryVivid, fontSize: 13 },
    planTotalRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: theme.spaceScale[2] },
  });
}
