// 进货单据 OCR 文本解析：把腾讯云/本地引擎返回的纯文本，提取为结构化进货单。
// 腾讯云 GeneralAccurateOCR 返回图片里所有文字行（\n 拼接），不含字段结构，
// 所以这里用正则 + 行匹配把「单据号 / 日期 / 供应商 / 金额 / 商品明细行」拆出来。
// 与移动端 mobile-app/src/utils/parsePurchaseBill.ts 逻辑保持一致，独立维护。
// 容错原则：识别不出的字段留空，交给用户在 UI 里核对修正，绝不臆造数据。

export interface BillItem {
  name: string;
  barcode?: string;
  unit?: string;
  quantity?: number;
  price?: number;
  amount?: number;
  discount?: number;
  suspect?: boolean;
}

export interface PurchaseBill {
  orderNo?: string;
  date?: string; // YYYY-MM-DD
  arrivalDate?: string; // YYYY-MM-DD
  supplierName?: string;
  category?: string;
  total?: number;
  /** 明细金额求和。与 total（票面合计）不一致时说明有漏行，供前端做核对提示 */
  itemsTotal?: number;
  paid?: number;
  discount?: number;
  unpaid?: number;
  note?: string;
  items: BillItem[];
  raw: string;
}

const NUM_RE = /-?\d+(?:,\d{3})*(?:\.\d+)?/;

function toNum(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const cleaned = v.replace(/[¥￥$\s]/g, '').replace(/,(?=\d{3}\b)/g, '');
  const m = cleaned.match(/-?\d+(?:\.\d+)?/);
  if (!m) return undefined;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : undefined;
}

function parseDate(line: string): string | undefined {
  const m =
    line.match(/(\d{4})[-./年](\d{1,2})[-./月](\d{1,2})/) ||
    line.match(/(\d{4})(\d{2})(\d{2})/) ||
    line.match(/(\d{2})年(\d{1,2})月(\d{1,2})日/);
  if (!m) return undefined;
  let y: string, mo: string, d: string;
  if (m[0].includes('年')) {
    // 「2026年08月16日」四位年直接用，「26年8月16日」两位年补世纪
    y = m[1].length === 4 ? m[1] : '20' + m[1];
    mo = m[2]; d = m[3];
  } else if (m[1].length === 4 && m[2].length === 2 && m[3].length === 2 && !line.includes('/')) {
    y = m[1]; mo = m[2]; d = m[3];
  } else {
    y = m[1].length === 2 ? '20' + m[1] : m[1];
    mo = m[2]; d = m[3];
  }
  const mm = mo.padStart(2, '0');
  const dd = d.padStart(2, '0');
  const yN = Number(y), moN = Number(mm), dN = Number(dd);
  if (yN < 2000 || yN > 2100 || moN < 1 || moN > 12 || dN < 1 || dN > 31) return undefined;
  return `${y}-${mm}-${dd}`;
}

// 单据编号后面若跟着客户名/店名/地址等，不能当作单号
const ORDER_NO_NOISE = /(百货|超市|商店|便利店|鸣凰|鸭凰|京东|天猫|原\(|客户|店\)|地址|电话|手机|收货|送货|订货)/;

function parseOrderNo(text: string, lines: string[]): string | undefined {
  const flatText = text.replace(/\r?\n+/g, ' ');

  // 优先匹配常见的「字母 日期-序号」空格分隔单号（如 XS 2026-08-16-70102）
  const spaced = flatText.match(/\b([A-Za-z]{1,4})\s+(\d{4}[-/]\d{2}[-/]\d{2}[-/]\d+)\b/);
  if (spaced) return `${spaced[1]}-${spaced[2]}`;

  const labelMatch = flatText.match(
    /(?:单据号|单据编号|编号|单号|订单号|订单编号|采购单号|送货单号|货单号|单\s*号)[:：]?\s*([A-Za-z0-9\-_/\s]{3,45})/i
  );
  if (labelMatch) {
    let v = labelMatch[1].trim();
    // 形如 "XS 2026-08-16-70102" 的空格分隔单号，归一化为 "XS-2026-08-16-70102"
    const spaced2 = v.match(/^([A-Za-z]{0,4})\s+(\d{4}(?:[-/]\d{2}){2}(?:[-/]\d+)?)$/);
    if (spaced2) return `${spaced2[1]}-${spaced2[2]}`;
    // 否则只取第一个连续 token，避免把下一行的日期粘连进来（如 "GW20260816003 2026年08月16日"）
    const first = v.split(/\s+/)[0];
    if (/^[A-Za-z0-9\-_/]+$/.test(first)) v = first;
    // 若解析出来的是客户/店名噪声或只有 2~3 个纯字母（如 LD），不要当作单号
    const looksLikeNoise = ORDER_NO_NOISE.test(v) || /^[A-Za-z]{1,3}$/.test(v);
    if (!looksLikeNoise) {
      if (/^[A-Za-z]+[-_/]?\d{4}[-_/]?$/.test(v)) {
        const nextLine = lines
          .slice(lines.findIndex((l) => l.includes(v)) + 1)
          .find((l) => /^\d{2}[-/]\d{2}[-/]\d{2,}[-/]?\d{0,}$/.test(l.trim()));
        if (nextLine) {
          return (v.replace(/[-/]$/, '') + '-' + nextLine.trim().replace(/^[-/]/, '')).replace(/-+/g, '-');
        }
      }
      return v;
    }
  }
  const m2 = flatText.match(/\b([A-Za-z]{1,4}[-_/\s]?\d{4,}[-_/\s]?\d{2,}[-_/\s]?\d{2,}[-_/\s]?\d{1,})/i);
  if (m2) return m2[1].replace(/\s+/g, '-');
  const m3 = flatText.match(/\b([A-Za-z]{1,4}[-_/\s]?\d{6,})/i);
  if (m3) return m3[1].replace(/\s+/g, '-');
  return undefined;
}

function stripSupplierNoise(name: string): string {
  // 单据头部常见营销/支付前缀（如"推荐使用微信支付XX商行销售单"）会污染供应商名
  const PAYMENT_PREFIXES = [
    '给荐使用微信支付',
    '推荐使用微信支付',
    '请使用微信支付',
    '欢迎使用微信支付',
    '使用微信支付',
    '微信支付',
    '支付宝',
    '云闪付',
    '银联支付',
    '扫码支付',
  ];
  for (const p of PAYMENT_PREFIXES) {
    const idx = name.indexOf(p);
    if (idx >= 0) {
      const after = name.slice(idx + p.length).trim().replace(/^[：:，,\s]+/, '');
      if (after) return after;
    }
  }
  // OCR 常把抬头/印章里的"中国"或残缺"国"字粘到公司名前；"AA" 是针式打印单顶部常见噪声
  // 页码（第1/4页）也常粘到供应商名前
  return name
    .replace(/^AA\s*/, '')
    .replace(/^中国\s*/, '')
    .replace(/^国\s*/, '')
    .replace(/^第\s*\d+\s*[\/]\s*\d+\s*页\s*/, '')
    .replace(/^第\s*\d+\s*页\s*/, '')
    .trim();
}

