// OCR 文本解析：把腾讯云/本地引擎返回的纯文本，提取为结构化 OcrResult。
// 与 PC 端 retail-admin/src/utils/ocrParse.ts 逻辑完全一致，便于两端共用识别口径。
// 腾讯云 GeneralAccurateOCR 返回的是图片里所有文字行（\n 拼接），不含字段结构，
// 所以这里用正则 + 行匹配把「营养成分表 / 配料表 / 品牌 / 条码」拆出来。
// 容错原则：识别不出的字段留空，交给用户在 UI 里手填，绝不臆造数据。

export interface NutritionItem {
  name: string;
  amount: string;
  nrv?: string;
}

export interface OcrResult {
  name: string;
  price: number;
  originalPrice: number;
  tags: string[];
  shopName: string;
  productName: string;
  brand?: string;
  ingredients: string;
  nutrition: NutritionItem[];
  barcode?: string;
}

const NUTRITION_KEYS: Array<{ key: string; aliases: RegExp }> = [
  { key: '能量', aliases: /^(能量|热量|energy)/i },
  { key: '蛋白质', aliases: /^(蛋白质|蛋白|protein)/i },
  { key: '脂肪', aliases: /^(脂肪|fat)/i },
  { key: '碳水化合物', aliases: /^(碳水化合物|碳水|糖类|carbohydrate)/i },
  { key: '钠', aliases: /^(钠|sodium|na)/i },
  { key: '钙', aliases: /^(钙|calcium|ca)/i },
  { key: '胆固醇', aliases: /^(胆固醇|cholesterol)/i },
  { key: '膳食纤维', aliases: /^(膳食纤维|纤维|dietary fiber|fiber)/i },
  { key: '糖', aliases: /^(糖|sugar)/i },
  { key: '反式脂肪酸', aliases: /^(反式|trans)/i },
  { key: '维生素', aliases: /^(维生素|vitamin)/i },
];

// 含量不含百分比（% 单独给 NRV 用），避免把 24% 误当含量
const AMOUNT_RE = /(\d+(?:\.\d+)?\s*(?:kj|kJ|千焦|g|克|mg|毫克|μg|微克|ml|毫升|L|升))/i;
const NRV_RE = /(\d+(?:\.\d+)?\s*%)/;

function matchNutritionKey(line: string): string | null {
  const head = line.replace(/[：:]/g, ' ').trim().split(/\s+/)[0] || '';
  for (const k of NUTRITION_KEYS) {
    if (k.aliases.test(head) || k.aliases.test(line)) return k.key;
  }
  return null;
}

// 支持同行（能量 2015千焦 24%）和拆列（能量\n2015千焦\n24%）两种版式
function parseNutrition(lines: string[]): NutritionItem[] {
  const startIdx = lines.findIndex((l) =>
    /营养成分|营养成份|营养标签|Nutrition\s*Facts|Nutrition\s*Information/i.test(l),
  );
  const region = startIdx >= 0 ? lines.slice(startIdx + 1) : lines;

  const positions: { name: string; idx: number }[] = [];
  for (let i = 0; i < region.length; i++) {
    const key = matchNutritionKey(region[i]);
    if (key) positions.push({ name: key, idx: i });
  }

  const out: NutritionItem[] = [];
  for (let k = 0; k < positions.length; k++) {
    const { name, idx } = positions[k];
    const end = k + 1 < positions.length ? positions[k + 1].idx : region.length;
    const segment = region.slice(idx, end);
    const joined = segment.join(' ');

    const amountMatch = joined.match(AMOUNT_RE);
    const nrvMatch = joined.match(NRV_RE);
    const amount = amountMatch ? amountMatch[1].trim() : '';
    const nrv = nrvMatch ? nrvMatch[1].trim() : undefined;
    out.push(amount ? { name, amount, nrv } : { name, amount: '' });
  }
  return out;
}

// 明显不是商品名/配料/条码的 UI 干扰词（拍照时把 App 界面或取景框文字拍进去会出现）
const UI_NOISE_RE =
  /^(将商品标签|自动识别|取消|拍|翻转|主图|主图预览|主图格式|主图背景|预览|保存|保存到主图库|推荐|首页|经营|桶装水|商品|我的|营养|配料|双栏|白底|米色|透明|添加|\+|\d{1,2}:\d{2}|20\d{6}|合格|客户签|字：|字:)$/;

