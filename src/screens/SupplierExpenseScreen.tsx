import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, ScrollView, StyleSheet, TouchableOpacity, Alert, TextInput,
  Switch, Modal, Image, RefreshControl,
} from 'react-native';
import { CameraView, useCameraPermissions, type CameraType } from 'expo-camera';
import { useTheme } from '../theme/ThemeProvider';
import { SafeAreaHeader } from '../components/SafeArea';
import {
  fetchExpenses, getExpenseDetail, fetchExpenseSummary, createExpense, updateExpense, settleExpense,
  deleteExpense, reverseExpense, uploadExpenseImage,
  type SupplierExpense, type ExpenseDetail, type ExpenseSummary,
  type ExpenseType, type SettleMethod, type PaymentMethod, type ExpenseStatus, type RebateCycle, type ExpenseImageDraft,
} from '../api/supplierExpense';
import { fetchSuppliers } from '../api/suppliers';
import { listSuppliers } from '../db/localDb';

interface Props {
  baseUrl: string;
  onBack: () => void;
}

type ViewKey = 'list' | 'form' | 'detail';
type TypeFilter = '' | '1' | '2';

function todayStr(): string {
  const d = new Date();
  const m = `${d.getMonth() + 1}`.padStart(2, '0');
  const day = `${d.getDate()}`.padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

function money(n: number): string {
  return `¥${Number(n || 0).toFixed(2)}`;
}

const EXPENSE_TYPE_LABEL: Record<ExpenseType, string> = { 1: '钱', 2: '货物' };
const SETTLE_METHOD_LABEL: Record<SettleMethod, string> = { 1: '年结', 2: '月结', 3: '按次', 4: '返货', 5: '季度结' };
const REBATE_CYCLE_LABEL: Record<RebateCycle, string> = { 1: '每月', 2: '每年', 3: '每季度' };
const PAYMENT_LABEL: Record<PaymentMethod, string> = { 1: '转账', 2: '现金', 3: '冲抵货款', 4: '其他' };
function statusLabel(s: ExpenseStatus): string {
  return s === 2 ? '已结清' : s === 1 ? '部分结算' : '待结算';
}
function rebatePeriodLabel(dateStr: string, cycle: number): string {
  if (!dateStr) return '';
  return Number(cycle) === 2 ? String(dateStr).slice(0, 4) : String(dateStr).slice(0, 7);
}
function periodAmount(e: SupplierExpense): number {
  return Math.round((Number(e.rebateQty) || 0) * (Number(e.rebateUnitPrice) || 0) * 100) / 100;
}
function toAbsoluteUrl(baseUrl: string, url: string): string {
  if (!url) return '';
  if (/^https?:\/\//i.test(url)) return url;
  return `${baseUrl.replace(/\/$/, '')}${url.startsWith('/') ? url : `/${url}`}`;
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

  const [detailId, setDetailId] = useState<number | null>(null);
  const [detail, setDetail] = useState<ExpenseDetail | null>(null);

  const [settleTarget, setSettleTarget] = useState<SupplierExpense | null>(null);
  const [editingTarget, setEditingTarget] = useState<SupplierExpense | null>(null);
  const [editingImages, setEditingImages] = useState<string[]>([]);
  const [reverseTarget, setReverseTarget] = useState<SupplierExpense | null>(null);

  const loadAll = useCallback(async () => {
    const params: any = {};
    if (keyword.trim()) params.keyword = keyword.trim();
    if (typeFilter) params.expenseType = Number(typeFilter);
    if (onlyOverdue) params.overdue = 1;
    const [s, l] = await Promise.all([
      fetchExpenseSummary(baseUrl),
      fetchExpenses(baseUrl, params),
    ]);
    setSummary(s);
    setList(Array.isArray(l) ? l : []);
  }, [baseUrl, keyword, typeFilter, onlyOverdue]);

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
    void loadAll();
  };

  const showItemActions = (e: SupplierExpense) => {
    Alert.alert(
      `${e.expenseNo}`,
      `${e.supplierName} · ${money(e.totalAmount)}`,
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
              {([{ k: '', t: '全部' }, { k: '1', t: '钱' }, { k: '2', t: '货物' }] as { k: TypeFilter; t: string }[]).map((o) => (
                <TouchableOpacity key={o.k} style={[styles.segBtn, typeFilter === o.k && styles.segBtnActive]} onPress={() => setTypeFilter(o.k)}>
                  <Text style={[styles.segBtnText, typeFilter === o.k && styles.segBtnTextActive]}>{o.t}</Text>
                </TouchableOpacity>
              ))}
            </View>
            <View style={styles.switchRow}>
              <Text style={styles.switchLabel}>仅看逾期</Text>
              <Switch value={onlyOverdue} onValueChange={setOnlyOverdue} thumbColor={onlyOverdue ? theme.color.primaryVivid : undefined} />
            </View>
          </View>

          {/* 列表 */}
          {list.length === 0 ? (
            <View style={styles.empty}>
              <Text style={styles.emptyText}>暂无陈列费用单</Text>
              <Text style={styles.emptySub}>点右上角「＋ 登记」新增一笔</Text>
            </View>
          ) : (
            list.map((e, i) => (
              <View key={e.id} style={[styles.itemCard, i > 0 && { marginTop: theme.spaceScale[3] }]}>
                <TouchableOpacity style={styles.itemMain} onPress={() => openDetail(e.id)} activeOpacity={0.7}>
                  <View style={styles.itemTop}>
                    <Text style={styles.itemNo}>{e.expenseNo}</Text>
                    <TypeTag type={e.expenseType} />
                  </View>
                  <Text style={styles.itemSupplier}>{e.supplierName}</Text>
                  <Text style={styles.itemItem}>{e.item || (e.expenseType === 2 ? e.goodsName : '—')}</Text>
                  <View style={styles.itemAmountRow}>
                    {e.settleMethod === 4 ? (
                      <Text style={styles.itemAmount}>每期 {money(periodAmount(e))}</Text>
                    ) : (
                      <Text style={styles.itemAmount}>{money(e.totalAmount)}</Text>
                    )}
                    {e.settleMethod === 4 ? (
                      e.status === 2 ? <Text style={styles.itemUnsettled}>已全部返完</Text>
                        : <Text style={styles.itemUnsettled}>下次返货 {e.nextRebateDate || '—'}</Text>
                    ) : (
                      <Text style={styles.itemUnsettled}>未收 {money(e.unsettledAmount)}</Text>
                    )}
                  </View>
                  <View style={styles.itemFoot}>
                    <StatusTag status={e.status} />
                    {e.overdue ? <Text style={styles.overdueTag}>逾期</Text> : <Text style={styles.methodTag}>{SETTLE_METHOD_LABEL[e.settleMethod as SettleMethod]}</Text>}
                  </View>
                </TouchableOpacity>
                <View style={styles.itemActions}>
                  {e.status < 2 ? (
                    <TouchableOpacity style={styles.settlePill} onPress={() => setSettleTarget(e)}>
                      <Text style={styles.settlePillText}>{e.settleMethod === 4 ? '确认收货' : '结算'}</Text>
                    </TouchableOpacity>
                  ) : null}
                  <TouchableOpacity style={styles.morePill} onPress={() => showItemActions(e)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                    <Text style={styles.morePillText}>⋮</Text>
                  </TouchableOpacity>
                </View>
              </View>
            ))
          )}
          <View style={{ height: 24 }} />
        </ScrollView>

        <SettleModal
          theme={theme}
          styles={styles}
          baseUrl={baseUrl}
          target={settleTarget}
          onClose={() => setSettleTarget(null)}
          onConfirm={async (payload: { settleAmount?: number; paymentMethod?: PaymentMethod; settleDate?: string; remark?: string; images?: ExpenseImageDraft[] }) => {
            try {
              await settleExpense(baseUrl, settleTarget!.id, payload);
              Alert.alert('已结算', '该笔费用已记录一笔结算');
              setSettleTarget(null);
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
            onSettle={() => setSettleTarget(detail.expense)}
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
        onClose={() => setSettleTarget(null)}
        onConfirm={async (payload: { settleAmount: number; paymentMethod?: PaymentMethod; settleDate?: string; remark?: string; images?: ExpenseImageDraft[] }) => {
          try {
            await settleExpense(baseUrl, settleTarget!.id, payload);
            Alert.alert('已结算', '该笔费用已记录一笔结算');
            setSettleTarget(null);
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
        onConfirm={async (payload: { settleAmount: number; paymentMethod?: PaymentMethod; remark?: string }) => {
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

// ============ 类型 / 状态 Tag ============
function TypeTag({ type }: { type: ExpenseType }) {
  const { theme } = useTheme();
  const isGoods = type === 2;
  return (
    <View style={{ backgroundColor: isGoods ? theme.color.info + '1A' : theme.color.primarySoft, paddingHorizontal: 8, paddingVertical: 2, borderRadius: 6 }}>
      <Text style={{ fontSize: 12, color: isGoods ? theme.color.info : theme.color.primaryVivid, fontWeight: theme.font.weight.medium }}>
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
function DetailBody({ theme, styles, baseUrl, detail, onSettle, onEdit, onDelete, onReverse }: any) {
  const e = detail.expense;
  const [previewUri, setPreviewUri] = useState<string | null>(null);
  return (
    <View>
      {/* 金额三栏 */}
      <View style={styles.card}>
        <Text style={styles.sectionTitle}>金额</Text>
        <View style={styles.amountRow}>
          <View style={styles.amountCol}><Text style={styles.amountLabel}>总额</Text><Text style={[styles.amountVal, { color: theme.color.textApp }]}>{money(e.totalAmount)}</Text></View>
          <View style={styles.amountCol}><Text style={styles.amountLabel}>已结</Text><Text style={[styles.amountVal, { color: theme.color.success }]}>{money(e.settledAmount)}</Text></View>
          <View style={styles.amountCol}><Text style={styles.amountLabel}>未结</Text><Text style={[styles.amountVal, { color: theme.color.warning }]}>{money(e.unsettledAmount)}</Text></View>
        </View>
        {e.overdue ? <Text style={[styles.overdueLine, { color: theme.color.danger }]}>⚠ 已逾期（到期 {e.dueDate}）</Text> : null}
      </View>

      {/* 基本信息 */}
      <View style={styles.card}>
        <Text style={styles.sectionTitle}>基本信息</Text>
        <InfoRow label="费用单号" value={e.expenseNo} />
        <InfoRow label="供应商" value={e.supplierName} />
        <InfoRow label="类型" value={EXPENSE_TYPE_LABEL[e.expenseType as ExpenseType]} />
        <InfoRow label="项目" value={e.item || '—'} />
        <InfoRow label="结算方式" value={SETTLE_METHOD_LABEL[e.settleMethod as SettleMethod]} />
        <InfoRow label="发生日期" value={e.expenseDate} />
        {e.settleMethod !== 3 ? <InfoRow label="到期日" value={e.dueDate || '—'} /> : null}
        {e.remark ? <InfoRow label="备注" value={e.remark} /> : null}
      </View>

      {/* 货物明细 */}
      {e.expenseType === 2 ? (
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>货物明细</Text>
          <InfoRow label="品名" value={e.goodsName || '—'} />
          <InfoRow label="规格" value={e.goodsSpec || '—'} />
          <InfoRow label="数量" value={`${e.goodsQty} ${e.goodsUnit || ''}`} />
          <InfoRow label="单价" value={money(e.goodsUnitPrice)} />
        </View>
      ) : null}

      {/* 返货协议（settleMethod=4） */}
      {e.settleMethod === 4 ? (
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>返货协议（{REBATE_CYCLE_LABEL[e.rebateCycle as RebateCycle] || '每月'}返）</Text>
          <InfoRow label="返货品" value={`${e.rebateGoodsName || '—'} ${e.rebateGoodsSpec || ''}`} />
          <InfoRow label="每期" value={`${e.rebateQty}${e.rebateUnit || ''} × ${money(e.rebateUnitPrice)}（等价 ${money(periodAmount(e))}）`} />
          <InfoRow label="起算日" value={e.rebateStartDate || '—'} />
          <InfoRow label="总期数" value={e.rebateTotalPeriods > 0 ? `${e.rebateTotalPeriods} 期` : '不限'} />
          <InfoRow label="下次返货" value={e.nextRebateDate || '—'} />
        </View>
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
                {s.isRebate ? `返货确认收货${s.rebatePeriod ? `（${s.rebatePeriod}）` : ''} ` : (s.isReversal ? '冲正 ' : '')}{money(s.settleAmount)}
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
        {e.status >= 1 ? (
          <TouchableOpacity style={[styles.actionBtn, styles.actionBtnWarning]} onPress={onReverse}>
            <Text style={[styles.actionBtnText, { color: theme.color.warning }]}>冲正</Text>
          </TouchableOpacity>
        ) : null}
      </View>

      {e.status < 2 ? (
        <TouchableOpacity style={styles.settleActionBtn} onPress={onSettle}>
          <Text style={styles.settleActionText}>{e.settleMethod === 4 ? '确认收货' : '现场结算'}</Text>
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
  const [supplierName, setSupplierName] = useState(e?.supplierName || '');
  const [expenseType, setExpenseType] = useState<ExpenseType>(e?.expenseType || 1);
  const [item, setItem] = useState(e?.item || '');
  const [settleMethod, setSettleMethod] = useState<SettleMethod>(e?.settleMethod || 3);
  const [expenseDate, setExpenseDate] = useState(e?.expenseDate || todayStr());
  const [dueDate, setDueDate] = useState(e?.dueDate || '');
  const [amount, setAmount] = useState(e && e.totalAmount ? e.totalAmount.toFixed(2) : '');
  const [goodsName, setGoodsName] = useState(e?.goodsName || '');
  const [goodsSpec, setGoodsSpec] = useState(e?.goodsSpec || '');
  const [goodsQty, setGoodsQty] = useState(e && e.goodsQty ? String(e.goodsQty) : '');
  const [goodsUnit, setGoodsUnit] = useState(e?.goodsUnit || '');
  const [goodsUnitPrice, setGoodsUnitPrice] = useState(e && e.goodsUnitPrice ? e.goodsUnitPrice.toFixed(2) : '');
  // 返货（settleMethod=4）
  const [rebateCycle, setRebateCycle] = useState<RebateCycle>(e?.rebateCycle || 1);
  const [rebateTotalPeriods, setRebateTotalPeriods] = useState(e && e.rebateTotalPeriods ? String(e.rebateTotalPeriods) : '');
  const [rebateGoodsName, setRebateGoodsName] = useState(e?.rebateGoodsName || '');
  const [rebateGoodsSpec, setRebateGoodsSpec] = useState(e?.rebateGoodsSpec || '');
  const [rebateQty, setRebateQty] = useState(e && e.rebateQty ? String(e.rebateQty) : '');
  const [rebateUnit, setRebateUnit] = useState(e?.rebateUnit || '');
  const [rebateUnitPrice, setRebateUnitPrice] = useState(e && e.rebateUnitPrice ? e.rebateUnitPrice.toFixed(2) : '');
  const [rebateStartDate, setRebateStartDate] = useState(e?.rebateStartDate || todayStr());
  const [remark, setRemark] = useState(e?.remark || '');
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
      { text: '手动输入', onPress: () => setSupplierName(''), style: 'cancel' as const },
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

  const submit = async () => {
    if (!supplierName.trim()) { onError('请选择供应商'); return; }
    if (!expenseDate.trim()) { onError('请填写发生日期（yyyy-mm-dd）'); return; }
    const payload: any = {
      supplierName: supplierName.trim(),
      expenseType: settleMethod === 4 ? 1 : expenseType,
      item: item.trim(),
      settleMethod,
      expenseDate: expenseDate.trim().slice(0, 10),
      dueDate: settleMethod === 4 ? undefined : (settleMethod === 3 ? undefined : (dueDate.trim().slice(0, 10) || undefined)),
      remark: remark.trim(),
      images: images.map((u) => ({ imageUrl: u, imageId: null })),
    };
    if (settleMethod === 4) {
      const rq = Number(rebateQty.replace(/[^0-9.]/g, '')) || 0;
      const rp = Number(rebateUnitPrice.replace(/[^0-9.]/g, '')) || 0;
      if (!rebateGoodsName.trim()) { onError('返货需填写返货品名'); return; }
      if (rq <= 0 || rp <= 0) { onError('返货需填写数量与单价（均大于 0）'); return; }
      payload.rebateCycle = rebateCycle;
      payload.rebateGoodsName = rebateGoodsName.trim();
      payload.rebateGoodsSpec = rebateGoodsSpec.trim();
      payload.rebateQty = rq;
      payload.rebateUnit = rebateUnit.trim();
      payload.rebateUnitPrice = rp;
      payload.rebateStartDate = rebateStartDate.trim().slice(0, 10) || undefined;
      payload.rebateTotalPeriods = rebateTotalPeriods.trim() ? Math.max(0, Math.floor(Number(rebateTotalPeriods.replace(/[^0-9.]/g, '')) || 0)) : 0;
    } else if (expenseType === 2) {
      const q = Number(goodsQty.replace(/[^0-9.]/g, '')) || 0;
      const p = Number(goodsUnitPrice.replace(/[^0-9.]/g, '')) || 0;
      if (!goodsName.trim()) { onError('货物类型需填写品名'); return; }
      if (q <= 0 || p <= 0) { onError('货物类型需填写数量与单价（均大于 0）'); return; }
      payload.goodsName = goodsName.trim();
      payload.goodsSpec = goodsSpec.trim();
      payload.goodsQty = q;
      payload.goodsUnit = goodsUnit.trim();
      payload.goodsUnitPrice = p;
    } else {
      const a = Number(amount.replace(/[^0-9.]/g, '')) || 0;
      if (a <= 0) { onError('金额需大于 0'); return; }
      payload.totalAmount = a;
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
        {/* 供应商 */}
        <Text style={styles.fieldLabel}>供应商 *</Text>
        <TouchableOpacity style={styles.pickerField} onPress={pickSupplier}>
          <Text style={[styles.pickerText, !supplierName && { color: theme.color.textAppTertiary }]}>
            {supplierName || '点击选择（可手动输入）'}
          </Text>
          <Text style={styles.pickerArrow}>›</Text>
        </TouchableOpacity>
        {!supplierName ? <TextInput style={styles.input} value={supplierName} onChangeText={setSupplierName} placeholder="或在此手动输入供应商名" placeholderTextColor={theme.color.textAppTertiary} /> : null}

        {/* 费用类型（返货单不显示，自动按钱处理） */}
        {settleMethod !== 4 && (
          <>
            <Text style={styles.fieldLabel}>费用类型</Text>
            <View style={styles.segRow}>
              {([{ k: 1, t: '钱' }, { k: 2, t: '货物' }] as { k: ExpenseType; t: string }[]).map((o) => (
                <TouchableOpacity key={o.k} style={[styles.segBtn, expenseType === o.k && styles.segBtnActive]} onPress={() => setExpenseType(o.k)}>
                  <Text style={[styles.segBtnText, expenseType === o.k && styles.segBtnTextActive]}>{o.t}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </>
        )}

        {/* 钱 / 货物 字段（非返货） */}
        {settleMethod !== 4 && (expenseType === 2 ? (
          <View>
            <Text style={styles.fieldLabel}>品名 *</Text>
            <TextInput style={styles.input} value={goodsName} onChangeText={setGoodsName} placeholder="如：食用油 5L" placeholderTextColor={theme.color.textAppTertiary} />
            <View style={styles.dualRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.fieldLabel}>数量 *</Text>
                <TextInput style={styles.input} value={goodsQty} {...numInput(setGoodsQty)} placeholder="0" placeholderTextColor={theme.color.textAppTertiary} />
              </View>
              <View style={{ width: 12 }} />
              <View style={{ flex: 1 }}>
                <Text style={styles.fieldLabel}>单位</Text>
                <TextInput style={styles.input} value={goodsUnit} onChangeText={setGoodsUnit} placeholder="箱/瓶" placeholderTextColor={theme.color.textAppTertiary} />
              </View>
            </View>
            <Text style={styles.fieldLabel}>单价 *</Text>
            <TextInput style={styles.input} value={goodsUnitPrice} {...numInput(setGoodsUnitPrice)} placeholder="0.00" placeholderTextColor={theme.color.textAppTertiary} />
            <Text style={styles.fieldLabel}>规格</Text>
            <TextInput style={styles.input} value={goodsSpec} onChangeText={setGoodsSpec} placeholder="选填" placeholderTextColor={theme.color.textAppTertiary} />
          </View>
        ) : (
          <View>
            <Text style={styles.fieldLabel}>金额（元）*</Text>
            <TextInput style={styles.input} value={amount} {...numInput(setAmount)} placeholder="0.00" placeholderTextColor={theme.color.textAppTertiary} />
          </View>
        ))}

        {/* 返货配置（settleMethod=4）：周期返货抵费 */}
        {settleMethod === 4 && (
          <View>
            <Text style={styles.fieldLabel}>返货周期</Text>
            <View style={styles.segRow}>
              {([{ k: 1, t: '每月' }, { k: 2, t: '每年' }, { k: 3, t: '每季度' }] as { k: RebateCycle; t: string }[]).map((o) => (
                <TouchableOpacity key={o.k} style={[styles.segBtn, rebateCycle === o.k && styles.segBtnActive]} onPress={() => setRebateCycle(o.k)}>
                  <Text style={[styles.segBtnText, rebateCycle === o.k && styles.segBtnTextActive]}>{o.t}</Text>
                </TouchableOpacity>
              ))}
            </View>
            <View style={styles.dualRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.fieldLabel}>总期数（空=不限）</Text>
                <TextInput style={styles.input} value={rebateTotalPeriods} {...numInput(setRebateTotalPeriods)} placeholder="如 12" placeholderTextColor={theme.color.textAppTertiary} />
              </View>
              <View style={{ width: 12 }} />
              <View style={{ flex: 1 }}>
                <Text style={styles.fieldLabel}>起算日</Text>
                <TextInput style={styles.input} value={rebateStartDate} onChangeText={setRebateStartDate} placeholder="yyyy-mm-dd" placeholderTextColor={theme.color.textAppTertiary} />
              </View>
            </View>
            <Text style={styles.fieldLabel}>返货品名 *</Text>
            <TextInput style={styles.input} value={rebateGoodsName} onChangeText={setRebateGoodsName} placeholder="如：矿泉水" placeholderTextColor={theme.color.textAppTertiary} />
            <View style={styles.dualRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.fieldLabel}>规格</Text>
                <TextInput style={styles.input} value={rebateGoodsSpec} onChangeText={setRebateGoodsSpec} placeholder="如 550ml" placeholderTextColor={theme.color.textAppTertiary} />
              </View>
              <View style={{ width: 12 }} />
              <View style={{ flex: 1 }}>
                <Text style={styles.fieldLabel}>单位</Text>
                <TextInput style={styles.input} value={rebateUnit} onChangeText={setRebateUnit} placeholder="箱/瓶" placeholderTextColor={theme.color.textAppTertiary} />
              </View>
            </View>
            <View style={styles.dualRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.fieldLabel}>数量 *</Text>
                <TextInput style={styles.input} value={rebateQty} {...numInput(setRebateQty)} placeholder="0" placeholderTextColor={theme.color.textAppTertiary} />
              </View>
              <View style={{ width: 12 }} />
              <View style={{ flex: 1 }}>
                <Text style={styles.fieldLabel}>单价 *</Text>
                <TextInput style={styles.input} value={rebateUnitPrice} {...numInput(setRebateUnitPrice)} placeholder="0.00" placeholderTextColor={theme.color.textAppTertiary} />
              </View>
            </View>
          </View>
        )}

        {/* 项目 */}
        <Text style={styles.fieldLabel}>项目说明</Text>
        <TextInput style={styles.input} value={item} onChangeText={setItem} placeholder="如：端架陈列费 / 堆头费" placeholderTextColor={theme.color.textAppTertiary} />

        {/* 结算方式 */}
        <Text style={styles.fieldLabel}>结算方式</Text>
        <View style={styles.segRow}>
          {([{ k: 1, t: '年结' }, { k: 2, t: '月结' }, { k: 5, t: '季度结' }, { k: 3, t: '按次' }, { k: 4, t: '返货' }] as { k: SettleMethod; t: string }[]).map((o) => (
            <TouchableOpacity key={o.k} style={[styles.segBtn, settleMethod === o.k && styles.segBtnActive]} onPress={() => setSettleMethod(o.k)}>
              <Text style={[styles.segBtnText, settleMethod === o.k && styles.segBtnTextActive]}>{o.t}</Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* 日期 */}
        <Text style={styles.fieldLabel}>发生日期 *</Text>
        <TextInput style={styles.input} value={expenseDate} onChangeText={setExpenseDate} placeholder="yyyy-mm-dd" placeholderTextColor={theme.color.textAppTertiary} />
        {settleMethod !== 3 && settleMethod !== 4 ? (
          <View>
            <Text style={styles.fieldLabel}>到期日（年结/月结）</Text>
            <TextInput style={styles.input} value={dueDate} onChangeText={setDueDate} placeholder="yyyy-mm-dd" placeholderTextColor={theme.color.textAppTertiary} />
          </View>
        ) : null}

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
function SettleModal({ theme, styles, baseUrl, target, onClose, onConfirm }: any) {
  const [amount, setAmount] = useState('');
  const [payment, setPayment] = useState<PaymentMethod>(1);
  const [settleDate, setSettleDate] = useState(todayStr());
  const [remark, setRemark] = useState('');
  const [settleImages, setSettleImages] = useState<string[]>([]);
  const [previewUri, setPreviewUri] = useState<string | null>(null);
  const [camOpen, setCamOpen] = useState(false);
  const [camType, setCamType] = useState<CameraType>('back');
  const [permission, requestPermission] = useCameraPermissions();
  const camRef = React.useRef<any>(null);

  React.useEffect(() => {
    if (target) {
      setAmount(target.unsettledAmount ? target.unsettledAmount.toFixed(2) : '');
      setPayment(target.expenseType === 2 ? 3 : 1);
      setSettleDate(todayStr());
      setRemark('');
      setSettleImages([]);
    }
  }, [target]);

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
              <Text style={styles.headerTitle}>{target.settleMethod === 4 ? '确认收货' : '现场结算'}</Text>
              <View style={styles.subSpacer} />
            </SafeAreaHeader>
            <ScrollView style={styles.body} contentContainerStyle={styles.content}>
              {target.settleMethod === 4 ? (
                <>
                  <Text style={styles.hint}>{target.supplierName} · 本期返货确认收货</Text>
                  <View style={styles.card}>
                    <InfoRow label="返货品" value={`${target.rebateGoodsName || '—'} ${target.rebateGoodsSpec || ''}`} />
                    <InfoRow label="每期等价" value={`${target.rebateQty}${target.rebateUnit || ''} × ${money(target.rebateUnitPrice)} = ${money(Math.round((Number(target.rebateQty) || 0) * (Number(target.rebateUnitPrice) || 0) * 100) / 100)}`} />
                    <InfoRow label="本期（下次）" value={target.nextRebateDate || '—'} />
                    <InfoRow label="说明" value="确认后记为「返货确认收货」并自动推进下一期" />
                  </View>
                  <Text style={styles.fieldLabel}>备注</Text>
                  <TextInput style={styles.input} value={remark} onChangeText={setRemark} placeholder="选填" placeholderTextColor={theme.color.textAppTertiary} />
                  {renderSettleImages()}
                  <TouchableOpacity style={styles.saveBtn} onPress={() => {
                    const nextDate = target.nextRebateDate || '';
                    const msg = nextDate
                      ? `确认本期返货收货？\n本期对应日期：${nextDate}，确认后将自动推进下一期。`
                      : '确认本期返货收货？确认后将自动推进下一期。';
                    Alert.alert('二次确认', msg, [
                      { text: '取消', style: 'cancel' },
                      { text: '确认收货', onPress: () => {
                        void onConfirm({ remark: remark.trim(), images: settleImages.map((u) => ({ imageUrl: u, imageId: null })) });
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
                  <TextInput style={styles.input} value={settleDate} onChangeText={setSettleDate} placeholder="yyyy-mm-dd" placeholderTextColor={theme.color.textAppTertiary} />

                  <Text style={styles.fieldLabel}>备注</Text>
                  <TextInput style={styles.input} value={remark} onChangeText={setRemark} placeholder="选填" placeholderTextColor={theme.color.textAppTertiary} />

                  {renderSettleImages()}

                  <TouchableOpacity style={styles.saveBtn} onPress={() => {
                    const a = Number(amount.replace(/[^0-9.]/g, '')) || 0;
                    if (a <= 0) { Alert.alert('请输入结算金额'); return; }
                    void onConfirm({ settleAmount: a, paymentMethod: payment, settleDate: settleDate.trim().slice(0, 10), remark: remark.trim(), images: settleImages.map((u) => ({ imageUrl: u, imageId: null })) });
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
          <Text style={styles.headerTitle}>冲正结算</Text>
          <View style={styles.subSpacer} />
        </SafeAreaHeader>
        <ScrollView style={styles.body} contentContainerStyle={styles.content}>
          <Text style={styles.hint}>{target.supplierName} · 已结算 {money(target.settledAmount)}，冲正用于纠错并记录负数</Text>
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
          <Text style={styles.fieldLabel}>备注</Text>
          <TextInput style={[styles.input, styles.textArea]} value={remark} onChangeText={setRemark} placeholder="冲正原因" placeholderTextColor={theme.color.textAppTertiary} multiline numberOfLines={3} />
          <TouchableOpacity style={[styles.saveBtn, saving && { opacity: 0.6 }]} disabled={saving} onPress={() => {
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
    itemItem: { fontSize: theme.font.sizeV4.caption, color: theme.color.textAppSecondary, marginTop: 2 },
    itemAmountRow: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', marginTop: theme.spaceScale[2] },
    itemAmount: { fontSize: 17, fontWeight: theme.font.weight.bold, color: theme.color.textApp, fontVariant: ['tabular-nums'] },
    itemUnsettled: { fontSize: theme.font.sizeV4.caption, color: theme.color.warning },
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
    textArea: { height: 72, paddingTop: theme.spaceScale[3], textAlignVertical: 'top' },
    dualRow: { flexDirection: 'row' },
    pickerField: { flexDirection: 'row', alignItems: 'center', backgroundColor: theme.color.surfaceSunken, borderWidth: 1, borderColor: theme.color.borderApp, borderRadius: theme.radius.md, paddingHorizontal: theme.spaceScale[4], height: S.controlLg },
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
  });
}