function parseSupplier(lines: string[]): string | undefined {
  const EXCLUDE = /(客户单位|客户|收货单位|收货人|送货地址|地址|电话|手机|联系方式)/;
  for (const l of lines) {
    if (EXCLUDE.test(l)) continue;
    const m = l.match(/(?:供应商|供货方|供方|供货单位|销货单位|送货单位|发货单位|出货单位)[:：]?\s*(.+)$/);
    if (m) {
      const v = stripSupplierNoise(m[1].trim()).replace(/[【】]/g, '').trim();
      if (v) return v;
    }
  }

  // 单据后缀；末尾裸"单"用负向后瞻排除"账单/名单/对账单/菜单"等误匹配
  const DOC_SUFFIX = /(?:销售单|购物清单|访销单|仿销单|送货单|销货单|出货单|发货单|批发单|供货单|配货单|销售清单|采购单|订单|清单|单据|(?<![账名对菜])单)$/;
  const BIZ_TAIL = /(专卖店|直销点|批发部|经营部|门市部|门市)$/;
  // 手写备注（如"欠原计支+34听"）绝不能混入供应商名
  const HANDWRITING = /(欠|\+|听|\*|×|x|X)/;
  // 页脚/合计/备注等行即使误匹配到"单"后缀，也绝不能当作供应商名
  const GARBAGE = /(数量|金额|备注|总计|合计|小计|页码|打印|时间|电话|地址|编号|单号|订单号|业务员|审单员|仓库|送货人|欠款人|公司地址|服务热线|投诉|开户|银行|账号|报单|制单)/;

  const tryExtractTitle = (t: string): string | undefined => {
    if (EXCLUDE.test(t) || HANDWRITING.test(t)) return undefined;
    const clean = t.replace(/[【】\[\]()（）]/g, '');
    if (DOC_SUFFIX.test(clean) && /[一-龥]/.test(clean)) {
      let name = clean.replace(DOC_SUFFIX, '').replace(BIZ_TAIL, '').trim();
      name = stripSupplierNoise(name);
      if (name && name.length >= 2 && name.length <= 30 && !GARBAGE.test(name) && !(name.length <= 3 && /^(批发|销售|送货|供货|发货|出货|零售|经销|代理)$/.test(name))) {
        return name;
      }
    }
    return undefined;
  };

  let best: string | undefined;
  for (let window = 3; window >= 2; window--) {
    for (let i = 0; i <= lines.length - window; i++) {
      const combined = lines.slice(i, i + window).join('').replace(/\s+/g, '').trim();
      const got = tryExtractTitle(combined);
      if (got && (!best || got.length > best.length)) best = got;
    }
  }
  for (const l of lines) {
    const got = tryExtractTitle(l.trim());
    if (got && (!best || got.length > best.length)) best = got;
  }
  if (best) return best;

  const hit = lines.find((l) => {
    if (EXCLUDE.test(l) || HANDWRITING.test(l)) return false;
    return /(公司|厂|商行|商贸|有限|批发)/.test(l) && l.length <= 30;
  });
  return hit ? stripSupplierNoise(hit.replace(/[【】]/g, '').trim()) : undefined;
}

function parseMoney(lines: string[], keyAliases: RegExp, maxLinesAfter = 3): number | undefined {
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!keyAliases.test(l)) continue;
    if (/数量|件数|笔数|条数|合计数/.test(l)) continue;
    for (let j = 0; j < maxLinesAfter && i + j < lines.length; j++) {
      const target = lines[i + j];
      const m = target.match(NUM_RE);
      if (m) {
        const n = toNum(m[0]);
        if (n != null && n > 0 && n < 100000) return n;
      }
    }
  }
  return undefined;
}

function parseTotal(lines: string[]): number | undefined {
  // 多页单据：优先取「页小计/本页小计」（每页真相），避免把最后一页的「总计」当成当前页合计
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/(页小计|本页小计)/.test(l)) {
      let maxDecimal: number | undefined;
      let maxInt: number | undefined;
      // 针式打印单「页小计」后面常有说明/地址/页脚，真实金额可能离得稍远；
      // 也可能金额在标签前面（OCR 列错位），所以前后各看 12 行。
      for (let j = -8; j <= 12; j++) {
        const idx = i + j;
        if (idx < 0 || idx >= lines.length) continue;
        const target = lines[idx];
        if (j > 0 && /(总计|合计|总金额|总额)/.test(target)) break; // 撞到下一级合计标签就停，防止越界
        // 同行金额：如 "385.2 元"
        const dm = target.match(/\b\d+\.\d+\b/);
        if (dm) {
          const n = toNum(dm[0]);
          if (n != null && n > 0 && n < 100000) {
            if (maxDecimal == null || n > maxDecimal) maxDecimal = n;
          }
        }
        const im = target.match(/\b\d+\b/);
        if (im) {
          const n = toNum(im[0]);
          if (n != null && n > 0 && n < 100000) {
            if (maxInt == null || n > maxInt) maxInt = n;
          }
        }
      }
      // 页小计金额通常带小数（如 385.2 / 555.00）；只取小数，避免把页脚电话号码 0519 等整数误当合计。
      if (maxDecimal != null) return maxDecimal;
    }
  }
  // 单页单据 fallback：优先"总计/合计"，在其后 3 行内取最大金额
  const totalHits: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/(总计|总金额|总额|合计|成交金额|应收金额|实收金额)/.test(l)) {
      for (let j = 1; j <= 3 && i + j < lines.length; j++) {
        const m = lines[i + j].match(NUM_RE);
        if (m) {
          const n = toNum(m[0]);
          if (n != null && n > 0 && n < 100000) totalHits.push(n);
        }
      }
    }
  }
  if (totalHits.length > 0) return Math.max(...totalHits);
  // 兜底：普通小计
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/(小计)/.test(l) && !/(页小计|本页小计)/.test(l)) {
      let maxDecimal: number | undefined;
      let maxInt: number | undefined;
      for (let j = 1; j <= 4 && i + j < lines.length; j++) {
        const target = lines[i + j];
        const dm = target.match(/\b\d+\.\d+\b/);
        if (dm) {
          const n = toNum(dm[0]);
          if (n != null && n > 0 && n < 100000) {
            if (maxDecimal == null || n > maxDecimal) maxDecimal = n;
          }
        }
        const im = target.match(/\b\d+\b/);
        if (im) {
          const n = toNum(im[0]);
          if (n != null && n > 0 && n < 100000) {
            if (maxInt == null || n > maxInt) maxInt = n;
          }
        }
      }
      if (maxDecimal != null) return maxDecimal;
      if (maxInt != null) return maxInt;
    }
  }
  return undefined;
}

// 条码候选：12 位 UPC-A / 13 位 EAN-13（最常见）。
// 中国 EAN-13 多 690-695 开头，进口可能 690-699/800-839，不做硬前缀限制（仅"包含"做合理性提示）。
// 仅用于"本行是否含条码"的快速检测；取值统一走 extractBarcode。

/**
 * 从单行（或整段）OCR 文本里抽取商品条码。
 * 规则：候选 12 位 UPC-A / 13 位 EAN-13；同一文本出现多个数字序列时，
 * 优先 13 位、其次 12 位（按长度倒序选最像条码者）。抽不到返回 ''（绝不臆造）。
 * PC / Mobile 两端共用同一规则，保持解析口径一致。
 */
