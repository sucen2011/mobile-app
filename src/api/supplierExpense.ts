import { apiFetch, twoStepDelete } from './client';
import { uploadImage } from './upload';

// ============ 供应商陈列费用管理：移动端 API 封装 ============
// 新模型（与 PC retail-admin 对齐）：
//   费用类型 ExpenseType：1=返钱 2=返货（原旧模型 1=钱/2=货物 已废弃）
//   结算方式 SettleMethod：1=年结 2=月结 3=按次 5=季度结 6=自定义（已移除 4=返货，返货改为 expenseType=2）
//   返货(expenseType=2)：关联商品档案、无单价、不折算金额；settleMethod 提交时强制为 3
//     settledAmount 复用为「已返期数」；rebateTotalPeriods=0 表示不限期数长期有效
//   返钱(expenseType=1)：按 settleMethod + 到期日 + 费用金额(totalAmount) 结算
// 返货周期 rebateCycle：1=每月 2=每年 3=每季度 4=自定义
// 支付方式（payment）：1=转账 2=现金 3=冲抵货款 4=其他
// 状态：0=待结算 1=部分结算 2=已结清
//
// 返回形态与 PC 端一致：后端统一信封 { code:0, msg:'', data }。
// 移动端没有 axios 拦截器，这里手动解包；离线 / 超时时 apiFetch 直接 throw，由调用方 catch 提示。

async function apiJson<T>(baseUrl: string, path: string, opts?: RequestInit): Promise<T> {
  const res = await apiFetch(`${baseUrl}${path}`, opts);
  if (!res.ok) {
    const m = res.json?.msg || `请求失败（HTTP ${res.status}）`;
    throw new Error(m);
  }
  const body = res.json || {};
  if (typeof body.code === 'number' && body.code !== 0) {
    throw new Error(body.msg || '接口返回错误');
  }
  return (body.data !== undefined ? body.data : body) as T;
}

function buildQuery(params?: Record<string, any>): string {
  if (!params) return '';
  const us = new URLSearchParams();
  Object.keys(params).forEach((k) => {
    const v = params[k];
    if (v !== undefined && v !== null && v !== '') us.append(k, String(v));
  });
  const s = us.toString();
  return s ? `?${s}` : '';
}

export type ExpenseType = 1 | 2;               // 1=返钱 2=返货
export type SettleMethod = 1 | 2 | 3 | 5 | 6;  // 1=年结 2=月结 3=按次 5=季度结 6=自定义（已移除 4）
export type RebateCycle = 1 | 2 | 3 | 4;       // 1=每月 2=每年 3=每季度 4=自定义
export type PaymentMethod = 1 | 2 | 3 | 4;     // 1=转账 2=现金 3=冲抵货款 4=其他
export type ExpenseStatus = 0 | 1 | 2;

export const EXPENSE_TYPE_LABEL: Record<ExpenseType, string> = { 1: '返钱', 2: '返货' };
export const SETTLE_METHOD_LABEL: Record<SettleMethod, string> = { 1: '年结', 2: '月结', 3: '按次', 5: '季度结', 6: '自定义' };
export const REBATE_CYCLE_LABEL: Record<RebateCycle, string> = { 1: '每月', 2: '每年', 3: '每季度', 4: '自定义' };
export const PAYMENT_LABEL: Record<PaymentMethod, string> = { 1: '转账', 2: '现金', 3: '冲抵货款', 4: '其他' };

export interface SupplierExpense {
  id: number;
  expenseNo: string;
  supplierId: string;
  supplierName: string;
  expenseType: ExpenseType;
  item: string;
  settleMethod: SettleMethod;
  expenseDate: string;
  dueDate: string;
  totalAmount: number;
  settledAmount: number;
  unsettledAmount: number;
  status: ExpenseStatus;
  overdue: boolean;
  remark: string;
  hasImages: boolean;
  // 返货（expenseType=2）：关联商品档案、无单价、不折算金额
  productId: number;
  productName: string;
  rebateCycle: RebateCycle;
  rebateQty: number;
  rebateUnit: string;
  rebateStartDate: string;
  nextRebateDate: string;
  maturityDate: string;
  rebateTotalPeriods: number;
  // 返钱分期计划（expenseType=1 且启用计划时有值；totalAmount=计划合计推导）
  planJson: PlanPeriod[];
  planTotal: number;
  planSettled: number;
  planPending: number;
  createdAt: string;
}

export interface SettlementRecord {
  id: number;
  expenseId: number;
  settleAmount: number;
  paymentMethod: PaymentMethod;
  settleDate: string;
  operator: string;
  isReversal: boolean;
  isRebate: boolean;
  rebatePeriod: string;
  remark: string;
  createdAt: string;
  images?: ExpenseImage[];
}

export interface ExpenseImage {
  id: number;
  imageId: number | null;
  imageUrl: string;
  sort: number;
}

