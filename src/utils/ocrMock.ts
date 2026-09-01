// OCR 主图识别：当前为 mock 实现（先做 UI），后续可替换为真实 OCR 接口。
// 抽成独立 util，便于单测，也便于将来整体替换为真实 API。
// 与 PC 端 retail-admin/src/utils/ocrMock.ts 保持一致，便于两端共用识别口径。

export interface NutritionItem {
  name: string;
  amount: string;
  nrv?: string;
}

export interface OcrResult {
  // 旧字段（兼容）
  name: string;
  price: number;
  originalPrice: number;
  tags: string[];
  shopName: string;

  // 新字段：配料表 / 营养成分 / 品牌
  productName: string;
  brand?: string;
  ingredients: string;
  nutrition: NutritionItem[];
  barcode?: string;
}

const MOCK_POOL: OcrResult[] = [
  {
    name: '农夫山泉550ml天然水',
    price: 1.9,
    originalPrice: 2.5,
    tags: ['限时特惠', '包邮'],
    shopName: '社区便利店',
    productName: '农夫山泉饮用天然水 550ml',
    brand: '农夫山泉',
    barcode: '6921168509256',
    ingredients: '天然水、食品添加剂（氯化钾、硫酸镁）',
    nutrition: [
      { name: '能量', amount: '0 kJ', nrv: '0%' },
      { name: '蛋白质', amount: '0 g', nrv: '0%' },
      { name: '脂肪', amount: '0 g', nrv: '0%' },
      { name: '碳水化合物', amount: '0 g', nrv: '0%' },
      { name: '钠', amount: '0 mg', nrv: '0%' },
    ],
  },
  {
    name: '康师傅红烧牛肉面',
    price: 3.5,
    originalPrice: 4.5,
    tags: ['第二件半价'],
    shopName: '惠民超市',
    productName: '康师傅红烧牛肉面 103g',
    brand: '康师傅',
    barcode: '6920152401021',
    ingredients: '面饼、调味酱包、调味粉包、脱水蔬菜包',
    nutrition: [
      { name: '能量', amount: '2015 kJ', nrv: '24%' },
      { name: '蛋白质', amount: '9.5 g', nrv: '16%' },
      { name: '脂肪', amount: '22.0 g', nrv: '37%' },
      { name: '碳水化合物', amount: '60.5 g', nrv: '20%' },
      { name: '钠', amount: '2300 mg', nrv: '115%' },
    ],
  },
  {
    name: '伊利纯牛奶250ml',
    price: 2.8,
    originalPrice: 3.5,
    tags: ['会员专享', '新鲜直达'],
    shopName: '邻里鲜生',
    productName: '伊利纯牛奶 250ml',
    brand: '伊利',
    barcode: '6921234500001',
    ingredients: '生牛乳',
    nutrition: [
      { name: '能量', amount: '280 kJ', nrv: '3%' },
      { name: '蛋白质', amount: '3.2 g', nrv: '5%' },
      { name: '脂肪', amount: '3.8 g', nrv: '6%' },
      { name: '碳水化合物', amount: '4.8 g', nrv: '2%' },
      { name: '钠', amount: '60 mg', nrv: '3%' },
      { name: '钙', amount: '100 mg', nrv: '13%' },
    ],
  },
];

export function mockOcr(): OcrResult {
  const base = MOCK_POOL[Math.floor(Math.random() * MOCK_POOL.length)];
  // 深拷贝，避免后续编辑互相影响
  return JSON.parse(JSON.stringify(base));
}