// 配料/成分提取到这些关键字就停（行首出现即可，不要求整行完全匹配）
const INGREDIENT_STOP_RE =
  /^(营养成分|营养成份|营养成分表|营养标签|执行标准|保质期|保质期至|生产日期|生产日期及批号|净含量|贮藏方法|保存条件|贮存条件|制造商|生产地址|生产地址:|地址|经销商|邮政编码|服务热线|消费者服务热线|全国服务热线|原产国|产品名称|消费须知|敬告|食用方法|注意事项|温馨提示|过敏原信息|条码|条形码|保存|取消|翻转|自动识别|首页|经营|桶装水|商品|我的)/;
// 不带 ^ 锚定的版本，用于一行文字内部出现终止词时截断
const INGREDIENT_STOP_INLINE_RE =
  /(营养成分|营养成份|营养成分表|营养标签|执行标准|保质期|保质期至|生产日期|生产日期及批号|净含量|贮藏方法|保存条件|贮存条件|制造商|生产地址|生产地址:|地址|经销商|邮政编码|服务热线|消费者服务热线|全国服务热线|原产国|产品名称|消费须知|敬告|食用方法|注意事项|温馨提示|过敏原信息|条码|条形码|保存|取消|翻转|自动识别|首页|经营|桶装水|商品|我的)/;

function parseBarcode(text: string): string | undefined {
  // 1) 明确标了「条码/条形码」的，优先用（但要排除 20XXXXXX 这种生产日期/批号）
  const labeled = text.match(/(?:条码|条形码|barcode)[:：]?\s*([0-9]{8,14})/i);
  if (labeled) {
    const code = labeled[1];
    if (!/^20\d{6}$/.test(code)) return code;
  }
  // 2) 优先 13 位 EAN（国内常见 690-699 开头）
  const ean13 = text.match(/\b([0-9]{13})\b/);
  if (ean13) return ean13[1];
  // 3) 再尝试拼接被空格/换行打断的 13 位 EAN（国内常见 690-699 开头）
  const digitsOnly = text.replace(/\D/g, '');
  const ean13Joined = digitsOnly.match(/(69[0-9]\d{10})/);
  if (ean13Joined) return ean13Joined[1];
  // 没有可信条码时不臆造（避免把电话号码、生产日期、部分条码当结果）
  return undefined;
}

function parseIngredients(text: string, lines: string[]): string {
  // 支持「主要成分」「配料」「原料」多种叫法
  // 情况 A: 「配料: xxx」或「配料 xxx」同行
  let idx = lines.findIndex((l) => /^(主要成分|配料|配　料|配 料|原料)[:：]/.test(l.trim()));
  // 情况 B: 「配料表」单独一行，下一行才是内容
  if (idx < 0) {
    idx = lines.findIndex((l) => /^(主要成分|配料|配　料|配 料|原料)(?:表)?$/.test(l.trim()));
  }
  if (idx >= 0) {
    // 标题行本身去掉前缀，保留可能同行的内容
    const headerRe = /^(?:主要成分|配料|原料)(?:表)?[:：]?\s*/;
    let seg = lines[idx].replace(headerRe, '').trim();
    let j = idx + 1;
    while (j < lines.length) {
      const line = lines[j].trim();
      // 行首就是终止词，直接停止
      if (INGREDIENT_STOP_RE.test(line)) break;
      // OCR 常把多行文字合并成一行，若行内出现终止词，按终止词截断并停止
      const inlineStop = line.search(INGREDIENT_STOP_INLINE_RE);
      if (inlineStop > 0) {
        const tail = line.slice(0, inlineStop).trim();
        if (tail) seg += (seg ? '、' : '') + tail;
        break;
      }
      seg += (seg ? '、' : '') + line;
      j++;
    }
    if (seg) return seg.replace(/、$/, '');
  }
  // 兜底：正则大块提取，按更全的边界词截断，防止 OCR 把地址/服务热线/原产国等同行进配料
  const m = text.match(
    /(?:主要成分|配料|原料)[:：]?\s*([\s\S]*?)(?=营养成分表|营养成分|营养标签|执行标准|保质期|保质期至|生产日期|生产日期及批号|净含量|贮藏方法|保存条件|贮存条件|制造商|生产地址|生产地址:|地址|经销商|邮政编码|服务热线|消费者服务热线|全国服务热线|原产国|产品名称|消费须知|敬告|食用方法|注意事项|温馨提示|过敏原信息|条码|条形码|$)/i
  );
  const fallback = m ? m[1].replace(/\s+/g, '').trim() : '';
  return fallback ? fallback.replace(/、$/, '') : '';
}

