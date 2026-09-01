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

const BARCODE_RE = /\b(\d{12,14})(?:箱|瓶|包|个|袋|盒|件|条|桶|提|只|听|罐)?(?!\d)/;
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

function cleanName(name: string): string {
  return name
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
const FLAVOR_WORDS = /^(蜜桃|葡萄|西瓜|橙汁|苹果|橙味|葡萄味|西瓜味|蜜桃味|无糖|香草味|原味|柠檬味|橙味)$/;

function scoreName(line: string): number {
  const clean = line.replace(/[【】\[\]()（）\|｜]/g, '').trim();
  if (!isProductNameLine(line)) return -1;
  const base = (clean.match(/[一-龥]/g) || []).length;
  // 单独口味词得分降低，避免把「蜜桃」「葡萄」等残片当成完整商品名
  if (FLAVOR_WORDS.test(clean)) return Math.max(0, base - 3);
  return base;
}

// 预扫描所有「每页小计/合计/总计」的金额，item 识别时排除这些页级数字
const TOTAL_LABEL_RE = /(每页小计|本页小计|合计|总计|总金额|总额|成交)/;
const PURE_MONEY_LINE_RE = /^[¥￥$]?\s*-?\d+(?:,\d{3})*(?:\.\d+)?\s*(?:元)?$/;

// 列式表格：OCR 把横向表格按列拆成每行一个单元格。
// 表头如「序号 商品编码 商品名称 单位 数量 单价 金额 条形码 辅助数量」，
// 数据按列依次输出。此函数识别这种结构并直接组合成商品。
const COLUMNAR_END_RE = /^(合计|总计|小计|制单|备注|送货|收货|页码|地址|电话|客户|业务员)/;

function findColumnarDataStart(lines: string[]): number {
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
      return lastHeaderIdx + 1;
    }
  }
  return -1;
}

function parseColumnarGroup(group: string[]): BillItem | null {
  const barcodeLine = group.find((l) => BARCODE_RE.test(l));
  const barcodeMatch = barcodeLine?.match(BARCODE_RE);
  const barcode = barcodeMatch ? barcodeMatch[1] : undefined;

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
  name = normalizeOcrName(cleanName(name));
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

  return { name, barcode, unit, quantity, price, amount };
}

function tryParseColumnarTable(lines: string[]): BillItem[] | null {
  const dataStart = findColumnarDataStart(lines);
  if (dataStart < 0) return null;

  const items: BillItem[] = [];
  let i = dataStart;
  while (i < lines.length) {
    const line = lines[i].trim();
    if (!line || COLUMN_HEADERS.test(line) || COLUMNAR_END_RE.test(line)) {
      i++;
      continue;
    }
    // 商品记录以序号（纯小数字）开头；遇到下一行是另一个序号或结束标记时截断
    if (/^\d{1,3}$/.test(line)) {
      const start = i;
      let end = i + 1;
      while (end < lines.length) {
        const next = lines[end].trim();
        if (!next) {
          end++;
          continue;
        }
        if (/^\d{1,3}$/.test(next)) break;
        if (COLUMNAR_END_RE.test(next)) break;
        end++;
      }
      const group = lines.slice(start, end).map((l) => l.trim()).filter(Boolean);
      const item = parseColumnarGroup(group);
      if (item) items.push(item);
      i = end;
    } else {
      i++;
    }
  }
  return items.length > 0 ? items.slice(0, 50) : null;
}

function findExcludedTotals(lines: string[]): Set<number> {
  const set = new Set<number>();
  const collect = (s: string): boolean => {
    const matches = s.match(/-?\d+(?:,\d{3})*(?:\.\d+)?/g);
    if (!matches) return false;
    let got = false;
    for (const m of matches) {
      const n = toNum(m);
      if (n != null && n > 0) {
        set.add(Number(n.toFixed(2)));
        got = true;
      }
    }
    return got;
  };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!TOTAL_LABEL_RE.test(l)) continue;
    // 「合计 190.20」同行的情况
    if (collect(l)) continue;
    // OCR 竖排单据常把「合计」标签与金额拆成上下两行，向后最多看 6 行补齐
    for (let j = i + 1; j < lines.length && j <= i + 6; j++) {
      const nxt = lines[j].trim();
      if (!nxt) continue;
      if (BARCODE_RE.test(nxt)) break; // 已进入下一个商品，停
      if (TOTAL_LABEL_RE.test(nxt)) {
        collect(nxt);
        break;
      }
      if (PURE_MONEY_LINE_RE.test(nxt)) {
        collect(nxt);
        break;
      }
      if (/[一-龥]/.test(nxt)) break; // 遇到别的文字行，停
    }
  }
  return set;
}

