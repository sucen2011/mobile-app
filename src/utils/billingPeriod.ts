/**
 * 陈列费「计费周期」生成（mobile 侧；与 PC `retail-admin/src/utils/billingPeriod.ts` 同契约）
 *
 * 契约（2026-09-22 用户拍板 方案 A）：
 *   · coverStart 覆盖期起（打堆/服务期开始）= 覆盖期起 + i × 周期月数（当月 1 日）
 *   · coverEnd   覆盖期止 = coverStart + 周期月数 − 1 天（当月末）
 *   · planDate   计划结算日 = **覆盖期结束的次月 1 日**
 *
 * 例：覆盖期起 2025-01-01、周期=季、3 期
 *   01-01~03-31 → 04-01 ｜ 04-01~06-30 → 07-01 ｜ 07-01~09-30 → 10-01
 *
 * 用纯 Date 运算实现（不引第三方库，避免与 PC 的 dayjs 版本耦合）。
 */

export type BillingCycle = 'month' | 'quarter' | 'half' | 'year';

export const CYCLE_MONTHS: Record<BillingCycle, number> = {
  month: 1,
  quarter: 3,
  half: 6,
  year: 12,
};

export const CYCLE_LABEL: Record<BillingCycle, string> = {
  month: '按月',
  quarter: '按季',
  half: '按半年',
  year: '按年',
};

export interface BillingPeriod {
  seq: number;
  coverStart: string; // YYYY-MM-DD
  coverEnd: string;   // YYYY-MM-DD
  planDate: string;   // 计划结算日 YYYY-MM-DD
}

const pad2 = (n: number) => String(n).padStart(2, '0');
const fmt = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

/** 取某月 1 日（本地时区；入参支持 YYYY-MM / YYYY-MM-DD） */
function firstDayOf(ym: string): Date {
  const [y, m] = ym.split('-').map((x) => Number(x));
  return new Date(y, (m || 1) - 1, 1);
}

/** 在 y 年 m 月（1-12）的第 1 日基础上加 n 个月 */
function addMonths(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth() + n, 1);
}

/**
 * 生成逐期计费周期。
 * @param coverStart 覆盖期起（YYYY-MM 或 YYYY-MM-DD；内部归一到当月 1 日）
 * @param cycle      周期类型（月/季/半年/年）
 * @param count      期数（>=1）
 */
export function buildBillingPeriods(coverStart: string, cycle: BillingCycle, count: number): BillingPeriod[] {
  const months = CYCLE_MONTHS[cycle];
  const base = firstDayOf((coverStart || '').slice(0, 7) || '1970-01');
  const n = Math.max(0, Math.floor(count || 0));
  const out: BillingPeriod[] = [];
  for (let i = 0; i < n; i++) {
    const start = addMonths(base, i * months);
    // 期末 = 下一期首日的前一天（当月末）
    const nextStart = addMonths(base, (i + 1) * months);
    const end = new Date(nextStart.getTime() - 24 * 3600 * 1000);
    out.push({
      seq: i + 1,
      coverStart: fmt(start),
      coverEnd: fmt(end),
      planDate: fmt(nextStart), // 次月 1 日 = 计划结算日
    });
  }
  return out;
}
