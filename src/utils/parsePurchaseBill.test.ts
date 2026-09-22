// 回归测试：12 张进货单 + 金达/鸣凰，共 14 份固定样本 + fmt08+fmt09 拼接 + 通用兜底。
// 期望值均来自各 .ocr.txt 原文的解析结果（parsePurchaseBill 的确定性输出），
// 即「依据 OCR 原文」的自动化落点；若解析器数值变化，本文件即回归基线。
import { test, expect } from 'vitest';
import { parsePurchaseBill } from './parsePurchaseBill';
import * as fs from 'fs';
import * as path from 'path';

const FIX = path.join(__dirname, '__fixtures__');
function read(name: string): string {
  return fs.readFileSync(path.join(FIX, name + '.ocr.txt'), 'utf8');
}

test('fmt01 针式销售单(分页第1/5页): pinshi, 12 明细, 多页警告', () => {
  const bill = parsePurchaseBill(read('fmt01'));
  expect(bill.format).toBe('pinshi');
  expect(bill.items.length).toBe(12);
  // fmt01 为分页单据，本页合计不可靠，仅断言行内分页警告
  expect((bill.warnings || []).some((w) => /多页|分页/.test(w))).toBe(true);
  const item = bill.items.find((i) => i.barcode === '6930334555171'); // 依据原文 E67苏太太210g原味香瓜子
  expect(item).toBeTruthy();
  expect(item!.name).toContain('苏太太210g原味香瓜子');
  expect(item!.quantity).toBe(3);
  expect(item!.price).toBeCloseTo(8.5, 2);
  expect(item!.amount).toBeCloseTo(25.5, 2);
});

test('fmt02 京东万商: jd-wanshang, 1 明细', () => {
  const bill = parsePurchaseBill(read('fmt02'));
  expect(bill.format).toBe('jd-wanshang');
  expect(bill.items.length).toBe(1);
  const item = bill.items[0]; // 依据原文 李字檀香型蚊香单盒装
  expect(item.barcode).toBe('6904588680170');
  expect(item.quantity).toBe(3);
});

test('fmt03 针式销售单: pinshi, 7 明细, 总额 329.00', () => {
  const bill = parsePurchaseBill(read('fmt03'));
  expect(bill.format).toBe('pinshi');
  expect(bill.items.length).toBe(7);
  expect(bill.total).toBeCloseTo(329, 2); // 依据原文 合计金额:329.00
  const item = bill.items.find((i) => i.barcode === '6920152414040'); // 康师傅桶鲜虾鱼板
  expect(item!.quantity).toBe(1);
  expect(item!.price).toBeCloseTo(48.5, 2);
});

test('fmt04 针式销售单: pinshi, 8 明细, 总额 166.50', () => {
  const bill = parsePurchaseBill(read('fmt04'));
  expect(bill.format).toBe('pinshi');
  expect(bill.items.length).toBe(8);
  expect(bill.total).toBeCloseTo(166.5, 2); // 依据原文 实付金额 166.50
  const item = bill.items.find((i) => i.barcode === '6925303770563'); // 统一杯汤达人日式豚骨拉面
  expect(item!.price).toBeCloseTo(50, 2);
});

test('fmt05 针式销售单: pinshi, 9 明细, 总额 344.35', () => {
  const bill = parsePurchaseBill(read('fmt05'));
  expect(bill.format).toBe('pinshi');
  expect(bill.items.length).toBe(9);
  expect(bill.total).toBeCloseTo(344.35, 2);
  const item = bill.items.find((i) => i.barcode === '6920459991602'); // 1L 康师傅冰绿茶
  expect(item!.quantity).toBe(1);
  expect(item!.price).toBeCloseTo(38, 2);
});

test('fmt06 针式销售单: pinshi, 3 明细, 总额 805.00', () => {
  const bill = parsePurchaseBill(read('fmt06'));
  expect(bill.format).toBe('pinshi');
  expect(bill.items.length).toBe(3);
  expect(bill.total).toBeCloseTo(805, 2); // 依据原文 总计 805.00
  const item = bill.items.find((i) => i.barcode === '6949352205159'); // 雪花 清爽
  expect(item!.quantity).toBe(20); // 条码不再被误当数量
  expect(item!.price).toBeCloseTo(30, 2);
  expect(item!.amount).toBeCloseTo(600, 2);
});

test('fmt07 易久批: yijiupi, 7 明细, 总额 1205.87', () => {
  const bill = parsePurchaseBill(read('fmt07'));
  expect(bill.format).toBe('yijiupi');
  expect(bill.items.length).toBe(7); // 表头行(单价/数量/箱号)不计入
  expect(bill.total).toBeCloseTo(1205.87, 2); // 依据原文 合计 1205.87
  const item = bill.items.find((i) => i.barcode === '6901035606752'); // 乐堡小麦精酿啤酒9度1L
  expect(item!.quantity).toBe(1);
  const guibin = bill.items.find((i) => i.barcode === '6901683821255'); // 贵宾歪脖小郎酒45度100ml
  expect(guibin!.quantity).toBe(1);
});