// 页脚/合计/页码类行：里面的数字绝不能当成商品金额或数量
const PAGE_FOOTER_RE = /(每页小计|本页小计|小计|合计|总计|页码|第\s*\d+\s*页|\d+\s*\/\s*\d+\s*页|页共|共\s*\d+\s*页)/;
const PAGE_NUMBER_RE = /^第?\s*\d+\s*[\/-]?\s*\d*\s*页$/;

// 判断两位小数金额是否被中文粘连（如"1.25可口可乐"里的 1.25 不是金额）
function isNumberAdjacentToHan(line: string, numStr: string): boolean {
  const idx = line.indexOf(numStr);
  if (idx < 0) return false;
  const before = idx > 0 ? line[idx - 1] : '';
  const after = line[idx + numStr.length] || '';
  return /[一-龥]/.test(before) || /[一-龥]/.test(after);
}

const UNIT_RE = /^(\d+(?:\.\d+)?)\s*(箱|瓶|包|个|袋|盒|件|条|桶|提|只|听|罐|根)$/;

// 组合表头行（如「条码 商品名称 数量 单价 金额」）：整行都是列名，绝不能当商品名
const COLUMN_HEADER_WORD = /^(规格|建议零售价|零售价|单价|金额|总价|小计|数量|单位|件数|条码|商品条码|商品名称|品名|名称|货品|货名|产品名称|项目|序号|编号|备注|价格|条形码|批号|生产日期|保质期|折扣|折扣率|税率|税额|库存|进价|售价)$/;
function isColumnHeaderLine(line: string): boolean {
  const tokens = line.trim().split(/[\s|｜/、,，]+/).filter(Boolean);
  if (tokens.length < 2) return false;
  return tokens.every((t) => COLUMN_HEADER_WORD.test(t));
}

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
    if (/^\d{12,14}$/.test(l.trim())) barcodeIdxs.push(i);
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
  n = n.replace(/\b\d{12,14}\b/g, ' ');
  // 也去掉 OCR 截断产生的 8~11 位残缺条码（通常后面紧跟着货号/名称）
  n = n.replace(/\b\d{8,11}\b(?=\s+(?:[A-Z]\d{2,3}|[一-龥]))/g, ' ');
  // 去掉 OCR 常见的悬空左/右括号（如 "...豆腩(微辣味" → "...豆腩微辣味"）
  n = n.replace(/[（()）]/g, '');
  return n;
}