export function extractBarcode(text: string): string {
  if (!text) return '';
  const matches = text.match(/\b\d{12,13}\b/g);
  if (!matches || matches.length === 0) return '';
  // 长度倒序：13 位优先于 12 位
  const sorted = [...matches].sort((a, b) => b.length - a.length);
  return sorted[0];
}
const COLUMN_HEADERS = /^(规格|建议零售价|零售价|单价|金额|总价|小计|数量|单位|件数|条码|商品条码|商品名称|品名|名称|货品|货名|产品名称|项目|序号|编号|备注|价格|条形码|商品条码)$/;
const NON_NAME_KEYWORDS = /(客户|地址|电话|单据编号|交易日期|总计|每页小计|送货热线|货物当面点清|货已收|客户签字|白单|红单|黄单|存根|请收货单位|本单据|备注|业务人员|请付给|谢谢配合|销售单|购物清单|访销单|送货单|销货单|出货单|发货单|批发单|供货单|配货单|销售清单|采购单|订单|清单|单据|欠|\+|听)/;
function isProductNameLine(line: string): boolean {
  const clean = line.replace(/[【】\[\]()（）\|｜]/g, '').trim();
  if (!clean) return false;
  if (COLUMN_HEADERS.test(clean)) return false;
  if (/^(每页小计|总计|合计|小计|价格|金额)$/.test(clean)) return false;
  if (/^\d+$/.test(clean)) return false;
  if (/^\d+\s*[*xX×]\s*\d+$/.test(clean)) return false;
  if (NON_NAME_KEYWORDS.test(clean)) return false;
  if (clean.length > 35) return false;
  if (/[:：]/.test(clean)) return false;
  const han = clean.match(/[一-龥]/g);
  if (!han || han.length < 2) return false;
  return true;
}

/** cleanName 的可信行上下文：用于前导噪声剥离的「保守门禁」。 */
export interface CleanNameCtx {
  barcode?: string;
  quantity?: number;
  amount?: number;
}

// 前导中文噪声剥离——总开关与阈值，便于线上一键回退：
// ① stripLeadingNoise=false 整体关闭；② leadingNoiseMaxChars 限制最多剥几个字。
const NAME_CLEAN_CFG = { stripLeadingNoise: true, leadingNoiseMaxChars: 3 };

// 观测到的「相邻列/表头串味」前导噪声词典（均为客户/收货人/店名等 bleed 片段，
// 不含任何真实品牌前缀，故命中即剥离、零误伤）。遇新型串味在此追加即可。
const LEADING_NOISE_PREFIXES = ['飞豪柒', '酈国洪'];

// 前导中文噪声：OCR 列式/相邻列串味时，商品名前部会粘上「客户/收货人/店名」等片段
// （如「飞豪柒精三鲜糯米锅巴」「酈国洪等你下课红和黄」）。剥离策略刻意保守：
//  · 仅在可信商品行（已抽到条码/数量/金额 任一）才尝试，低置信度行不动；
//  · 仅命中精确噪声词典才剥，绝不靠模糊规则猜，避免误删「蒙乐精三鲜…」等正常品名。
function stripLeadingNoise(name: string, ctx?: CleanNameCtx): string {
  if (!NAME_CLEAN_CFG.stripLeadingNoise || !name) return name;
  const wellFormed = !!(ctx && (ctx.barcode || ctx.quantity != null || ctx.amount != null));
  if (!wellFormed) return name;
  for (const p of LEADING_NOISE_PREFIXES) {
    if (p.length === 0 || p.length > NAME_CLEAN_CFG.leadingNoiseMaxChars) continue;
    if (name.startsWith(p) && name.length > p.length && /[一-龥]/.test(name.slice(p.length))) {
      return name.slice(p.length).replace(/^\s+/, '');
    }
  }
  return name;
}