// 返钱分期计划期次（与 PC 端 PlanPeriod 对齐；后端 plan_json TEXT 列存储）
// status：0=待结 1=已结 3=作废；逾期= status===0 且 planDate < 今天（前端计算）
export interface PlanPeriod {
  seq: number;
  planDate: string;
  planAmount: number;
  remark?: string;
  status: number;
  settledAmount: number;
  settledDate: string | null;
  images?: { url: string }[];
}

export interface ExpenseDetail {
  expense: SupplierExpense;
  settlements: SettlementRecord[];
  images: ExpenseImage[];
}

export interface ExpenseSummary {
  totalCount: number;
  totalAmount: number;
  settledAmount: number;
  unsettledAmount: number;
  pendingCount: number;
  overdueCount: number;
  overdueAmount: number;
}

export interface ExpenseQuery {
  keyword?: string;
  supplierId?: string;
  expenseType?: ExpenseType;
  settleMethod?: SettleMethod;
  status?: ExpenseStatus;
  overdue?: 0 | 1;
}

/**
 * 图片提交形态：{ imageUrl, imageId }。
 * 后端 POST /api/supplier-expenses 读的是 im.imageUrl。
 */
export interface ExpenseImageDraft {
  imageUrl: string;
  imageId: number | null;
}

export type ExpensePayload = {
  supplierId?: string;
  supplierName: string;
  expenseType: ExpenseType;
  item?: string;
  settleMethod?: SettleMethod;
  expenseDate: string;
  dueDate?: string;
  totalAmount?: number;
  remark?: string;
  // 返货（expenseType=2）：关联商品档案、无单价、不折算金额
  productId?: number;
  productName?: string;
  rebateCycle?: RebateCycle;
  rebateQty?: number;
  rebateUnit?: string;
  rebateStartDate?: string;
  maturityDate?: string;
  rebateTotalPeriods?: number;
  images?: ExpenseImageDraft[];
  // 返钱分期计划：启用计划时传期次数组（总额由计划合计推导）；关闭计划时传 [] 清空残留
  planJson?: PlanPeriod[];
};

export async function updateExpense(baseUrl: string, id: number, payload: ExpensePayload): Promise<SupplierExpense> {
  return apiJson<SupplierExpense>(baseUrl, `/api/supplier-expenses/${id}`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  });
}

export async function deleteExpense(baseUrl: string, e: SupplierExpense): Promise<void> {
  // 两步删除统一走 api/twoStepDelete（审查报告 P2-6：不再各模块各写一套）
  await twoStepDelete(
    baseUrl,
    `/api/supplier-expenses/${e.id}`,
    'supplier_expense',
    e.id,
    e.expenseNo
  );
}

export async function reverseExpense(
  baseUrl: string,
  id: number,
  payload: { settleAmount: number; paymentMethod?: PaymentMethod; remark?: string }
): Promise<SupplierExpense> {
  return apiJson<SupplierExpense>(baseUrl, `/api/supplier-expenses/${id}/reverse`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function fetchExpenses(baseUrl: string, params?: ExpenseQuery): Promise<SupplierExpense[]> {
  const list = await apiJson<SupplierExpense[]>(baseUrl, `/api/supplier-expenses${buildQuery(params)}`);
  return Array.isArray(list) ? list : [];
}

export async function fetchExpenseSummary(baseUrl: string): Promise<ExpenseSummary> {
  try {
    const d = await apiJson<ExpenseSummary>(baseUrl, '/api/supplier-expenses/summary');
    if (d && typeof d === 'object') return d;
  } catch (e) {
    console.warn('[supplier-expense] 统计卡加载失败：', e);
  }
  return { totalCount: 0, totalAmount: 0, settledAmount: 0, unsettledAmount: 0, pendingCount: 0, overdueCount: 0, overdueAmount: 0 };
}

export async function getExpenseDetail(baseUrl: string, id: number): Promise<ExpenseDetail | null> {
  try {
    const d = await apiJson<ExpenseDetail>(baseUrl, `/api/supplier-expenses/${id}`);
    if (d && d.expense) return d;
    return null;
  } catch (e) {
    console.warn('[supplier-expense] 详情加载失败：', e);
    return null;
  }
}

export async function createExpense(baseUrl: string, payload: ExpensePayload): Promise<SupplierExpense> {
  return apiJson<SupplierExpense>(baseUrl, '/api/supplier-expenses', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function settleExpense(
  baseUrl: string,
  id: number,
  payload: { settleAmount?: number; paymentMethod?: PaymentMethod; settleDate?: string; remark?: string; images?: ExpenseImageDraft[]; planSeq?: number }
): Promise<SupplierExpense> {
  return apiJson<SupplierExpense>(baseUrl, `/api/supplier-expenses/${id}/settle`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

// 拍照上传：调既有 /api/upload（uploadImage 已处理 base64 转换与命名）。
// 返回图片 url；失败抛错由调用方提示，不做整单中断。
export async function uploadExpenseImage(
  baseUrl: string,
  localUri: string,
  name: string,
  date: string
): Promise<string> {
  const url = await uploadImage(baseUrl, localUri, name, date);
  if (!url) throw new Error('图片上传失败，请重试');
  return url;
}