function parseItems(lines: string[]): BillItem[] {
  // 真实手机拍摄的多联销售单通常是"竖排表格"：每个商品的数据分散在条码前后多行。
  // 策略：以条码为锚点，全局分配「离条码最近的带单位数量 / 两位小数金额 / 商品名」，
  // 再用 q*p≈amount 或 amount/quantity 反推单价。对非竖排表格 fallback 到旧合并逻辑。

  // 先尝试识别「列式表格」：OCR 把横向表格按列拆成每行一个单元格
  // （序号/商品编码/名称/单位/数量/单价/金额/条码/辅助数量 各占一行）。
  // 这种格式下原来的"以条码为锚点"逻辑会误把合计大写金额当商品名、把单价当金额。
  const columnar = tryParseColumnarTable(lines);
  if (columnar && columnar.length > 0) return columnar;

  const excludedTotals = findExcludedTotals(lines);
  const barcodeIdxs: number[] = [];
  lines.forEach((l, i) => { if (BARCODE_RE.test(l)) barcodeIdxs.push(i); });

  if (barcodeIdxs.length === 0) return parseItemsFallback(lines);

  // 全局提取带单位数量，按最近条码分配（每数量只用一次）
  // 数量在 OCR 中常有三种形态：
  //   1) 同行 "6 袋"
  //   2) 拆行 "6\n袋"（允许间隔最多 3 行，应对针式打印单列错位）
  //   3) 三数字行 "6 2.20 13.20"
  const quantityCandidates: { idx: number; quantity: number; unit?: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (BARCODE_RE.test(trimmed)) continue;
    // 同行：如 "6 袋"
    const m = trimmed.match(UNIT_RE);
    if (m) {
      quantityCandidates.push({ idx: i, quantity: Number(m[1]), unit: m[2] });
      continue;
    }
    // 拆行：当前行是单独整数，其后 3 行内出现独立单位词
    if (/^\d+$/.test(trimmed) && i + 1 < lines.length) {
      let foundUnit: string | undefined;
      for (let k = 1; k <= 3 && i + k < lines.length; k++) {
        const next = lines[i + k].trim();
        if (/^(箱|瓶|包|个|袋|盒|件|条|桶|提|只|听|罐|根)$/.test(next)) {
          foundUnit = next;
          break;
        }
        // 撞到条码/名称/规格/辅助数量/页脚就停
        if (
          BARCODE_RE.test(next) ||
          /[一-龥]{2,}/.test(next) ||
          /^\d+(?:\s*[*xX×]\s*\d+)+$/.test(next) ||
          /^(箱|瓶|包|个|袋|盒|件|条|桶|提|只|听|罐|根)/.test(next) ||
          PAGE_FOOTER_RE.test(next) ||
          PAGE_NUMBER_RE.test(next)
        )
          break;
      }
      if (foundUnit) {
        quantityCandidates.push({ idx: i, quantity: Number(trimmed), unit: foundUnit });
        continue;
      }
    }
    // 无单位的数值行：如 "6 2.20 13.20" / "20 1.50 30.00"，第一个整数就是数量
    const numLine = trimmed.match(/^(\d+)\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)$/);
    if (numLine) {
      quantityCandidates.push({ idx: i, quantity: Number(numLine[1]) });
    }
  }

  const assignedQty = new Map<number, number>(); // barcodeIdx -> quantity
  const assignedUnit = new Map<number, string>(); // barcodeIdx -> unit
  const usedQtyIdx = new Set<number>();
  // 辅助数量常见形式：「1包 / 1盒 / 5袋（表示一箱内含）」；在主数量列附近出现时会抢主数量。
  const isAuxQty = (cand: { quantity: number; unit?: string }) =>
    cand.quantity === 1 && /^(包|盒|箱)$/.test(cand.unit || '');
  for (const bcIdx of barcodeIdxs) {
    let best: { idx: number; quantity: number; unit?: string; dist: number } | undefined;
    for (let q = 0; q < quantityCandidates.length; q++) {
      if (usedQtyIdx.has(q)) continue;
      const cand = quantityCandidates[q];
      const dist = Math.abs(cand.idx - bcIdx);
      if (dist > 14) continue;
      if (!best) {
        best = { idx: q, quantity: cand.quantity, unit: cand.unit, dist };
      } else if (dist < best.dist) {
        best = { idx: q, quantity: cand.quantity, unit: cand.unit, dist };
      } else if (dist === best.dist) {
        // 距离相同时，优先非辅助数量；再优先数量更合理的（5 比 50 更像主数量）
        const candAux = isAuxQty(cand) ? 0 : 1;
        const bestAux = isAuxQty(best) ? 0 : 1;
        if (candAux > bestAux) {
          best = { idx: q, quantity: cand.quantity, unit: cand.unit, dist };
        } else if (candAux === bestAux && cand.quantity < best.quantity) {
          best = { idx: q, quantity: cand.quantity, unit: cand.unit, dist };
        }
      }
    }
    if (best) {
      assignedQty.set(bcIdx, best.quantity);
      if (best.unit) assignedUnit.set(bcIdx, best.unit);
      usedQtyIdx.add(best.idx);
    }
  }

  // 补充：单独成行的单位词（如 "袋" / "盒" / "根"）按最近 barcode 分配
  const unitWords: { idx: number; unit: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (/^(箱|瓶|包|个|袋|盒|件|条|桶|提|只|听|罐|根)$/.test(t)) {
      unitWords.push({ idx: i, unit: t });
    }
  }
  for (const bcIdx of barcodeIdxs) {
    if (assignedUnit.has(bcIdx)) continue;
    let best: { idx: number; unit: string; dist: number } | undefined;
    for (const uw of unitWords) {
      const dist = Math.abs(uw.idx - bcIdx);
      if (dist > 10) continue;
      if (!best || dist < best.dist) best = { ...uw, dist };
    }
    if (best) assignedUnit.set(bcIdx, best.unit);
  }

  // 按条码区间提取「金额」：每行可能有多个两位小数（单价、金额），
  // 在同一区间内取最大者作为金额，避免把 2.20 当成 13.20 误分配。
  const assignedAmt = new Map<number, number>(); // barcodeIdx -> amount
  for (let k = 0; k < barcodeIdxs.length; k++) {
    const bcIdx = barcodeIdxs[k];
    const prevBc = barcodeIdxs[k - 1] ?? -1;
    const nextBc = barcodeIdxs[k + 1] ?? lines.length;
    // 按条码区间提取「金额」：先收集候选数字（整数/小数都可能），
    // 结合已分配的数量用 q*p≈a 选取最合理的金额；验证失败时回退到「带小数优先的最大候选」。
    let bestAmount: number | undefined;
    let amountCandidates: number[] = [];
    // 默认只在当前条码区间内找金额，避免串到下一商品。
    const collectAmounts = (from: number, to: number) => {
      const list: number[] = [];
      for (let i = from; i < to && i < lines.length; i++) {
        const line = lines[i];
        if (PAGE_FOOTER_RE.test(line) || PAGE_NUMBER_RE.test(line.trim())) break;
        const trimmed = line.trim();
        if (BARCODE_RE.test(trimmed)) continue;
        if (/^\d+(?:\s*[*xX×]\s*\d+)+$/.test(trimmed)) continue; // 规格如 1*40
        const matches = trimmed.match(/\b\d+(?:\.\d{1,2})?\b/g);
        if (!matches) continue;
        for (const m of matches) {
          if (isNumberAdjacentToHan(trimmed, m)) continue;
          const n = Number(m);
          if (excludedTotals.has(n)) continue;
          if (n === assignedQty.get(bcIdx)) continue;
          if (n > 100000) continue;
          list.push(n);
        }
      }
      return list;
    };
    amountCandidates = collectAmounts(bcIdx + 1, nextBc);
    // 若当前区间内找不到可信金额（OCR 列错位常见），再往前多看 5 行兜底。
    if (amountCandidates.length === 0) {
      amountCandidates = collectAmounts(Math.max(prevBc + 1, bcIdx - 5), nextBc);
    }

    const q = assignedQty.get(bcIdx);
    if (q != null) {
      // 优先找 q * price ≈ amount 的组合，取最大金额
      let bestPair: { amount: number; price: number } | null = null;
      for (const a of amountCandidates) {
        for (const p of amountCandidates) {
          if (Math.abs(p * q - a) < 0.01) {
            if (!bestPair || a > bestPair.amount) bestPair = { amount: a, price: p };
          }
        }
      }
      if (bestPair) bestAmount = bestPair.amount;
    }
    if (bestAmount == null) {
      // fallback：带小数优先的最大候选
      let hasDecimal = false;
      for (const n of amountCandidates) {
        const isDecimal = !Number.isInteger(n);
        if (
          bestAmount == null ||
          (isDecimal && !hasDecimal) ||
          (isDecimal === hasDecimal && n > bestAmount)
        ) {
          bestAmount = n;
          hasDecimal = hasDecimal || isDecimal;
        }
      }
    }
    if (bestAmount != null) assignedAmt.set(bcIdx, bestAmount);
  }

  const items: BillItem[] = [];
  for (let k = 0; k < barcodeIdxs.length; k++) {
    const bcIdx = barcodeIdxs[k];
    const prevBc = barcodeIdxs[k - 1] ?? -1;
    const nextBc = barcodeIdxs[k + 1] ?? lines.length;

    const barcodeMatch = lines[bcIdx].match(BARCODE_RE);
    const barcode = barcodeMatch ? barcodeMatch[1] : undefined;

    // 横向表格：一行内已包含名称与数量/单价/金额，直接行内解析，不参与竖排分配
    const inline = parseInlineRow(lines[bcIdx], barcode);
    if (inline) {
      const inlineName = normalizeOcrName(cleanName(stripBarcodeFromName(inline.name, barcode)));
      if (inlineName) {
        items.push({
          name: inlineName,
          barcode,
          unit: inline.unit,
          quantity: inline.quantity,
          price: inline.price,
          amount: inline.amount,
        });
        continue;
      }
    }

    // 名称：在本条码区间内找离条码最近且中文足够多的行
    // 先剥掉本行/候选行里粘着的条码，避免「694018888 E61甘源」把货号一起带进名称。
    let bestName = '';
    let bestDist = Infinity;
    for (let i = prevBc + 1; i < nextBc && i < lines.length; i++) {
      if (isColumnHeaderLine(lines[i])) continue;
      const candidate = stripBarcodeFromName(lines[i], barcode);
      const score = scoreName(candidate);
      if (score < 2) continue;
      const dist = Math.abs(i - bcIdx);
      if (dist < bestDist) {
        bestDist = dist;
        bestName = normalizeOcrName(cleanName(candidate));
      }
    }
    if (!bestName) continue;

    let amount = assignedAmt.get(bcIdx);
    let quantity = assignedQty.get(bcIdx);

    // 收集条码附近的数字用于 q*p 反推；从本商品条码行开始，避免上一个商品尾行污染。
    const nums: number[] = [];
    for (let i = bcIdx; i < nextBc && i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (PAGE_FOOTER_RE.test(trimmed) || PAGE_NUMBER_RE.test(trimmed)) continue;
      if (BARCODE_RE.test(trimmed)) continue;
      if (/^\d+(?:\s*[*xX×]\s*\d+)+$/.test(trimmed)) continue;
      if (isProductNameLine(lines[i])) continue;
      if (/[一-龥]/.test(trimmed) && !/^\d+(?:\.\d+)?\s*(?:箱|瓶|包|个|袋|盒|件|条|桶|提|只|听|罐|根)?$/.test(trimmed)) continue;
      const matches = trimmed.match(/-?\d+(?:\.\d+)?/g);
      if (matches) {
        for (const m of matches) {
          const n = Number(m);
          if (Number.isFinite(n) && n > 0 && n < 100000) nums.push(n);
        }
      }
    }
    const safeNums = nums.filter((n) => !excludedTotals.has(Number(n.toFixed(2))));

    let price: number | undefined;
    if (amount != null) {
      const amt = amount;
      if (quantity != null) {
        const qtt = quantity;
        const exact = safeNums.find((p) => Math.abs(p * qtt - amt) < 0.01);
        price = exact != null ? exact : Number((amt / qtt).toFixed(4));
      } else {
        let best: { q: number; p: number; score: number } | null = null;
        for (let i = 0; i < safeNums.length; i++) {
          for (let j = 0; j < safeNums.length; j++) {
            if (i === j) continue;
            const q = safeNums[i];
            const p = safeNums[j];
            if (Math.abs(q * p - amt) < 0.01) {
              let score = 0;
              if (Number.isInteger(q)) score += 100; // 数量优先为整数
              if (!Number.isInteger(p)) score += 10;  // 单价优先带小数
              if (q > 10 && p < 20) score += 1;        // 批发规格轻微偏好
              if (!best || score > best.score) best = { q, p, score };
            }
          }
        }
        if (best) {
          quantity = best.q;
          price = best.p;
        }
      }
    } else if (quantity != null) {
      // 金额缺失时（常见整数金额如 27/30/45），在 nearby nums 中找 q*p≈a，优先最大的 a
      let best: { p: number; a: number; score: number } | null = null;
      for (const p of safeNums) {
        for (const a of safeNums) {
          if (Math.abs(p * quantity - a) < 0.01) {
            let score = 0;
            if (!Number.isInteger(p)) score += 10; // 单价优先带小数
            score += a; // 金额越大越优先（避免把规格小数字当金额）
            if (!best || score > best.score) best = { p, a, score };
          }
        }
      }
      if (best) {
        price = best.p;
        amount = best.a;
      } else {
        // 兜底：找一个非整数单价反推金额
        const priceCandidates = safeNums.filter((n) => n >= 0.1 && n <= 500 && !Number.isInteger(n));
        if (priceCandidates.length > 0) {
          price = priceCandidates[0];
          amount = Number((price * quantity).toFixed(4));
        }
      }
    }

    if (quantity == null) {
      const intCandidates = safeNums.filter((n) => n > 0 && n < 1000 && Number.isInteger(n) && String(n) !== barcode && !excludedTotals.has(n));
      if (intCandidates.length > 0) quantity = Math.min(...intCandidates);
    }

    if (price == null && amount != null && quantity != null && quantity !== 0) {
      price = Number((amount / quantity).toFixed(4));
    }

    items.push({ name: bestName, barcode, unit: assignedUnit.get(bcIdx), quantity, price, amount });
  }

  if (items.length > 0) return items.slice(0, 50);
  return parseItemsFallback(lines);
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
    const bar = line.match(/\b([0-9]{12,14})\b/);
    if (bar && !pending.barcode) pending.barcode = bar[1];
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
      const barcodeMatch = working.match(/\b(\d{12,14})\b/);
      if (barcodeMatch) working = working.replace(barcodeMatch[0], ' ');
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
      const it: BillItem = { name };
      if (barcodeMatch) {
        it.barcode = barcodeMatch[1];
        const bcNum = Number(barcodeMatch[1]);
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
        pending = { name, quantity: undefined, price: undefined, amount: undefined };
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