function extractBrand(lines: string[]): string | undefined {
  const brandLine = lines.find((l) => /品牌|brand/i.test(l));
  if (brandLine) {
    const m = brandLine.match(/品牌[:：]?\s*(.+)$/i);
    if (m) return m[1].trim();
  }
  const known = [
    '炫迈', '亿滋', '玛氏', '农夫山泉', '康师傅', '伊利', '蒙牛', '可口可乐', '百事', '统一', '旺旺',
    '今麦郎', '娃哈哈', '怡宝', '景田', '百岁山', '三只松鼠', '良品铺子',
    '双汇', '金锣', '雨润', '海天', '李锦记', '厨邦', '太太乐', '好丽友',
    '奥利奥', '达能', '雀巢', '美赞臣', '惠氏', '飞鹤', '君乐宝',
  ];
  for (const l of lines) {
    const hit = known.find((b) => l.includes(b));
    if (hit) return hit;
  }
  return undefined;
}

// 常见口味/规格/系列短词，单独出现时更可能是描述而非完整商品名
const FLAVOR_LIKE_RE = /^(桂圆|草莓|巧克力|原味|麻辣|香辣|孜然|烧烤|番茄|牛肉|鸡肉|猪肉|海鲜|蓝莓|葡萄|橙子|柠檬|黄瓜|绿茶|红茶|奶茶|酸奶|牛奶|蜂蜜|黑芝麻|白芝麻|五香|蒜香|葱香|黑胡椒|糖醋|红烧|清炖|泡椒|酸菜|剁椒|蒜蓉|姜汁|蜜汁|糖浆|果酱|果汁|果肉|果味|混合|综合|什锦|杂粮|粗粮|全麦|无糖|低糖|低盐|低脂|高钙|高铁|高纤维|儿童|老年|学生|运动|代餐|早餐|夜宵|零食|坚果|果干|肉脯|海苔|薯片|饼干|糖果|巧克力|口香糖|槟榔|果冻|布丁|蛋糕|面包|月饼|粽子|汤圆|饺子|馄饨|包子|馒头|花卷|油条|煎饼|烙饼|烧饼|三明治|汉堡|披萨|寿司|沙拉|椰汁|杏仁露|核桃露|花生露|豆奶|燕麦奶|椰奶|奶酪|芝士|黄油|奶油|炼乳|奶粉|冰淇淋|雪糕|冰棍|咖啡|茶|酒|啤酒|白酒|红酒|黄酒|米酒|清酒|威士忌|伏特加|朗姆|金酒|龙舌兰|鸡尾酒|汽水|饮料|矿泉水|纯净水|苏打水|气泡水)$/;

function parseProductName(lines: string[]): { productName: string; brand?: string } {
  // 优先从「产品名称：」行提取
  const nameLine = lines.find((l) => /^(产品名称|品名|名称)[:：]/.test(l.trim()));
  if (nameLine) {
    const m = nameLine.match(/^(?:产品名称|品名|名称)[:：]\s*(.+)$/);
    if (m) {
      const productName = m[1].trim();
      const brand = extractBrand([productName]) || extractBrand(lines);
      return { productName, brand };
    }
  }
  // 兜底：取第一行非空且不是 UI 干扰词的文字
  const first = lines.find((l) => {
    const t = l.trim();
    return t.length > 0 && !UI_NOISE_RE.test(t) && !/^\d{1,2}:\d{2}$/.test(t) && !/^[A-Z]{6,}$/.test(t);
  })?.trim() || '';
  const brand = extractBrand(lines);
  if (!brand) return { productName: first, brand };
  // 如果识别出品牌，且第一行只是简短口味/系列词，用「品牌（口味）」更合理
  if (first && first !== brand && (FLAVOR_LIKE_RE.test(first) || first.length <= 6)) {
    return { productName: `${brand}（${first}）`, brand };
  }
  // 第一行本身就是品牌名或包含品牌名
  if (first && (first === brand || first.includes(brand))) {
    return { productName: first, brand };
  }
  // 兜底：品牌 + 第一行
  return { productName: first ? `${brand} ${first}` : brand, brand };
}

/**
 * 解析 OCR 纯文本为结构化结果。
 * @param raw 后端 /api/ocr/scan 返回的 data.text（按行 \n 拼接的纯文本）
 */
export function parseOcrText(raw: string): OcrResult {
  const text = (raw || '').trim();
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const { productName, brand } = parseProductName(lines);
  const ingredients = parseIngredients(text, lines);
  const nutrition = parseNutrition(lines);
  const barcode = parseBarcode(text);
  return {
    name: productName,
    price: 0,
    originalPrice: 0,
    tags: [],
    shopName: '',
    productName,
    brand,
    ingredients,
    nutrition,
    barcode,
  };
}
