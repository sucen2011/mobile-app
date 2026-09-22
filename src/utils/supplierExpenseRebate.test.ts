// 回归测试：寄售/返货屏两个 bug 的纯函数逻辑。
// 采用「运行期转译屏幕文件 + 万能 stub 顶掉 RN 依赖」的方式，直接加载真实函数（非复制实现），
// 确保测的是生产代码真身。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

const SCREEN = path.resolve(process.cwd(), 'src/screens/SupplierExpenseScreen.tsx');
const src = readFileSync(SCREEN, 'utf8');

// 万能 stub：任何属性/调用/构造都返回自身，__esModule 视为 true（与 vitest/node 环境兼容）
function makeStub(): any {
  const fn: any = function () { return makeStub(); };
  return new Proxy(fn, {
    get(_t, prop) {
      if (prop === '__esModule') return true;
      if (prop === 'default') return makeStub();
      if (prop === Symbol.iterator) return undefined;
      if (prop === 'then') return undefined;
      return makeStub();
    },
    apply() { return makeStub(); },
    construct() { return makeStub(); },
  });
}
const reqStub = () => makeStub();

const out = ts.transpileModule(src, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2020,
    jsx: ts.JsxEmit.React,
    jsxFactory: 'React.createElement',
    jsxFragmentFactory: 'React.Fragment',
  },
}).outputText;

const wrapped = out + '\nmodule.exports.__buildRebatePeriods = buildRebatePeriods;\nmodule.exports.__rebatePerPeriodQty = rebatePerPeriodQty;\n';
const mod: any = { exports: {} };
// eslint-disable-next-line no-new-func
new Function('exports', 'module', 'require', 'global', wrapped)(mod.exports, mod, reqStub, global);

const buildRebatePeriods = mod.exports.__buildRebatePeriods;
const rebatePerPeriodQty = mod.exports.__rebatePerPeriodQty;

describe('buildRebatePeriods —— Bug1：批次时间都一样', () => {
  it('旧季度单 cycle=0 但后端带逐期真值 → 各期 planDate 互不相同', () => {
    const e = {
      expenseType: 2,
      rebateCycle: 0,
      rebateStartDate: '2025-04-01',
      rebateQty: 30,
      rebateTotalPeriods: 3,
      rebatePlanItems: [
        { seq: 1, planDate: '2025-07-01' },
        { seq: 2, planDate: '2025-10-01' },
        { seq: 3, planDate: '2026-01-01' },
      ],
    };
    const rows = buildRebatePeriods(e, []);
    expect(rows).toHaveLength(3);
    const dates = rows.map((r: any) => r.planDate);
    expect(new Set(dates).size).toBe(3); // 不再塌成同一天
    expect(dates).toEqual(['2025-07-01', '2025-10-01', '2026-01-01']);
  });

  it('回退标量推算（cycle=3 有 startDate）仍逐期不同', () => {
    const e = {
      expenseType: 2,
      rebateCycle: 3,
      rebateStartDate: '2026-01-15',
      rebateQty: 10,
      rebateTotalPeriods: 4,
    };
    const rows = buildRebatePeriods(e, []);
    expect(rows).toHaveLength(4);
    expect(new Set(rows.map((r: any) => r.planDate)).size).toBe(4);
  });
});

describe('rebatePerPeriodQty —— Bug2：每期30 实为每期10', () => {
  it('按计划分期的返货：rebateQty 是总量，单期量应从 rebatePlanItems[0].items 取', () => {
    const e = {
      expenseType: 2,
      rebateCycle: 0,
      rebateQty: 30, // 后端存成总量（10×3）
      rebateTotalPeriods: 3,
      rebatePlanItems: [
        { seq: 1, planDate: '2025-07-01', items: [{ name: '雪花', qty: 10 }] },
        { seq: 2, planDate: '2025-10-01', items: [{ name: '雪花', qty: 10 }] },
        { seq: 3, planDate: '2026-01-01', items: [{ name: '雪花', qty: 10 }] },
      ],
    };
    expect(rebatePerPeriodQty(e)).toBe(10); // 不是 30
  });

  it('标量返货（无 plan items）：单期量 = rebateQty', () => {
    const e = { expenseType: 2, rebateQty: 20, rebatePlanItems: [] };
    expect(rebatePerPeriodQty(e)).toBe(20);
  });
});
