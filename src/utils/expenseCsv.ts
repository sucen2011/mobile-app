// ============ 供应商陈列费 · CSV 导出（纯函数，可跨仓单测） ============
//
// 【为什么单独成模块】
// 原本这段逻辑写在 screens/SupplierExpenseScreen.tsx 里，而该文件 import react-native，
// 导致无法在 node 环境被 PC 侧测试引用。抽出来后：
//   - 移动端：screen 直接 import 本模块的 buildExpenseCsv；
//   - PC 侧：通过 vitest 别名 `@mobile-utils/expenseCsv` 引用同一份源码做双端一致性断言。
// 因此本文件同样禁止引入任何 RN / expo 依赖（SupplierExpense 用 import type，编译期擦除）。

import type { SupplierExpense } from '../api/supplierExpense';
import { EXPENSE_TYPE_LABEL, SETTLE_METHOD_LABEL, statusLabel } from './expenseLabels';

/** CSV 单元格转义：含逗号/引号/换行时加英文双引号并把内部引号翻倍 */
export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : String(v);
  if (/[",\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

/**
 * 生成费用单 CSV 文本（含品牌列）。加 UTF-8 BOM，否则 Excel 打开中文会乱码。
 * 列顺序与 PC 端导出保持一致（含「结算时机」列），避免两份表合并后同一列语义不同。
 */
export function buildExpenseCsv(list: SupplierExpense[]): string {
  const BOM = '\uFEFF';
  const header = ['费用单号', '供应商', '品牌', '费用项目', '费用类型', '结算时机', '结算方式', '发生日期', '到期日', '总金额', '已结算', '未结算', '状态'];
  const lines = [header.map(csvCell).join(',')];
  (list || []).forEach((e) => {
    const isRebate = e.expenseType === 2;
    // 寄售返货（expenseType=3 & returnType=2）与返货同理：settledAmount 为已收期数，按返货口径导出
    const nonMoney = isRebate || (e.expenseType === 3 && e.returnType === 2);
    // 返货的「未结算」= 还剩几期没确认收货；不限期数（rebateTotalPeriods=0）显示「长期」（与 PC 一致）
    const rebateLeft = (Number(e.rebateTotalPeriods) || 0) > 0
      ? `${Math.max(0, (Number(e.rebateTotalPeriods) || 0) - Math.round(Number(e.settledAmount) || 0))} 期`
      : '长期';
    const unsettled = isRebate ? '' : Math.max(0, (Number(e.totalAmount) || 0) - (Number(e.settledAmount) || 0)).toFixed(2);
    // 寄售按结算时机区分：现给写「返货/返钱」，到期给写「到期返货/到期返钱」（与 PC 导出列口径一致）
    const isConsignExp = e.expenseType === 3;
    const isNowExp = e.settlementTiming === 1;
    const methodLabel = isRebate
      ? '返货'
      : isConsignExp
        ? (isNowExp ? (e.returnType === 2 ? '返货' : '返钱') : (e.returnType === 2 ? '到期返货' : '到期返钱'))
        : (SETTLE_METHOD_LABEL[e.settleMethod] || '');
    lines.push([
      e.expenseNo,
      e.supplierName,
      e.brand || '',
      e.item || '',
      EXPENSE_TYPE_LABEL[e.expenseType] || '',
      // 结算时机：寄售按 settlementTiming 区分现给/到期给（与 PC 导出列口径一致）
      isConsignExp ? (isNowExp ? '现给' : '到期给') : (e.settlementTiming === 2 ? '到期给' : '现给'),
      // 结算方式：寄售现给写「返货/返钱」、到期给写「到期返货/到期返钱」（与 PC 导出列口径一致）
      methodLabel,
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
