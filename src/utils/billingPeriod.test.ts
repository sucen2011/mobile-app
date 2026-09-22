/**
 * 「计费周期」生成单测（mobile 侧，与 PC 同契约 2026-09-22）
 * 契约：coverStart=覆盖期起；coverEnd=期末；planDate（计划结算日）= 期末的次月 1 日
 */
import { describe, it, expect } from 'vitest';
import { buildBillingPeriods, CYCLE_MONTHS } from './billingPeriod';

describe('buildBillingPeriods · 计费周期（mobile）', () => {
  it('周期=季、3 期、覆盖期起 2025-01-01 [契约示例]', () => {
    expect(buildBillingPeriods('2025-01-01', 'quarter', 3)).toEqual([
      { seq: 1, coverStart: '2025-01-01', coverEnd: '2025-03-31', planDate: '2025-04-01' },
      { seq: 2, coverStart: '2025-04-01', coverEnd: '2025-06-30', planDate: '2025-07-01' },
      { seq: 3, coverStart: '2025-07-01', coverEnd: '2025-09-30', planDate: '2025-10-01' },
    ]);
  });

  it('周期=月、2 期 → 计划结算日为次月 1 日', () => {
    expect(buildBillingPeriods('2025-01-01', 'month', 2)).toEqual([
      { seq: 1, coverStart: '2025-01-01', coverEnd: '2025-01-31', planDate: '2025-02-01' },
      { seq: 2, coverStart: '2025-02-01', coverEnd: '2025-02-28', planDate: '2025-03-01' },
    ]);
  });

  it('周期=年、1 期 → 覆盖整年、结算跨年到 2026-01-01', () => {
    expect(buildBillingPeriods('2025-01-01', 'year', 1)).toEqual([
      { seq: 1, coverStart: '2025-01-01', coverEnd: '2025-12-31', planDate: '2026-01-01' },
    ]);
  });

  it('入参只给 YYYY-MM 也成立；闰年 2 月末正确', () => {
    expect(buildBillingPeriods('2025-03', 'month', 1)).toEqual([
      { seq: 1, coverStart: '2025-03-01', coverEnd: '2025-03-31', planDate: '2025-04-01' },
    ]);
    expect(buildBillingPeriods('2024-02-01', 'month', 1)).toEqual([
      { seq: 1, coverStart: '2024-02-01', coverEnd: '2024-02-29', planDate: '2024-03-01' },
    ]);
  });

  it('周期映射与 0 期边界', () => {
    expect(CYCLE_MONTHS).toEqual({ month: 1, quarter: 3, half: 6, year: 12 });
    expect(buildBillingPeriods('2025-01-01', 'month', 0)).toEqual([]);
    expect(buildBillingPeriods('2025-01-01', 'half', 2)).toEqual([
      { seq: 1, coverStart: '2025-01-01', coverEnd: '2025-06-30', planDate: '2025-07-01' },
      { seq: 2, coverStart: '2025-07-01', coverEnd: '2025-12-31', planDate: '2026-01-01' },
    ]);
  });
});