test('fmt08 励贞配送单: lizhen, 4 明细, 总额 600.00', () => {
  const bill = parsePurchaseBill(read('fmt08'));
  expect(bill.format).toBe('lizhen');
  expect(bill.items.length).toBe(4);
  expect(bill.total).toBeCloseTo(600, 2); // 依据原文 合计 600
  const item = bill.items.find((i) => i.barcode === '6902827100069'); // 百事可乐600MLx24瓶
  expect(item!.quantity).toBe(1);
  expect(item!.price).toBeCloseTo(45.99, 2);
});

test('fmt09 励贞配送单: lizhen, 4 明细, 总额 732.94', () => {
  const bill = parsePurchaseBill(read('fmt09'));
  expect(bill.format).toBe('lizhen');
  expect(bill.items.length).toBe(4);
  expect(bill.total).toBeCloseTo(732.94, 2); // 依据原文 合计 732.94
  const item = bill.items.find((i) => i.barcode === '6953631800737'); // 斑布700g无芯卷纸10卷
  expect(item!.quantity).toBe(10);
  expect(item!.price).toBeCloseTo(8.9, 2);
});

test('fmt10 鸣凰亚昌(针式单品): pinshi, 1 明细, 总额 48.00', () => {
  const bill = parsePurchaseBill(read('fmt10'));
  expect(bill.format).toBe('pinshi');
  expect(bill.items.length).toBe(1);
  expect(bill.total).toBeCloseTo(48, 2); // 依据原文 成交金额:48.00
  const item = bill.items[0]; // 食用冰
  expect(item.barcode).toBe('6932006225702');
  expect(item.quantity).toBe(1);
  expect(item.price).toBeCloseTo(48, 2);
});

test('fmt11 京东万商: jd-wanshang, 16 明细, 总额 189.02', () => {
  const bill = parsePurchaseBill(read('fmt11'));
  expect(bill.format).toBe('jd-wanshang');
  expect(bill.items.length).toBe(16);
  expect(bill.total).toBeCloseTo(189.02, 2);
  const item = bill.items.find((i) => i.barcode === '2304046924187'); // 洽洽150g奶香瓜子
  expect(item!.quantity).toBe(5);
  expect(item!.price).toBeCloseTo(5.38, 2);
});

test('fmt12 京东万商: jd-wanshang, 10 明细, 总额 190.04', () => {
  const bill = parsePurchaseBill(read('fmt12'));
  expect(bill.format).toBe('jd-wanshang');
  expect(bill.items.length).toBe(10);
  expect(bill.total).toBeCloseTo(190.04, 2);
  const item = bill.items.find((i) => i.barcode === '6925303751364'); // 整箱统一绿茶500ml*15瓶/箱
  expect(item!.quantity).toBe(1);
  expect(item!.price).toBeCloseTo(28.8, 2);
});

test('jinda 金达商贸(针式): pinshi, 15 明细, 总额 252.75', () => {
  const bill = parsePurchaseBill(read('jinda'));
  expect(bill.format).toBe('pinshi');
  expect(bill.items.length).toBe(15);
  expect(bill.total).toBeCloseTo(252.75, 2); // 依据原文 合计 252.75
  const item = bill.items.find((i) => i.barcode === '6978558680033'); // 1元豪柒精三鲜糯米锅巴
  expect(item!.quantity).toBe(1);
  expect(item!.price).toBeCloseTo(15, 2);
});

test('minghuang 鸣凰亚昌(针式单品): pinshi, 1 明细, 总额 48.00', () => {
  const bill = parsePurchaseBill(read('minghuang'));
  expect(bill.format).toBe('pinshi');
  expect(bill.items.length).toBe(1);
  expect(bill.total).toBeCloseTo(48, 2); // 依据原文 成交金额:48.00
  const item = bill.items[0]; // 食用冰
  expect(item.barcode).toBe('6932006225702');
  expect(item.quantity).toBe(1);
});

test('fmt08+fmt09 拼接: lizhen, 8 明细, 总额 732.94', () => {
  const bill = parsePurchaseBill(read('fmt08') + '\n' + read('fmt09'));
  expect(bill.format).toBe('lizhen');
  expect(bill.items.length).toBe(8);
  expect(bill.total).toBeCloseTo(732.94, 2);
});

test('通用兜底：未识别版式 → format=generic + 人工核对警告', () => {
  const text = '这是一张随手写的单据 没有任何条码 也没有结构化列 金额壹佰圆整';
  const bill = parsePurchaseBill(text);
  expect(bill.format).toBe('generic');
  expect((bill.warnings || []).some((w) => /未识别/.test(w))).toBe(true);
});