function cleanName(name: string, ctx?: CleanNameCtx): string {
  let n = name
    .replace(/[【】\[\]()（）\|｜]/g, '')
    .replace(/\d+\s*[*xX×]\s*\d+/g, ' ')
    .replace(/^\d+\s*[.、]\s+/, ' ')
    // 单据上常见的「货号」前缀（如 E61、C46、B35）会粘到商品名里，剥离它。
    // 只处理「一个大写字母 + 2~3 位数字」这种典型编号，避免误伤 A2 奶粉等品牌名。
    .replace(/^\s*[A-Z]\d{2,3}\b\s*/g, '')
    // 商品名末尾被 OCR 粘上的孤立数字（如 "鸡蛋130" / "鹌鹑蛋124" / "123"），剥离。
    // 保留带单位的规格数字（58g/100g/500ml 等），它们不是孤立纯数字。
    .replace(/\s+\d{2,4}$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  n = stripLeadingNoise(n, ctx);
  return n.replace(/\s+/g, ' ').trim();
}

// 常见 OCR 丢字/单据简写修复：把「500m可口可乐」补成「500ml可口可乐」，「1.25可口可乐」补成「1.25升可口可乐」
function normalizeOcrName(name: string): string {
  let n = name;
  // 容量单位缺字：300m/330m/420m/450m/500m → ml
  n = n.replace(/\b(\d{3})m\b/g, '$1ml');
  // 1.25/1.8/2.0 后紧跟饮料品牌且没有单位时补「升」
  n = n.replace(/\b(1\.25|1\.8|2\.0|2)(可口可乐|果粒橙|芬达|美汁源|酷儿|雪碧|百事)(?![一-龥a-zA-Z0-9])/g, '$1升$2');
  // 保留 ml/L 与数字的粘连（如"500ml无糖"）
  n = n.replace(/\b(\d+(?:\.\d+)?)(ml|L|升)([一-龥])/g, '$1$2 $3');
  return n.replace(/\s+/g, ' ').trim();
}

// 口味/水果/颜色词：单独出现时可能是「500ml芬达[蜜桃]」被 OCR 拆散后的残片


// ─────────────────────────────────────────────────────────────────────────
// 供应商模糊匹配（从 @sucen/ocr-core 1.0.2 tgz 移植，保持与 PC 端行为一致）
// 用于 OCR 识别出的供应商名（可能为简称/关键字，如「亚昌冷饮」）与供应商库
// 全称（如「鸣凰亚昌批发冷饮」）做模糊匹配，命中则带出登记全称。
// ─────────────────────────────────────────────────────────────────────────
const NAME_NOISE_RE = /[\s（）()【】\[\]「」『』""''·、,，.。:：;；\-_/\\|｜*＊#＃]/g;
const NAME_SUFFIX_RE =
  /(有限责任公司|股份有限公司|分公司|公司|商行|商贸|贸易|批发部|经营部|门市部|专卖店|直销点|超市|便利店|百货)/g;
const SUPPLIER_INVALID_RE =
  /(合计|总计|小计|金额|数量|单价|备注|页码|地址|电话|日期|单号|编号|客户|送货人|业务员|制单|开户|银行|账号|谢谢|欢迎|热线)/;

function levenshtein(a: string, b: string): number {
  const s1 = Array.from(a || '');
  const s2 = Array.from(b || '');
  if (s1.length === 0) return s2.length;
  if (s2.length === 0) return s1.length;
  let long = s1;
  let short = s2;
  if (short.length > long.length) [long, short] = [short, long];
  let prev = new Array(short.length + 1);
  let curr = new Array(short.length + 1);
  for (let j = 0; j <= short.length; j++) prev[j] = j;
  for (let i = 1; i <= long.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= short.length; j++) {
      const cost = long[i - 1] === short[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[short.length];
}

function similarity(a: string, b: string): number {
  const s1 = (a || '').trim();
  const s2 = (b || '').trim();
  if (!s1 && !s2) return 1;
  if (!s1 || !s2) return 0;
  const maxLen = Math.max(Array.from(s1).length, Array.from(s2).length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(s1, s2) / maxLen;
}

function normalizeNameForCompare(name: string): string {
  return (name || '').replace(NAME_NOISE_RE, '').replace(NAME_SUFFIX_RE, '').trim();
}

function cleanDisplayName(name: string): string {
  return (name || '')
    .replace(/^[\s:：、,，.。\-_]+/, '')
    .replace(/[\s:：、,，]+$/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function charsAllCovered(shortStr: string, longStr: string): boolean {
  const s = shortStr || '';
  const l = longStr || '';
  if (!s || !l || s.length > l.length) return false;
  const pool = new Set(Array.from(l));
  return Array.from(s).every((ch) => pool.has(ch));
}

/**
 * 供应商模糊匹配：OCR 名与供应商库做模糊匹配，命中返回 { item, score }，否则 undefined。
 * 算法（与 @sucen/ocr-core 1.0.2 一致）：
 *   全等=1 > 双向包含(0.75+) > 字符全覆盖(0.75+) > 编辑距离相似度(similarity)。
 * 仅当 score >= threshold(默认 0.62) 才视为命中，避免低置信误带出供应商。
 */
export function matchSupplier<T>(
  ocrName: string,
  suppliers: T[],
  getName: (item: T) => string,
  threshold = 0.62
): { item: T; score: number } | undefined {
  const raw = cleanDisplayName(ocrName || '');
  if (!raw || suppliers.length === 0) return undefined;
  if (SUPPLIER_INVALID_RE.test(raw)) return undefined;
  const target = normalizeNameForCompare(raw);
  if (!target) return undefined;
  let best: { item: T; score: number } | undefined;
  for (const item of suppliers) {
    const candidate = normalizeNameForCompare(getName(item) || '');
    if (!candidate) continue;
    let score = 0;
    const minLen = Math.min(candidate.length, target.length);
    const maxLen = Math.max(candidate.length, target.length);
    if (candidate === target) {
      score = 1;
    } else if (candidate.includes(target) || target.includes(candidate)) {
      score = 0.75 + 0.2 * (minLen / maxLen);
    } else if (
      minLen >= 2 &&
      charsAllCovered(
        minLen === candidate.length ? candidate : target,
        minLen === candidate.length ? target : candidate
      )
    ) {
      score = 0.75 + 0.1 * (minLen / maxLen);
    } else {
      score = similarity(candidate, target);
    }
    if (score >= Math.max(threshold, 0) && (!best || score > best.score)) {
      best = { item, score };
    }
  }
  return best && best.score >= threshold ? best : undefined;
}


// 预扫描所有「每页小计/合计/总计」的金额，item 识别时排除这些页级数字

// 列式表格：OCR 把横向表格按列拆成每行一个单元格。
// 表头如「序号 商品编码 商品名称 单位 数量 单价 金额 条形码 辅助数量」，
// 数据按列依次输出。此函数识别这种结构并直接组合成商品。
const COLUMNAR_END_RE = /^(合计|总计|小计|制单|备注|送货|收货|页码|地址|电话|客户|业务员)/;

// 返回列式数据起始行（最后一个列名之后）以及是否识别到「单位」列。
// 识别到单位列时，parseColumnarGroup 会把该列独立成行的单位词映射到明细 unit。
function findColumnarDataStart(lines: string[]): { start: number; hasUnit: boolean } | null {
  // OCR 输出的表头可能是每个列名单词各占一行，不会在单行内。
  // 在 15 行窗口内同时出现多个列名关键词，即认为是列式表头。
  for (let i = 0; i < lines.length - 8; i++) {
    const window = lines.slice(i, Math.min(i + 15, lines.length)).map((l) => l.trim());
    const hasIdx = window.some((l) => l === '序号');
    const hasCode = window.some((l) => l === '商品编码');
    const hasName = window.some((l) => l === '商品名称');
    const hasUnit = window.some((l) => l === '单位');
    const hasQty = window.some((l) => l === '数量');
    const hasPrice = window.some((l) => l === '单价');
    const hasAmount = window.some((l) => l === '金额');
    const hasBarcode = window.some((l) => l === '条形码' || l === '条码');
    if (hasIdx && hasCode && hasName && hasUnit && hasQty && hasPrice && hasAmount && hasBarcode) {
      // 返回最后一个列名之后的行索引
      let lastHeaderIdx = i;
      for (let j = i; j < Math.min(i + 15, lines.length); j++) {
        if (COLUMN_HEADERS.test(lines[j].trim())) lastHeaderIdx = j;
      }
      return { start: lastHeaderIdx + 1, hasUnit };
    }
  }
  return null;
}

function parseColumnarGroup(group: string[], hasUnitCol = false): BillItem | null {
  const barcode = extractBarcode(group.join(' '));

  // 名称：含中文且不是单位/合计大写/页脚文字
  let name = '';
  for (const l of group) {
    const candidate = stripBarcodeFromName(l, barcode).replace(/[【】\[\]()（）\|｜]/g, '').trim();
    if (!candidate) continue;
    if (/元整|圆整|^(合计|总计|小计)$/.test(candidate)) continue;
    if (/^(箱|瓶|包|个|袋|盒|件|条|桶|提|只|听|罐|根)$/.test(candidate)) continue;
    if (!/[一-龥]{2,}/.test(candidate)) continue;
    if (COLUMN_HEADERS.test(candidate)) continue;
    const score = (candidate.match(/[一-龥]/g) || []).length;
    if (score >= 2 && (!name || score > (name.match(/[一-龥]/g) || []).length)) {
      name = candidate;
    }
  }
  name = normalizeOcrName(cleanName(name, { barcode }));
  if (!name) return null;

  // 数量与单位
  let quantity: number | undefined;
  let unit: string | undefined;
  for (const l of group) {
    const m = l.trim().match(UNIT_RE);
    if (m) {
      quantity = Number(m[1]);
      unit = m[2];
      break;
    }
  }

  // 单位列映射：列式单据里「单位」常单独成列（箱/瓶…），与数字不同行，
  // UNIT_RE 取不到。识别到单位列时，把组内独立成行的单位词映射到 unit，
  // 兼容非列式（UNIT_RE 已取到单位则跳过，不影响既有行为）。
  if (hasUnitCol && !unit) {
    for (const l of group) {
      const um = l.trim().match(/^(箱|瓶|包|个|袋|盒|件|条|桶|提|只|听|罐|根)$/);
      if (um) {
        unit = um[1];
        break;
      }
    }
  }

  // 数量列提取：列式单据「数量」紧跟「单位」列之后，常为裸整数（与序号不同行），
  // UNIT_RE 取不到。识别到单位列时，取单位单元格之后的第一个纯数字单元格作为数量。
  // 仅在区间列（hasUnitCol）且 UNIT_RE 未取到数量时生效，非列式行为不变。
  if (hasUnitCol && quantity == null) {
    const uIdx = group.findIndex((l) => /^(箱|瓶|包|个|袋|盒|件|条|桶|提|只|听|罐|根)$/.test(l.trim()));
    if (uIdx >= 0) {
      for (let k = uIdx + 1; k < group.length; k++) {
        const qm = group[k].trim().match(/^(\d+(?:\.\d+)?)$/);
        if (qm) {
          quantity = Number(qm[1]);
          break;
        }
      }
    }
  }

  // 金额与单价：组内所有两位小数数字；金额通常是最大者，单价是次大者。
  const decimals: number[] = [];
  for (const l of group) {
    const matches = l.match(/\b\d+\.\d{2}\b/g);
    if (matches) decimals.push(...matches.map(Number));
  }
  // 去重并排序
  const uniqueDecimals = Array.from(new Set(decimals.map((n) => Number(n.toFixed(2))))).sort((a, b) => a - b);
  let amount: number | undefined;
  let price: number | undefined;
  if (uniqueDecimals.length >= 2) {
    amount = uniqueDecimals[uniqueDecimals.length - 1];
    price = uniqueDecimals[uniqueDecimals.length - 2];
    // 校验：若 price * quantity 与 amount 偏差较大，可能是顺序反了
    if (quantity != null && Math.abs(price * quantity - amount) > 0.05) {
      // 尝试找到能匹配的组合
      let best: { a: number; p: number } | null = null;
      for (let i = 0; i < uniqueDecimals.length; i++) {
        for (let j = 0; j < uniqueDecimals.length; j++) {
          if (i === j) continue;
          const a = uniqueDecimals[i];
          const p = uniqueDecimals[j];
          if (Math.abs(p * quantity - a) < 0.01) {
            if (!best || a > best.a) best = { a, p };
          }
        }
      }
      if (best) {
        amount = best.a;
        price = best.p;
      }
    }
  } else if (uniqueDecimals.length === 1) {
    amount = uniqueDecimals[0];
    if (quantity) price = Number((amount / quantity).toFixed(4));
  }

  // 整数金额兜底（如 27/30/45）
  if (amount == null) {
    const ints = group
      .flatMap((l) => (l.match(/\b\d+\b/g) || []).map(Number))
      .filter((n) => n > 0 && n < 100000 && n !== Number(barcode));
    const uniqueInts = Array.from(new Set(ints)).sort((a, b) => a - b);
    if (uniqueInts.length > 0) {
      amount = uniqueInts[uniqueInts.length - 1];
      if (quantity) price = Number((amount / quantity).toFixed(4));
    }
  }

  return { name, barcode: barcode || '', unit, quantity, price, amount };
}

function tryParseColumnarTable(lines: string[]): BillItem[] | null {
  const found = findColumnarDataStart(lines);
  if (!found || found.start < 0) return null;
  const dataStart = found.start;
  const hasUnitCol = found.hasUnit;

  const items: BillItem[] = [];
  let i = dataStart;
  // 序号连续性判定：真实单据的序号严格递增（1,2,3…），而数量多为裸整数（2/6/12…）。
  // 旧逻辑用 /^\\d{1,3}$/ 把每个裸整数都当序号 → 数量被误判为新组起点，截断分组、丢行丢条码。
  // 现改为：维护 expectedSeq，仅当裸整数 n === expectedSeq 且位于组首/组边界时才判为序号，
  // 否则归入当前组（视作数量等），不再开新组。序号跳号/重复按非序号处理（保守）。
  let expectedSeq = 1;
  let group: string[] = []; // 当前正在归并的商品组（含其序号行）

  const flush = () => {
    if (group.length > 0) {
      const item = parseColumnarGroup(group.map((l) => l.trim()).filter(Boolean), hasUnitCol);
      if (item) items.push(item);
      group = [];
    }
  };

  while (i < lines.length) {
    const line = lines[i].trim();
    if (!line) {
      i++;
      continue;
    }
    // 表头残留 / 结束标记：截断当前组，不视为新序号
    if (COLUMN_HEADERS.test(line) || COLUMNAR_END_RE.test(line)) {
      flush();
      i++;
      continue;
    }

    const seqM = line.match(/^(\d{1,3})$/);
    if (seqM) {
      const n = Number(seqM[1]);
      if (group.length === 0) {
        // 首个裸整数 = 本表第一个序号（不一定从 1 开始），据此播种 expectedSeq
        group = [line];
        expectedSeq = n + 1;
        i++;
        continue;
      }
      if (n === expectedSeq) {
        // 序号连续性命中：结束上一组，开启新组
        flush();
        group = [line];
        expectedSeq = n + 1;
        i++;
        continue;
      }
      // 不匹配连续性 → 视作数量等数值单元格，归入当前组，不再开新组
      group.push(line);
      i++;
      continue;
    }

    // 其它单元格（编码/名称/单位/金额/条码…）归入当前组
    group.push(line);
    i++;
  }
  flush();

  return items.length > 0 ? items.slice(0, 50) : null;
}


// 页脚/合计/页码类行：里面的数字绝不能当成商品金额或数量

// 判断两位小数金额是否被中文粘连（如"1.25可口可乐"里的 1.25 不是金额）

const UNIT_RE = /^(\d+(?:\.\d+)?)\s*(箱|瓶|包|个|袋|盒|件|条|桶|提|只|听|罐|根)$/;

// 组合表头行（如「条码 商品名称 数量 单价 金额」）：整行都是列名，绝不能当商品名

/**
 * 横向表格的「整行商品」解析：一行里同时含条码、名称和尾部数字列。
 * 例：`1 6901028089296 中南海(细支) 5 12.00 60.00`
 * 返回 null 表示该行不是整行商品，应交给竖排算法按行区间分配。
 */
function parseInlineRow(
  line: string,
  barcode: string | undefined
): { name: string; quantity?: number; price?: number; amount?: number; unit?: string } | null {
  let rest = line;
  if (barcode) rest = rest.split(barcode).join(' ');
  rest = rest.replace(/^\s*\d{1,3}\s+/, ' '); // 行首序号
  const tokens = rest.split(/\s+/).filter(Boolean);
  if (tokens.length < 2) return null;

  // 从尾部往前收集「纯数字」或「数字+单位」token
  const tail: { value: number; unit?: string }[] = [];
  let end = tokens.length;
  while (end > 0) {
    const t = tokens[end - 1];
    if (/^-?\d+(?:\.\d+)?$/.test(t)) {
      tail.unshift({ value: Number(t) });
      end--;
      continue;
    }
    const um = t.match(UNIT_RE);
    if (um) {
      tail.unshift({ value: Number(um[1]), unit: um[2] });
      end--;
      continue;
    }
    break;
  }
  if (tail.length < 2) return null;

  const name = tokens.slice(0, end).join(' ').trim();
  if (!name || !/[一-龥]{2,}/.test(name)) return null;

  const unit = tail.find((t) => t.unit)?.unit;
  const nums = tail.map((t) => t.value);
  const amount = nums[nums.length - 1];
  let quantity: number | undefined;
  let price: number | undefined;
  if (nums.length >= 3) {
    // 常见列序：数量 单价 金额；校验 q*p≈a，不成立则退回「首数字为数量」
    const [q, p] = [nums[nums.length - 3], nums[nums.length - 2]];
    if (Math.abs(q * p - amount) < 0.02) {
      quantity = q;
      price = p;
    } else {
      quantity = nums[0];
      price = quantity > 0 ? Number((amount / quantity).toFixed(4)) : undefined;
    }
  } else {
    // 只有两个数字：前者当数量，单价反推
    quantity = nums[0];
    price = quantity > 0 ? Number((amount / quantity).toFixed(4)) : undefined;
  }
  return { name, quantity, price, amount, unit };
}

function mergeColumnarTable(lines: string[]): string[] {
  // 旧版拆列合并仍保留：当 OCR 输出是典型横向/单列条码时继续可用
  const barcodeIdxs: number[] = [];
  lines.forEach((l, i) => {
    if (extractBarcode(l) !== '') barcodeIdxs.push(i);
  });
  if (barcodeIdxs.length < 2) return [];
  const gaps = barcodeIdxs.slice(1).map((v, i) => v - barcodeIdxs[i]);
  const avgGap = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  if (avgGap < 2) return [];
  const COLUMN_HEADERS_OLD = /^(规格|建议零售价|零售价|单价|金额|总价|小计|数量|单位|件数|条码|商品条码|商品名称|品名|名称|货品|货名|产品名称|项目|序号|编号|备注|价格|条形码)$/;
  const TOTAL_HEADERS_OLD = /^(合计|小计|总计|成交|金额|数量|件数|供应商|客户|地址|电话|送货|打印|开单|报单|制单|时间|日期|单号|编号)/;
  const rows: string[] = [];
  for (let k = 0; k < barcodeIdxs.length; k++) {
    const idx = barcodeIdxs[k];
    const nextBarcodeIdx = barcodeIdxs[k + 1] ?? lines.length;
    let start = idx;
    if (idx > 0) {
      const prev = lines[idx - 1].trim();
      const isNameLine = /[一-龥]{2,}/.test(prev) && !/^[¥￥$\s\d,.\-xX×]+$/.test(prev);
      if (prev && isNameLine && !COLUMN_HEADERS_OLD.test(prev) && !TOTAL_HEADERS_OLD.test(prev)) start = idx - 1;
    }
    let end = idx;
    for (let i = idx + 1; i < nextBarcodeIdx && i <= idx + 6; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      if (COLUMN_HEADERS_OLD.test(line) || TOTAL_HEADERS_OLD.test(line)) break;
      if (/[一-龥]{2,}/.test(line) && !/(箱|瓶|包|个|袋|盒|件|条|桶|提|只|ml|L|kg|g|毫升|升|克)/i.test(line)) break;
      end = i;
    }
    const parts: string[] = [];
    for (let i = start; i <= end; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      if (COLUMN_HEADERS_OLD.test(line) || TOTAL_HEADERS_OLD.test(line)) continue;
      parts.push(line);
    }
    if (parts.length > 0) rows.push(parts.join(' '));
  }
  return rows;
}

function stripBarcodeFromName(line: string, barcode?: string): string {
  let n = line;
  if (barcode) n = n.split(barcode).join(' ');
  n = n.replace(/\b\d{12,13}\b/g, ' ');
  // 也去掉 OCR 截断产生的 8~11 位残缺条码（通常后面紧跟着货号/名称）
  n = n.replace(/\b\d{8,11}\b(?=\s+(?:[A-Z]\d{2,3}|[一-龥]))/g, ' ');
  // 去掉 OCR 常见的悬空左/右括号（如 "...豆腩(微辣味" → "...豆腩微辣味"）
  n = n.replace(/[（()）]/g, '');
  return n;
}

function splitStuckBarcode(text: string): { barcode: string; name: string } | null {
  // 真实针式打印单：条码常与名称粘连成 14~18 位长数字串（如 "6906151624079500ml牛栏山..."）。
  // 确定性拆分：在任一数字串里枚举「行号前缀 L∈{0,1,2} + 13 位窗口」，取以 '69' 开头的窗口为条码，
  // 剩余部分(含名称)作为名称候选。中国 EAN-13 必以 69 开头，该约束已足够唯一。
  const runs = Array.from(text.matchAll(/\d+/g));
  for (const m of runs) {
    const runStr = m[0];
    if (runStr.length < 13) continue;
    for (let L = 0; L <= runStr.length - 13; L++) {
      const w = runStr.slice(L, L + 13);
      if (w[0] !== '6' || w[1] !== '9') continue;
      const start = m.index ?? 0;
      const before = text.slice(0, start);
      const after = text.slice(start + runStr.length);
      let beforeClean = before;
      // 行号单独成行、或与条码同行(如 "10 690...")：条码前的纯数字行号去掉，名称里的数字保留
      if (!/[一-龥]/.test(beforeClean)) beforeClean = beforeClean.replace(/^\d{1,2}\s+/, '');
      const afterDigits = runStr.slice(L + 13);
      const name = (beforeClean + afterDigits + after).trim();
      return { barcode: w, name };
    }
  }
  return null;
}

function parseItems(lines: string[]): BillItem[] {
  // 真实针式销售单：表格被拆成碎片行。以「条码」为锚点，把后续碎片(规格/数量/单价/优惠/金额/名称续行)
  // 归并到最近锚点，直到下一个锚点。无锚点时退回列式/兜底解析，保证旧版式不退化。
  const columnar = tryParseColumnarTable(lines);
  if (columnar && columnar.length > 0) return columnar;

  const anchors: { idx: number; barcode: string; name: string }[] = [];
  lines.forEach((l, i) => {
    const s = splitStuckBarcode(l);
    if (s) anchors.push({ idx: i, barcode: s.barcode, name: s.name });
  });
  if (anchors.length === 0) return parseItemsFallback(lines);

  const items: BillItem[] = [];
  let gapNames: string[] = []; // 上一锚点已闭合、却出现在条码行之前的纯名称行，留给下一锚点

  for (let k = 0; k < anchors.length; k++) {
    const a = anchors[k];
    const nextIdx = k + 1 < anchors.length ? anchors[k + 1].idx : lines.length;
    const block = lines.slice(a.idx + 1, nextIdx);

    // 单行整行商品(名称+数量+单价同在锚点行)：交给行内解析，不参与竖排归并
    const inline = parseInlineRow(lines[a.idx], a.barcode);
    if (inline && inline.name) {
      items.push({
        name: normalizeOcrName(cleanName(inline.name)),
        barcode: a.barcode,
        unit: inline.unit,
        quantity: inline.quantity,
        price: inline.price,
        amount: inline.amount,
      });
      gapNames = [];
      continue;
    }

    let qty: number | undefined;
    let unit: string | undefined;
    const decimals: { v: number; i: number }[] = [];
    let gift = false;
    const nameFrags: string[] = [];
    const trailingNames: string[] = [];
    let closed = false;

    for (let bi = 0; bi < block.length; bi++) {
      const line = block[bi].trim();
      if (!line) continue;
      if (/赠品|赠送|搭赠| Free |FREE/.test(line)) {
        gift = true;
        closed = true;
        continue;
      }
      // 数量+单位(精确 "N箱")
      const um = line.match(UNIT_RE);
      if (um && qty === undefined) {
        qty = Number(um[1]);
        unit = um[2];
        continue;
      }
      // 数量行粘连 "N箱 单价 优惠"
      const qpd = line.match(/^(\d+)\s*(箱|瓶|包|个|袋|盒|件|条|桶|提|只|听|罐|根)\s*(\d+\.\d{1,2})\s+(\d+\.\d{1,2})$/);
      if (qpd) {
        if (qty === undefined) {
          qty = Number(qpd[1]);
          unit = qpd[2];
        }
        decimals.push({ v: Number(qpd[3]), i: a.idx + 1 + bi });
        decimals.push({ v: Number(qpd[4]), i: a.idx + 1 + bi });
        continue;
      }
      // "数量 单价 金额" 竖排(测试样本)
      const npa = line.match(/^(\d+)\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)$/);
      if (npa) {
        if (qty === undefined) qty = Number(npa[1]);
        decimals.push({ v: Number(npa[2]), i: a.idx + 1 + bi });
        decimals.push({ v: Number(npa[3]), i: a.idx + 1 + bi });
        continue;
      }
      // 纯数字行(金额/单价/两段粘连 "9.500.02")
      const allDec = line.match(/\d+\.\d{1,2}/g);
      if (allDec && /^[¥￥$\s\d.,]+$/.test(line) && !/(箱|瓶|包|个|袋|盒|件|条|桶|提|只|听|罐|根)/.test(line)) {
        for (const d of allDec) decimals.push({ v: Number(d), i: a.idx + 1 + bi });
        continue;
      }
      // 规格行 "1*12"
      if (/^\d+\s*[.*xX×]\s*\d+$/.test(line)) continue;
      // 名称续行：上一锚点已闭合、且本行紧贴下一锚点 → 留给下一锚点
      if (isProductNameLine(line)) {
        if (closed && nextIdx - (a.idx + 1 + bi) <= 1) trailingNames.push(line);
        else nameFrags.push(line);
        continue;
      }
      // 其余含数字的行，尽力抽取小数(如 "名称 57.00")
      if (allDec) {
        for (const d of allDec) decimals.push({ v: Number(d), i: a.idx + 1 + bi });
      }
    }

    // 优惠：归并块中 >0 且 <1 的最小小数(典型 0.01~0.19)
    const discountCandidates = decimals.filter((d) => d.v > 0 && d.v < 1);
    let discount: number | undefined;
    if (discountCandidates.length > 0) {
      discount = discountCandidates.map((d) => d.v).sort((x, y) => x - y)[0];
    }
    const valueDecimals = decimals.filter((d) => !(discount != null && Math.abs(d.v - discount) < 1e-9));
    let price: number | undefined;
    let amount: number | undefined;
    if (valueDecimals.length > 0) {
      valueDecimals.sort((x, y) => x.i - y.i);
      amount = valueDecimals[valueDecimals.length - 1].v;
      price = valueDecimals[0].v;
      if (valueDecimals.length === 1) amount = price = valueDecimals[0].v;
    }

    // 赠品 / 金额为 0：单价金额归零
    if (gift || (amount === 0 && price === 0)) {
      price = 0;
      amount = 0;
    }

    // 名称：gap(条码前的纯名称) + 锚点行名称 + 名称续行
    let name = [gapNames.join(' '), a.name, nameFrags.join(' '), trailingNames.join(' ')]
      .filter((s) => s && s.trim())
      .join(' ')
      .trim();
    name = normalizeOcrName(cleanName(name));

    // 校验：|数量×单价−优惠−金额| > 0.5 → 反推单价，仍不符则标 suspect
    let suspect = false;
    if (qty != null && qty !== 0 && price != null && amount != null) {
      const diff = Math.abs(qty * price - (discount ?? 0) - amount);
      if (diff > 0.5) {
        if (discount != null) {
          const rp = Math.round(((amount + discount) / qty) * 100) / 100;
          if (rp > 0) price = rp;
          suspect = Math.abs(qty * price - discount - amount) > 0.5;
        } else {
          suspect = true;
        }
      }
    }

    const item: BillItem = {
      name,
      barcode: a.barcode,
      unit,
      quantity: qty,
      price,
      amount,
    };
    if (discount != null && discount > 0) item.discount = discount;
    if (suspect) item.suspect = true;
    items.push(item);

    gapNames = trailingNames.slice();
  }

  return items.length > 0 ? items.slice(0, 50) : parseItemsFallback(lines);
}

function parseItemsFallback(lines: string[]): BillItem[] {
  const items: BillItem[] = [];
  const merged = mergeColumnarTable(lines);
  const source = merged.length > 0 ? merged : lines;
  const skip = /(合计|小计|总计|优惠|折扣|实收|应收|找零|现金|微信|支付宝|总计金额|页|供应商|电话|地址|日期|单号|总金额|打款|已付|未付|价税|税额|税率|销售单|购物清单|访销单|单据|订单|打印|开单|报单|成交|时间|编号|采购|送货|发货|出货|清单|建议零售价|备注)$/;
  const COLUMN_HEADERS_FALLBACK = /^(规格|建议零售价|零售价|单价|金额|总价|小计|数量|单位|件数|条码|商品条码|商品名称|品名|名称|货品|货名|产品名称|项目|序号|编号|备注|价格|条形码)$/;
  const UNIT_WORD = /(箱|瓶|包|个|袋|盒|件|条|桶|提|只|盒装|瓶装|袋装|份|kg|KG|克|g|毫升|ml|ML|升|L)/;

  const isValueLine = (line: string): boolean => {
    if (skip.test(line)) return false;
    const han = line.match(/[一-龥]{2,}/);
    if (han) return false;
    const nums = line.match(/-?\d+(?:\.\d+)?/g);
    if (!nums || nums.length === 0) return false;
    return UNIT_WORD.test(line) || /^[¥￥$\s\d.,+-]+$/.test(line);
  };

  const fillValue = (raw: string, pending: BillItem): void => {
    const line = raw.replace(/[|｜]/g, ' ').trim();
    const nums = (line.match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
    const bar = extractBarcode(line);
    if (bar && !pending.barcode) pending.barcode = bar;
    if (nums.length === 0) return;
    if (UNIT_WORD.test(line) && pending.quantity === undefined) {
      pending.quantity = nums[0];
      return;
    }
    if (pending.price === undefined) {
      pending.price = nums[0];
    } else if (pending.amount === undefined) {
      pending.amount = nums[0];
    } else {
      pending.amount = nums[nums.length - 1];
    }
  };

  const headerIdx = source.findIndex(
    (l) => /(商品名称|品名|货物名称|商品|项目名称|货物明细|货品|货名|产品名称|名称)/.test(l)
  );
  if (headerIdx < 0) {
    for (const raw of source) {
      const line = raw.replace(/[|｜]/g, ' ').trim();
      if (!line || skip.test(line)) continue;
      const noNumNoSym = line.replace(/[0-9.,\s*【】\[\]()（）xX×\-a-zA-Z]/g, '');
      if (COLUMN_HEADERS_FALLBACK.test(noNumNoSym)) continue;

      let working = line;
      const barcodeMatch = extractBarcode(working);
      if (barcodeMatch) working = working.replace(barcodeMatch, ' ');
      working = working.replace(/^\d+\s*[.、]?\s+/, ' ');

      const c1 = working.match(/(\d+(?:\.\d+)?[a-zA-Z]*[一-龥]{2,})/);
      const c2 = working.match(/([一-龥]{2,})/);
      let name: string | undefined;
      let nameRaw: string | undefined;
      for (const cand of [c1, c2]) {
        if (!cand) continue;
        const candidate = cand[1];
        if (!COLUMN_HEADERS_FALLBACK.test(candidate) && !/^\d+$/.test(candidate)) {
          name = candidate;
          nameRaw = cand[0];
          break;
        }
      }
      if (!name || !nameRaw) continue;
      if (!/^\d/.test(name)) {
        name = name.replace(/(桶装|瓶装|盒装|袋装|箱装|听装|罐装|罐|箱|瓶|包|个|袋|盒|件|条|桶|提|只)$/, '');
      }
      if (!name) continue;
      working = working.replace(nameRaw, ' ');
      working = working
        .replace(/\d+\s*(?:ml|ML|mL|L|l|kg|KG|g|G|克|毫升|升)\s*(?:\*\s*\d+)?/g, ' ')
        .replace(/\d+\s*[-*xX×]\s*\d+/g, ' ');

      let nums = (working.match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
      const it: BillItem = { name, barcode: '' };
      if (barcodeMatch) {
        it.barcode = barcodeMatch;
        const bcNum = Number(barcodeMatch);
        nums = nums.filter((n) => n !== bcNum);
      }

      const qMatch = working.match(/(\d+(?:\.\d+)?)\s*(箱|瓶|包|个|袋|盒|件|条|桶|提|只)/);
      if (qMatch) {
        it.quantity = Number(qMatch[1]);
        const qIdx = nums.indexOf(it.quantity);
        if (qIdx >= 0) nums.splice(qIdx, 1);
      }

      if (nums.length >= 3 && it.quantity === undefined) {
        const candidates = nums.slice(0, 3);
        let found = false;
        for (let ai = 0; ai < candidates.length && !found; ai++) {
          for (let bi = 0; bi < candidates.length && !found; bi++) {
            if (ai === bi) continue;
            const a = candidates[ai];
            const b = candidates[bi];
            const product = a * b;
            const pi = candidates.findIndex((n) => Math.abs(n - product) < 0.01);
            if (pi >= 0 && pi !== ai && pi !== bi) {
              it.amount = candidates[pi];
              it.quantity = a < b ? a : b;
              it.price = a < b ? b : a;
              found = true;
            }
          }
        }
        if (!found) {
          it.quantity = nums[0];
          it.price = nums[1];
          it.amount = nums[nums.length - 1];
        }
      } else if (nums.length >= 2) {
        if (it.quantity === undefined) it.quantity = nums[0];
        it.price = nums[0];
        it.amount = nums[nums.length - 1];
      } else if (nums.length === 1) {
        if (it.quantity === undefined) it.quantity = nums[0];
        else it.price = nums[0];
      }

      if (it.amount != null && it.quantity != null && it.price == null && it.quantity !== 0) {
        it.price = Number((it.amount / it.quantity).toFixed(4));
      } else if (it.price != null && it.quantity != null && it.amount == null) {
        it.amount = Number((it.price * it.quantity).toFixed(4));
      }

      items.push(it);
    }
    return items.slice(0, 50);
  }

  let pending: BillItem | null = null;
  const flush = () => {
    if (pending && pending.name) {
      if (pending.amount != null && pending.quantity != null && pending.price == null && pending.quantity !== 0) {
        pending.price = Number((pending.amount / pending.quantity).toFixed(4));
      } else if (pending.price != null && pending.quantity != null && pending.amount == null) {
        pending.amount = Number((pending.price * pending.quantity).toFixed(4));
      }
      items.push(pending);
    }
    pending = null;
  };
  for (let i = headerIdx + 1; i < source.length; i++) {
    const raw = source[i];
    if (skip.test(raw)) break;
    const noNumNoSym = raw.replace(/[0-9.,\s*【】\[\]()（）xX×\-a-zA-Z]/g, '');
    if (COLUMN_HEADERS_FALLBACK.test(noNumNoSym)) continue;
    const han = raw.match(/[一-龥]{2,}/);
    if (han && !/^[¥￥$\s\d.,+-]+$/.test(raw)) {
      const nameMatch = raw.match(/^(\d+(?:\.\d+)?[a-zA-Z]*[一-龥]{2,})/) || raw.match(/^([一-龥]+)/);
      let name = nameMatch ? nameMatch[1] : '';
      name = name.replace(/(桶装|瓶装|盒装|袋装|箱装|听装|罐装|罐|箱|瓶|包|个|袋|盒|件|条|桶|提|只)$/, '');
      if (name && /[一-龥]/.test(name)) {
        flush();
        pending = { name, barcode: '', quantity: undefined, price: undefined, amount: undefined };
        const valPart = raw
          .replace(name, ' ')
          .replace(/\d+\s*(?:ml|ML|mL|L|l|kg|KG|g|G|克|毫升|升)\s*(?:\*\s*\d+)?/g, ' ')
          .replace(/[-*xX×]\s*\d+/g, ' ');
        const restNums = (valPart.match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
        if (restNums.length > 0) {
          if (UNIT_WORD.test(raw) && pending.quantity === undefined) {
            const qMatch = raw.match(/(\d+(?:\.\d+)?)\s*(?:箱|瓶|包|个|袋|盒|件|条|桶|提|只)/);
            pending.quantity = qMatch ? Number(qMatch[1]) : restNums.shift();
          }
          if (pending.price === undefined && restNums.length > 0) pending.price = restNums.shift();
          if (pending.amount === undefined && restNums.length > 0) pending.amount = restNums.shift();
        }
      }
      continue;
    }
    if (pending && isValueLine(raw)) {
      fillValue(raw, pending);
    }
  }
  flush();
  return items.slice(0, 50);
}

export function parsePurchaseBill(raw: string): PurchaseBill {
  const text = (raw || '').trim();
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  const orderNo = parseOrderNo(text, lines);
  const date = parseDate(lines.find((l) => /(日期|时间|下单|开单|送货|打印|报单|制单)/.test(l)) || '') || parseDate(text);
  const arrivalDate = parseDate(lines.find((l) => /(送货|到货|交付)/.test(l)) || '');
  const supplierName = parseSupplier(lines);
  const items = parseItems(lines);
  const itemTotal = items.reduce((s, it) => s + (it.amount || 0), 0);
  // 票面「合计/总计」优先：它是凭证上的真相。明细求和只在票面无合计时兜底。
  // 两者同时存在且不一致时，说明拍照有漏行/漏列，itemsTotal 交给前端做核对提示。
  const billTotal = parseTotal(lines);
  const total = billTotal != null ? billTotal : itemTotal > 0 ? itemTotal : undefined;
  const itemsTotal = itemTotal > 0 ? Number(itemTotal.toFixed(2)) : undefined;
  const paid = parseMoney(lines, /(打款|已付|实付|已付金额|付款金额|收款金额|现金|微信|支付宝)/);
  const discount = parseMoney(lines, /(优惠|折扣|减免|让利)/);
  const unpaid = parseMoney(lines, /(未付|欠付|余款|尚欠)/);

  return { orderNo, date, arrivalDate, supplierName, total, itemsTotal, paid, discount, unpaid, items, raw: text };
}
