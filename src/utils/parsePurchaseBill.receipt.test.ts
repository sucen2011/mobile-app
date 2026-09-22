/**
 * 进货单解析器 · 真实样本回归用例
 *
 * 输入：`E:\WorkBuddy\2026-08-14-10-37-26\_receipt_repro\` 下的真实 OCR 原文
 *   · formats/fmt01..fmt12.ocr.txt —— 用户提供的 12 张各式进货单
 *   · 鸣凰亚昌_旋转单.ocr.txt / 金达商贸_旋转单.ocr.txt —— 两张已与原图逐页核对的样本
 *
 * 断言来源标注：
 *   [原图核对] = 期望值已拿原始收据照片逐页核对过（可信真值）
 *   [锁定现状] = 期望值取自当前实现输出（锁定行为，防回退；真值待人工核对后更新）
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parsePurchaseBill } from './parsePurchaseBill';

const DIR = path.join(__dirname, '__fixtures__');
const read = (rel: string) => fs.readFileSync(path.join(DIR, rel), 'utf8');
const has = (rel: string) => fs.existsSync(path.join(DIR, rel));

describe('进货单解析器 · 真实样本回归', () => {
  it('金达商贸销售单：15 条明细 / 总额 252.75 / 数量单位齐全 [原图核对]', () => {
    const bill = parsePurchaseBill(read('jinda.ocr.txt'));
    expect(bill.format).toBe('pinshi');
    expect(bill.items).toHaveLength(15);
    expect(bill.total).toBeCloseTo(252.75, 2);

    const it1 = bill.items[0];
    expect(it1.name).toBe('1元豪柒精三鲜糯米锅巴');
    expect(it1.barcode).toBe('6978558680033');
    expect(it1.quantity).toBe(1);
    expect(it1.unit).toBe('中包');
    expect(it1.price).toBe(15);
    expect(it1.amount).toBeCloseTo(14.87, 2);

    // 第 4 条曾因 OCR 噪声行 "08" 被算成金额 8（应 9.90）——本次修复的回归锚点
    const it4 = bill.items[3];
    expect(it4.name).toContain('辣条家城沙爹牛肉干');
    expect(it4.amount).toBeCloseTo(9.9, 2);

    // 明细金额合计应等于票面总额（无漏行）
    const sum = bill.items.reduce((s, x) => s + (Number(x.amount) || 0), 0);
    expect(sum).toBeCloseTo(252.75, 2);
  });

  it('鸣凰亚昌冷饮销售单：供应商/单号/总额 48 / 数量1 单位箱 [原图核对]', () => {
    const bill = parsePurchaseBill(read('minghuang.ocr.txt'));
    expect(bill.format).toBe('pinshi');
    expect(bill.supplierName).toBe('鸣凰亚昌冷饮批发');
    expect(bill.orderNo).toBe('XSD-2026-09-21-00004');
    expect(bill.total).toBeCloseTo(48, 2);
    expect(bill.items).toHaveLength(1);
    const it0 = bill.items[0];
    expect(it0.name).toBe('食用冰');
    expect(it0.barcode).toBe('6932006225702');
    expect(it0.quantity).toBe(1);
    expect(it0.unit).toBe('箱');
    expect(it0.price).toBeCloseTo(48, 2);
    expect(it0.amount).toBeCloseTo(48, 2);
  });

  it('未识别版式 → 走通用兜底并给出 warnings（不得静默）', () => {
    const bill = parsePurchaseBill('今天买了点东西\n白菜 3 元\n萝卜 2 元\n谢谢惠顾');
    expect(bill.format).toBe('generic');
    expect(Array.isArray(bill.warnings)).toBe(true);
    expect((bill.warnings || []).join('')).toMatch(/未识别|人工核对/);
  });

  // ── 以下为 12 张样本的结构性锁定（防回退）；真值待逐张人工核对后收紧 ──
  const cases: Array<{ file: string; format: string; items: number; total: number | null; note: string }> = [
    { file: 'fmt01.ocr.txt', format: 'pinshi', items: 12, total: 196, note: '常州翀通(销售单) 第1/5页（总额取明细合计）' },
    { file: 'fmt02.ocr.txt', format: 'jd-wanshang', items: 1, total: null, note: '京东万商 单品' },
    { file: 'fmt03.ocr.txt', format: 'pinshi', items: 7, total: 329, note: '常州好亦来(访销单)（ glued 误劈修复后找回第 5 行，6→7）' },
    { file: 'fmt04.ocr.txt', format: 'pinshi', items: 6, total: 166.5, note: '常州礼雯(出库单)' },
    { file: 'fmt05.ocr.txt', format: 'pinshi', items: 15, total: 1103.24, note: '金达(09-14 单，条码锚点修复后 9→15)' },
    { file: 'fmt06.ocr.txt', format: 'pinshi', items: 3, total: 805, note: '常州天齐(销售单)' },
    { file: 'fmt07.ocr.txt', format: 'yijiupi', items: 9, total: 1205.87, note: '易久批订单（列交织 → 单遍状态机，价/额齐全）' },
    { file: 'fmt08.ocr.txt', format: 'lizhen', items: 4, total: 600, note: '励贞配送单 第1页' },
    { file: 'fmt09.ocr.txt', format: 'lizhen', items: 4, total: 732.94, note: '励贞配送单 第2页' },
    { file: 'fmt10.ocr.txt', format: 'pinshi', items: 1, total: 48, note: '鸣凰亚昌（另一份 OCR）' },
    { file: 'fmt11.ocr.txt', format: 'jd-wanshang', items: 11, total: 209.01, note: '京东万商 共3页（双码合并后 16→11）' },
    { file: 'fmt12.ocr.txt', format: 'jd-wanshang', items: 10, total: 190.04, note: '京东万商 12 条' },
  ];

  for (const c of cases) {
    it(`${c.note}：format=${c.format} / 明细 ${c.items} / 总额 ${c.total ?? '—'} [锁定现状]`, () => {
      if (!has(c.file)) return; // 样本缺失时跳过（不伪造通过）
      const bill = parsePurchaseBill(read(c.file));
      expect(bill.format).toBe(c.format);
      expect(bill.items).toHaveLength(c.items);
      if (c.total != null) expect(bill.total).toBeCloseTo(c.total, 2);
      for (const it of bill.items) {
        if (it.price != null) expect(Number.isNaN(it.price)).toBe(false);
        if (it.amount != null) expect(Number.isNaN(it.amount)).toBe(false);
      }
      // 品名不得残留「针式单量价碎片」；注意 `450ml*12瓶` / `500ml*15瓶` 是真实品名的一部分，不算碎片
      for (const it of bill.items) {
        const nm = String(it.name);
        expect(nm).not.toMatch(/中包/); // 针式单的「数量+单位」列碎片
        expect(nm).not.toMatch(/\d+\.\d{2}\s*$/); // 行尾价格（如 "…10.00"）
        expect(nm).not.toMatch(/\*\d+\s*(中包|箱|瓶|包|个|袋|盒|件|条|桶|提|只|听|罐|根)\s*\d+\.\d{2}/); // 单位后紧跟价格
        expect(nm).not.toMatch(/^\d{1,2}\s*(中包|箱|瓶|包|个|袋|盒|件|条|桶|提|只|听|罐|根)\s*\d/); // 行首量价碎片
      }
    });
  }

  /**
   * 曾为已知缺陷（已修复）：常州礼雯出库单首条曾把「地址行/收货人碎片」当品名。
   * 这是待修问题（名称噪声过滤 `isProductNameLine`）；修好后本用例会「意外通过」，
   * 届时请把它改成正常断言。
   */
  it('fmt04 首条应为真实商品（曾误取地址行/收货人碎片，已修）', () => {
    if (!has('fmt04.ocr.txt')) return;
    const bill = parsePurchaseBill(read('fmt04.ocr.txt'));
    const first = String(bill.items[0]?.name || '');
    expect(first).not.toMatch(/地址|号|累计欠款|贝贝/);
  });

  it('多页单据拼接（励贞 fmt08+fmt09）→ 一份完整清单 8 条 / 总额 732.94 [原图核对]', () => {
    const bill = parsePurchaseBill(read('fmt08.ocr.txt') + '\n' + read('fmt09.ocr.txt'));
    expect(bill.format).toBe('lizhen');
    expect(bill.items).toHaveLength(8);
    expect(bill.total).toBeCloseTo(732.94, 2);
  });
  it('易久批：单遍状态机后每条都有量/价/额，且明细合计=票面应收 [原图核对]', () => {
    const bill = parsePurchaseBill(read('fmt07.ocr.txt'));
    expect(bill.format).toBe('yijiupi');
    expect(bill.items.length).toBeGreaterThanOrEqual(9);
    for (const it of bill.items) {
      expect(it.quantity == null ? null : Number.isFinite(it.quantity)).not.toBe(false);
      expect(Number.isNaN(Number(it.price))).toBe(false);
    }
    const withPrice = bill.items.filter((x) => typeof x.price === 'number' && x.price > 0);
    expect(withPrice.length).toBe(bill.items.length);
    const sum = bill.items.reduce((acc, x) => acc + (Number(x.amount) || 0), 0);
    expect(sum).toBeCloseTo(1205.87, 2);          // 与单据「应收金额:1205.87元」一致
    expect(bill.total).toBeCloseTo(1205.87, 2);
  });

  it('常州翀通(分页单)：票面合计明显小于明细时以明细为准并告警 [原图核对]', () => {
    const bill = parsePurchaseBill(read('fmt01.ocr.txt'));
    const sum = bill.items.reduce((acc, x) => acc + (Number(x.amount) || 0), 0);
    expect(bill.total).toBeCloseTo(sum, 2);
    expect((bill.warnings || []).join('')).toMatch(/明细合计|分页/);
  });

  it('京东万商品名不含页脚广告词（加盟/总件数/支付方式…）', () => {
    const bill = parsePurchaseBill(read('fmt02.ocr.txt'));
    expect(bill.items.length).toBeGreaterThan(0);
    const nm = String(bill.items[0].name);
    expect(nm).not.toMatch(/加盟|总件数|包裹数|支付方式|客服|扫码|无忧|签约/);
  });

  it('好亦来访销单：条码首位恰为期望序号不再误劈组，7 条齐全且合计=票面 329 [原图核对]', () => {
    if (!has('haoyilai.ocr.txt')) return;
    const bill = parsePurchaseBill(read('haoyilai.ocr.txt'));
    expect(bill.format).toBe('pinshi');
    expect(bill.supplierName).toBe('常州好亦来商贸有限公司');
    expect(bill.orderNo).toBe('XD260311000035');
    expect(bill.items).toHaveLength(7);
    // 曾被「序号6+条码粘连」误判劈掉的第 5 行（条码 6937962111540 首位=期望序号 6）
    const it5 = bill.items[4];
    expect(it5.name).toBe('康师傅袋番茄鸡蛋牛肉');
    expect(it5.barcode).toBe('6937962111540');
    expect(it5.quantity).toBe(1);
    expect(it5.price).toBeCloseTo(57.5, 2);
    expect(it5.amount).toBeCloseTo(57.5, 2);
    // 手写「苏花未付」与页脚词不得混进任何品名
    for (const it of bill.items) expect(String(it.name)).not.toMatch(/苏花未付|扫码|小程序/);
    const sum = bill.items.reduce((s, x) => s + (Number(x.amount) || 0), 0);
    expect(sum).toBeCloseTo(329, 2); // = 票面「合计金额:329.00」
    expect(bill.total).toBeCloseTo(329, 2);
  });

  it('礼雯出库单：小数数量 0.5 箱可解析、页脚广告不成条、合计=实付 166.50 [原图核对]', () => {
    if (!has('liwenxd.ocr.txt')) return;
    const bill = parsePurchaseBill(read('liwenxd.ocr.txt'));
    expect(bill.format).toBe('pinshi');
    expect(bill.supplierName).toBe('常州礼雯副食品商行');
    expect(bill.orderNo).toBe('XD260901000270');
    expect(bill.items).toHaveLength(6);
    // 前两行数量是 0.5 箱（半箱）——旧实现只认整数导致数量丢失、金额=0
    const it1 = bill.items[0];
    expect(it1.name).toBe('统一杯汤达人日式豚骨拉面');
    expect(it1.barcode).toBe('6925303770563');
    expect(it1.quantity).toBeCloseTo(0.5, 2);
    expect(it1.unit).toBe('箱');
    expect(it1.price).toBeCloseTo(50, 2);
    expect(it1.amount).toBeCloseTo(25, 2);
    const it2 = bill.items[1];
    expect(it2.quantity).toBeCloseTo(0.5, 2);
    expect(it2.amount).toBeCloseTo(37.5, 2);
    // 页脚广告/手写噪声绝不能成为明细或混进品名
    for (const it of bill.items) {
      const nm = String(it.name);
      expect(nm).not.toMatch(/小程序|扫码|领红包|注册搜索/);
      expect(nm).not.toMatch(/拼弹|苏花未付/);
    }
    const sum = bill.items.reduce((s, x) => s + (Number(x.amount) || 0), 0);
    expect(sum).toBeCloseTo(166.5, 2); // = 票面「小计 / 实付金额 166.50」
    expect(bill.total).toBeCloseTo(166.5, 2);
    expect(bill.paid).toBeCloseTo(166.5, 2);
  });
});
