// ============ 供应商陈列费 · 纯展示文案（零依赖） ============
//
// 【为什么单独成模块】
// PC 侧 retail-admin 的测试通过 vitest 别名 `@mobile-utils` 跨仓引用本文件，运行环境是 node。
// 因此本文件**禁止 import 任何 react-native / expo / api 模块** —— api 层会引入
// expo-file-system、expo-image-manipulator 等原生依赖，在 node 环境根本无法解析。
// 类型也一律在本文件内本地定义，不向 api 取，彻底切断运行期依赖。
//
// 【一致性约定】
// 这里的文案必须与 PC retail-admin/src/api/supplierExpense.ts 的同名常量语义一致；
// 该一致性由 PC 侧 `src/utils/expenseCsv.dual.test.ts` 守卫（跨仓比对），改动任一侧都会变红。

export type ExpenseType = 1 | 2 | 3; // 1=返钱 2=返货 3=寄售铺货
export type SettleMethod = 1 | 2 | 3 | 5 | 6; // 1=年结 2=月结 3=按次 5=季度结 6=自定义
export type ExpenseStatus = 0 | 1 | 2; // 0=待结算 1=部分结算 2=已结清

export const EXPENSE_TYPE_LABEL: Record<ExpenseType, string> = { 1: '返钱', 2: '返货', 3: '寄售' };
export const SETTLE_METHOD_LABEL: Record<SettleMethod, string> = { 1: '年结', 2: '月结', 3: '按次', 5: '季度结', 6: '自定义' };

export function statusLabel(s: ExpenseStatus): string {
  return s === 2 ? '已结清' : s === 1 ? '部分结算' : '待结算';
}
