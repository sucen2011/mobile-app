/**
 * 烟草方案 OCR 文本解析（mobile 副本，与 PC 端 src/utils/parseTobaccoPlan.ts 同步）。
 * 设计原则：宽进严出 —— 能识别的字段尽量填，识别不到的留 null 让人工补；绝不臆造数据。
 */

// 移动端没有 api/tobacco 模块；这里内联一份 RewardType（与 PC 端 api/tobacco.ts 一致）
type RewardType = 'none' | 'direct' | 'weekly';

export interface ParsedTobaccoItem {
  cigarette_name: string;
  item_type: 'order' | 'gift';
  qty: number;
  unit_cost: number | null;
}

export interface ParsedTobaccoTier {
  tier_no: string;
  name: string;
  threshold_qty: number | null;
  selection_type: 'fixed' | 'optional_pool';
  reward_type: RewardType;
  items: ParsedTobaccoItem[];
}

export interface ParsedTobaccoPlan {
  plan_no: string;
  name: string;
  period: string;
  group_name: string;
  reward_policy: string;
  tiers: ParsedTobaccoTier[];
  warnings: string[];
  rawText: string;
}

const ZH_NUM: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };

function defaultPeriod(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export function nextPlanNo(used: ReadonlyArray<string> = []): string {
  const usedNum = new Set(used.map((x) => Number((x.match(/^P(\d+)$/i) || [])[1])).filter((n) => Number.isFinite(n)));
  let n = 1;
  while (usedNum.has(n)) n++;
  return 'P' + n;
}

function extractPeriod(text: string): { period: string; warnings: string[] } {
  const warnings: string[] = [];
  const m1 = text.match(/20\d{2}[-/.年]\s*(1[0-2]|0?[1-9])\s*月?/);
  if (m1) {
    const y = m1[0].slice(0, 4);
    const mo = (m1[1] || m1[0].slice(5, 7)).replace(/[^\d]/g, '').padStart(2, '0');
    return { period: `${y}-${mo}`, warnings };
  }
  const m2 = text.match(/(?:^|\s)(1[0-2]|0?[1-9]|[一二三四五六七八九十])\s*月(份|订|方案|档)?/);
  if (m2) {
    const moRaw = m2[1];
    let mo: number;
    if (/^\d+$/.test(moRaw)) mo = Number(moRaw);
    else mo = ZH_NUM[moRaw] || 0;
    if (mo >= 1 && mo <= 12) {
      const y = new Date().getFullYear();
      warnings.push(`未识别到完整年份，按当前 ${y} 年兜底`);
      return { period: `${y}-${String(mo).padStart(2, '0')}`, warnings };
    }
  }
  warnings.push('未识别到期次（YYYY-MM），已用当前月兜底');
  return { period: defaultPeriod(), warnings };
}

function extractPlanName(text: string, period: string): string {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (const line of lines.slice(0, 8)) {
    if (line.length < 2 || line.length > 24) continue;
    if (/^[\d\s\-_/]+$/.test(line)) continue;
    // 只跳过纯单据编号（XSD-2026-09-06-00017 这种），放过「2026年9月订烟方案」之类的合法标题
    if (/^(?:\d{4}[-/.]\d{1,2}(?:[-/.]\d{1,2})?[-/]\d{2,}|XSD-\d{4,}|\d{6,})$/.test(line)) continue;
    if (/(方案|订烟|卷烟|档位|档)/.test(line)) return line;
  }
  for (const line of lines) {
    if (line.length >= 3 && line.length <= 18 && !/^[\d\s\-_/]+$/.test(line)) {
      return line;
    }
  }
  return `${period} 订烟方案`;
}

function extractRewardType(text: string): { rewardType: RewardType; rewardPolicy: string } {
  const t = text;
  let rewardType: RewardType = 'none';
  const policyBits: string[] = [];
  if (/周奖|分周兑现|按周返|每周奖励/.test(t)) { rewardType = 'weekly'; policyBits.push('分周兑现'); }
  else if (/直奖|直接奖励|当场返|即返/.test(t)) { rewardType = 'direct'; policyBits.push('直接奖励'); }
  else if (/无奖励|无奖/.test(t)) { rewardType = 'none'; }
  const polM = t.match(/(?:达到|满|超过)\s*\d+\s*条[^\n，。；;]{0,20}/);
  if (polM) policyBits.push(polM[0].trim());
  return { rewardType, rewardPolicy: policyBits.join('；') };
}

function extractGroupName(text: string): string {
  const m = text.match(/(?:方案组|组别|分组)[::]\s*([^\n\r,，;； ]{2,16})/);
  return m ? m[1].trim() : '';
}

function extractItemLines(text: string): string[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const out: string[] = [];
  for (const raw of lines) {
    const line = raw.replace(/\s+/g, ' ').trim();
    if (line.length < 3 || line.length > 80) continue;
    if (!/\d/.test(line)) continue;
    if (/^(品名|名称|商品|项目|合计|总计|小计|备注|单价|数量|金额|序号|行号|货号|条码|客户|送货|地址|电话|电话:|电话：)/.test(line)) continue;
    if (/^(规格|单位|赠议|备注|零售|产地)/.test(line)) continue;
    if (/^[\d\s,，.。:：\-_/()（）]+$/.test(line)) continue;
    const hanCount = (line.match(/[\u4e00-\u9fa5]/g) || []).length;
    if (hanCount < 2) continue;
    out.push(line);
  }
  return out;
}

function parseItemLine(line: string): ParsedTobaccoItem | null {
  let m = line.match(/^([\u4e00-\u9fa5][\u4e00-\u9fa5·\u00B7A-Za-z0-9（）()]{1,20})\s*[xX×*\/\\]?\s*(\d{1,4})\s*(条|包|箱|件)?/);
  if (!m) {
    m = line.match(/([\u4e00-\u9fa5][\u4e00-\u9fa5·\u00B7A-Za-z0-9（）()]{1,20}).*?(\d{1,4})\s*(条|包|箱|件)?/);
  }
  if (!m) return null;
  const name = m[1].replace(/\s+/g, '').trim();
  const qty = Number(m[2]);
  if (!Number.isFinite(qty) || qty <= 0 || qty > 9999) return null;
  if (/^(卷烟|香烟|合计|总计|小计|备注|商品|项目|数量|金额|客户|送货|备注|单位|条|包|箱|件|单价)$/.test(name)) return null;
  const costM = line.match(/(?:[¥￥]\s*|单价\s*|进价\s*)?(\d{1,3}\.\d{1,2})\b/);
  return {
    cigarette_name: name,
    item_type: 'order',
    qty,
    unit_cost: costM ? Number(costM[1]) : null,
  };
}

function extractTiersAndItems(text: string, rewardType: RewardType, warnings: string[]): ParsedTobaccoTier[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const tierHeaderRe = /^(档位|层级|分档|档\d+|T\d+|基础档|高档|低档|起步档)/;
  const segments: { header: string; body: string[] }[] = [];
  let cur: { header: string; body: string[] } | null = null;
  for (const raw of lines) {
    if (!raw) continue;
    if (tierHeaderRe.test(raw) || /门槛\s*\d+\s*条/.test(raw) || /^\d{1,3}\s*条\s*[（(]/.test(raw)) {
      if (cur) segments.push(cur);
      cur = { header: raw, body: [] };
    } else if (cur) {
      cur.body.push(raw);
    }
  }
  if (cur) segments.push(cur);

  if (segments.length === 0) {
    const items = extractItemLines(text).map(parseItemLine).filter((x): x is ParsedTobaccoItem => !!x);
    dedupItemsInPlace(items);
    return [{
      tier_no: 'base',
      name: '基础档',
      threshold_qty: null,
      selection_type: 'fixed',
      reward_type: items.length > 0 ? rewardType : 'none',
      items,
    }];
  }

  const tiers: ParsedTobaccoTier[] = [];
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    const tierM = s.header.match(/(?:档位|档)\s*([A-Za-z0-9零一二三四五六七八九十]{1,4})/);
    const thrM = s.header.match(/(?:门槛|达到|满)\s*(\d{1,4})\s*条/);
    const tier_no = (tierM && tierM[1]) || `tier${i + 1}`;
    const items = extractItemLines(s.body.join('\n')).map(parseItemLine).filter((x): x is ParsedTobaccoItem => !!x);
    dedupItemsInPlace(items);
    tiers.push({
      tier_no: /^\d+$/.test(tier_no) ? `tier${tier_no}` : tier_no,
      name: s.header.length <= 20 ? s.header : `档位 ${i + 1}`,
      threshold_qty: thrM ? Number(thrM[1]) : null,
      selection_type: 'fixed',
      reward_type: items.length > 0 ? rewardType : 'none',
      items,
    });
  }

  if (tiers.every((t) => t.items.length === 0)) {
    warnings.push('未识别到任何明细卷烟，请人工补录');
  }
  return tiers;
}

function dedupItemsInPlace(items: ParsedTobaccoItem[]): void {
  const seen = new Set<string>();
  for (let i = items.length - 1; i >= 0; i--) {
    const k = `${items[i].cigarette_name}|${items[i].qty}|${items[i].item_type}`;
    if (seen.has(k)) items.splice(i, 1);
    else seen.add(k);
  }
}

export function parseTobaccoPlan(text: string, opts: { usedPlanNos?: ReadonlyArray<string> } = {}): ParsedTobaccoPlan {
  const warnings: string[] = [];
  const cleaned = (text || '').replace(/\r/g, '');
  const { period } = extractPeriod(cleaned);
  const name = extractPlanName(cleaned, period);
  const { rewardType, rewardPolicy } = extractRewardType(cleaned);
  const group_name = extractGroupName(cleaned);
  const tiers = extractTiersAndItems(cleaned, rewardType, warnings);
  return {
    plan_no: nextPlanNo(opts.usedPlanNos || []),
    name,
    period,
    group_name,
    reward_policy: rewardPolicy,
    tiers,
    warnings,
    rawText: cleaned,
  };
}
