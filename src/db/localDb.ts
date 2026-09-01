import { openDatabaseSync, type SQLiteDatabase } from 'expo-sqlite';
import { LOCAL_DB_NAME } from '../config';
import { apiFetch } from '../api/client';
import {
  DEFAULT_CUSTOM_CHANNELS,
  normalizeCustomChannels,
  type CustomChannel,
} from '../api/settings';
import { toLocalDateStr } from '../utils/dateLabel';

export type DraftStatus = 'pending' | 'syncing' | 'synced' | 'conflict';

// 本地离线草稿（对齐后端 purchase_order 字段 + 同步字段）
export interface Draft {
  id: string; // 即 client_temp_id（本地生成 uuid）
  orderNo: string;
  date: string; // YYYY-MM-DD
  supplierName: string;
  items: string; // JSON 字符串：[{name,quantity,unit,price}]
  totalAmount: number;
  paidAmount: number;
  discount: number;
  paid: number; // 0|1
  arrivalDate: string;
  note: string;
  images: string; // JSON 数组：本地照片文件 uri 列表
  // 已上传成功的照片映射 JSON：{ [本地uri]: 服务端返回的 /uploads/xxx }
  //
  // 存在的意义（修复「上传一张得到六张」）：
  //   POST /api/upload 每调用一次就无条件往 image_resource 插一行（server.js:1257，
  //   既不按 file_hash 去重也不按 order_no 去重），而 runSync 的重试路径非常密集
  //   （push 失败 → 'pending'；卡死的 'syncing' 被 reclaimStaleSyncing 回收 → 'pending'），
  //   每重试一轮就把同一张本地照片重新上传一次 → 同一 orderNo 下堆出 N 行记录。
  //   网页端 /api/images?orderNo= 正是按这张表渲染的，所以一张照片显示成了六张
  //   （物理文件按内容哈希命名会被覆盖，所以磁盘没有真的多出六份 —— 只有记录重复）。
  //   把「本地 uri → 远端 url」持久化下来，重试时直接复用，上传就变成幂等的。
  uploadedMap: string;
  purchaseDate: string; // 进货日期 YYYY-MM-DD
  stockStatus: number; // 入库状态：1=已入库 0=草稿/不入库 2=已作废
  category: string; // 进货类别：食品/水饮/百货/其他（可自定义）
  saveToStockIn: number; // 是否保存为入库单：0=否 1=是（仅商品明细方式可开启）
  status: DraftStatus;
  syncVersion: number;
  deviceId: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * 本地离线营收草稿（对齐后端 POST /api/revenue 请求体 + 同步字段）。
 *
 * 为什么需要这张表：
 *   进货有 drafts 表兜底，营收却没有 —— 原来 RevenueForm 是「不在店铺网段就直接拒绝录入」，
 *   在店铺网段但电脑关机时更糟：放行进去后 POST 失败，用户填的那一笔**直接丢了**。
 *   而 /api/sync/push 只认 purchase_order（server.js:558），营收根本没有批量补推通道。
 *   所以营收要做到「电脑关机也能记、开机自动补」，必须自带本地草稿 + 自己的推送路径。
 */
export interface RevenueDraft {
  id: string; // 本地生成 uuid，同时充当去重身份
  date: string; // YYYY-MM-DD
  payments: string; // JSON：{cash,wechat,alipay,custom1,...}，与网页端 payments 结构一致
  total: number;
  note: string;
  status: DraftStatus;
  deviceId: string;
  /**
   * 「这一笔的 POST 已经发出去过」的时间戳（0 = 从未发出）。
   *
   * 存在的意义：POST /api/revenue **没有幂等键**（server.js:646 自己 genId），
   * 请求发出后如果没能拿到响应（Wi-Fi 掉线 / App 被杀 / 超时），我们无法判断服务端到底写没写。
   * 此时直接重发就可能把同一笔营收记两遍 —— 记错账比漏记更难查。
   * 所以「发之前先落盘标记」，重试时先去服务端比对一次，确认没落库才敢重发。
   */
  pushedAt: number;
  createdAt: number;
  updatedAt: number;
}

let db: SQLiteDatabase | null = null;

export function getDb(): SQLiteDatabase {
  if (!db) {
    db = openDatabaseSync(LOCAL_DB_NAME);
    db.execSync(`CREATE TABLE IF NOT EXISTS drafts (
      id TEXT PRIMARY KEY,
      orderNo TEXT,
      date TEXT,
      supplierName TEXT,
      items TEXT,
      totalAmount REAL,
      paidAmount REAL,
      discount REAL,
      paid INTEGER,
      arrivalDate TEXT,
      note TEXT,
      images TEXT,
      uploadedMap TEXT,
      purchaseDate TEXT,
      stockStatus INTEGER,
      category TEXT,
      saveToStockIn INTEGER,
      status TEXT,
      syncVersion INTEGER,
      deviceId TEXT,
      createdAt INTEGER,
      updatedAt INTEGER
    );`);
    // 老版本库安全补列（CREATE TABLE IF NOT EXISTS 不会对已存在的表新增列）
    const draftCols = db.getAllSync('PRAGMA table_info(drafts)') as { name: string }[];
    const hasCol = (n: string) => draftCols.some((c) => c.name === n);
    if (!hasCol('purchaseDate')) db.execSync('ALTER TABLE drafts ADD COLUMN purchaseDate TEXT');
    if (!hasCol('stockStatus')) db.execSync('ALTER TABLE drafts ADD COLUMN stockStatus INTEGER');
    if (!hasCol('uploadedMap')) db.execSync('ALTER TABLE drafts ADD COLUMN uploadedMap TEXT');
    if (!hasCol('category')) db.execSync("ALTER TABLE drafts ADD COLUMN category TEXT DEFAULT ''");
    if (!hasCol('saveToStockIn')) db.execSync('ALTER TABLE drafts ADD COLUMN saveToStockIn INTEGER');
    ensureCacheTables();
    ensureRevenueDraftTable();
    ensureWarrantyTable();
    ensureBarrelTables();
    ensureCatalogTables();
    ensureOcrCardsTable();
    // 启动自愈：上次进程被杀 / App 被切后台挂起时，草稿会永久卡在 'syncing'。
    // 这里在拿到 db 的第一时间把所有历史 'syncing' 打回 'pending'（此刻不可能有同步在跑）。
    db.runSync("UPDATE drafts SET status='pending' WHERE status='syncing'");
    db.runSync("UPDATE revenue_drafts SET status='pending' WHERE status='syncing'");
  }
  return db;
}

/** 营收草稿表：老版本安装升级上来时库里没有这张表，getDb() 首次打开库时统一建好 */
function ensureRevenueDraftTable() {
  getDb().execSync(`CREATE TABLE IF NOT EXISTS revenue_drafts (
    id TEXT PRIMARY KEY,
    date TEXT,
    payments TEXT,
    total REAL,
    note TEXT,
    status TEXT,
    deviceId TEXT,
    pushedAt INTEGER,
    createdAt INTEGER,
    updatedAt INTEGER
  );`);
}

export function insertDraft(
  d: Omit<Draft, 'status' | 'syncVersion' | 'createdAt' | 'updatedAt' | 'uploadedMap'> &
    Partial<Pick<Draft, 'status' | 'syncVersion' | 'createdAt' | 'updatedAt' | 'uploadedMap'>>
) {
  const now = Date.now();
  getDb().runSync(
    `INSERT OR REPLACE INTO drafts
     (id,orderNo,date,supplierName,items,totalAmount,paidAmount,discount,paid,arrivalDate,note,images,uploadedMap,purchaseDate,stockStatus,category,saveToStockIn,status,syncVersion,deviceId,createdAt,updatedAt)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      d.id, d.orderNo, d.date, d.supplierName, d.items, d.totalAmount, d.paidAmount,
      d.discount, d.paid, d.arrivalDate, d.note, d.images, d.uploadedMap ?? '{}',
      d.purchaseDate, d.stockStatus, d.category || '',
      d.saveToStockIn ?? 0,
      d.status ?? 'pending',
      d.syncVersion ?? 1, d.deviceId, d.createdAt ?? now, d.updatedAt ?? now,
    ]
  );
}

export function getAllDrafts(): Draft[] {
  return getDb().getAllSync('SELECT * FROM drafts ORDER BY createdAt DESC') as Draft[];
}

export function getDraftById(id: string): Draft | undefined {
  return getDb().getFirstSync('SELECT * FROM drafts WHERE id=?', [id]) as Draft | undefined;
}

export function getPendingDrafts(): Draft[] {
  return getDb().getAllSync(
    "SELECT * FROM drafts WHERE status='pending' ORDER BY createdAt DESC"
  ) as Draft[];
}

// ============ 同步状态自愈（修复"草稿永久卡在 同步中"）============
//
// 原设计的致命缺陷：'syncing' 是一个**没有出口的终态**。
//   runSync 先 setDraftStatus(id,'syncing') 再去传图/推送，中途只要 JS 上下文没了
//   （App 切后台被 iOS 挂起、进程被杀、开发时 reload、fetch promise 永不 settle），
//   那句负责改回 'pending' 的 catch 就永远不会执行。
// 而所有重试入口都只认 status='pending'：
//   · getPendingDrafts() → runSync 取不到它
//   · App 的 pendingCount → 概览「待同步草稿」显示 0
//   · 草稿箱 / 录单页的「同步全部」按钮在 pending===0 时隐藏或禁用 → 手动也点不了
// 于是就出现了用户看到的组合：明细里躺着一条「待同步」，概览计数 0，草稿箱一直「同步中」。

/** 一次同步允许的最长耗时；超过即认定为孤儿，可被回收重试 */
export const SYNCING_STALE_MS = 2 * 60 * 1000;

/**
 * 回收孤儿 'syncing' 草稿 → 'pending'。
 * 只回收 updatedAt 超过 maxAgeMs 的，避免打断正在进行中的同步。
 * @returns 被回收的条数
 */
export function reclaimStaleSyncing(maxAgeMs: number = SYNCING_STALE_MS): number {
  const cutoff = Date.now() - maxAgeMs;
  const res = getDb().runSync(
    "UPDATE drafts SET status='pending', updatedAt=? WHERE status='syncing' AND updatedAt < ?",
    [Date.now(), cutoff]
  );
  return res.changes ?? 0;
}

/** 所有"尚未落到服务端"的草稿：pending + syncing + conflict。UI 计数一律用这个，保证各页口径一致 */
export function getUnsyncedDrafts(): Draft[] {
  return getDb().getAllSync(
    "SELECT * FROM drafts WHERE status IN ('pending','syncing','conflict') ORDER BY createdAt DESC"
  ) as Draft[];
}

/** 所有"尚未落到服务端"的营收草稿：pending + syncing + conflict */
export function getUnsyncedRevenueDrafts(): RevenueDraft[] {
  ensureRevenueDraftTable();
  return getDb().getAllSync(
    "SELECT * FROM revenue_drafts WHERE status IN ('pending','syncing','conflict') ORDER BY createdAt DESC"
  ) as RevenueDraft[];
}

/**
 * **只数进货草稿**（pending + syncing + conflict）。
 *
 * 刻意不在这里把营收加进来：函数名说的是 draft（进货 drafts 表），
 * 名字与口径不一致的聚合函数是二次踩坑的温床 —— 调用方看名字以为只有进货，
 * 再自己补一次 `+ getUnsyncedRevenueDraftCount()`，营收就被数了两遍。
 * 「进货 + 营收」的总数请在调用点显式相加（见 App.tsx 的 totalUnsyncedCount）。
 */
export function getUnsyncedDraftCount(): number {
  const row = getDb().getFirstSync(
    "SELECT COUNT(*) AS n FROM drafts WHERE status IN ('pending','syncing','conflict')"
  ) as { n: number } | undefined;
  return row?.n ?? 0;
}

// ============ 营收草稿 CRUD ============

export function insertRevenueDraft(
  d: Omit<RevenueDraft, 'status' | 'pushedAt' | 'createdAt' | 'updatedAt'> &
    Partial<Pick<RevenueDraft, 'status' | 'pushedAt' | 'createdAt' | 'updatedAt'>>
) {
  const now = Date.now();
  ensureRevenueDraftTable();
  getDb().runSync(
    `INSERT OR REPLACE INTO revenue_drafts
     (id,date,payments,total,note,status,deviceId,pushedAt,createdAt,updatedAt)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [
      d.id, d.date, d.payments, d.total, d.note,
      d.status ?? 'pending', d.deviceId, d.pushedAt ?? 0,
      d.createdAt ?? now, d.updatedAt ?? now,
    ]
  );
}

export function getAllRevenueDrafts(): RevenueDraft[] {
  ensureRevenueDraftTable();
  return getDb().getAllSync(
    'SELECT * FROM revenue_drafts ORDER BY createdAt DESC'
  ) as RevenueDraft[];
}

export function getRevenueDraftById(id: string): RevenueDraft | undefined {
  ensureRevenueDraftTable();
  return getDb().getFirstSync('SELECT * FROM revenue_drafts WHERE id=?', [id]) as
    | RevenueDraft
    | undefined;
}

export function getUnsyncedRevenueDraftCount(): number {
  ensureRevenueDraftTable();
  const row = getDb().getFirstSync(
    "SELECT COUNT(*) AS n FROM revenue_drafts WHERE status IN ('pending','syncing','conflict')"
  ) as { n: number } | undefined;
  return row?.n ?? 0;
}

/** 与进货草稿同款自愈：回收超时卡死的 'syncing'，否则它对所有重试路径都是隐形的 */
export function reclaimStaleSyncingRevenue(maxAgeMs: number = SYNCING_STALE_MS): number {
  ensureRevenueDraftTable();
  const cutoff = Date.now() - maxAgeMs;
  const res = getDb().runSync(
    "UPDATE revenue_drafts SET status='pending', updatedAt=? WHERE status='syncing' AND updatedAt < ?",
    [Date.now(), cutoff]
  );
  return res.changes ?? 0;
}

export function claimSyncableRevenueDrafts(): RevenueDraft[] {
  reclaimStaleSyncingRevenue();
  return getDb().getAllSync(
    "SELECT * FROM revenue_drafts WHERE status IN ('pending','conflict') ORDER BY createdAt ASC"
  ) as RevenueDraft[];
}

export function setRevenueDraftStatus(id: string, status: DraftStatus) {
  ensureRevenueDraftTable();
  getDb().runSync('UPDATE revenue_drafts SET status=?, updatedAt=? WHERE id=?', [
    status,
    Date.now(),
    id,
  ]);
}

/**
 * 在真正发出 POST **之前**调用：把「已经试过发这一笔」这件事先落盘。
 * 顺序不能反 —— 先发再记的话，请求发出后进程被杀就丢失了这个事实，
 * 下一轮会当成全新草稿直接重发，服务端就多出一笔重复营收。
 */
export function markRevenueDraftPushed(id: string) {
  ensureRevenueDraftTable();
  getDb().runSync('UPDATE revenue_drafts SET pushedAt=?, updatedAt=? WHERE id=?', [
    Date.now(),
    Date.now(),
    id,
  ]);
}

export function deleteRevenueDraft(id: string) {
  ensureRevenueDraftTable();
  getDb().runSync('DELETE FROM revenue_drafts WHERE id=?', [id]);
}

/**
 * 原地更新一条营收草稿（编辑草稿时用）。
 * 与 updateDraft 同款思路：读出旧行 → 浅合并 patch → 写回，保留 id 不漂移。
 *
 * 状态保持不动：编辑一条「待同步/冲突」草稿 → 仍是 pending/conflict → 下一轮同步推修正版；
 * 编辑一条「已同步」草稿 → 仍是 synced → 不会重推，避免把同一笔营收记两遍
 * （服务端 POST /api/revenue 无幂等键，重推即重复记账）。
 * 若以后需要「改完强制重推」，调用方显式传 status:'pending' 即可。
 */
export function updateRevenueDraft(id: string, patch: Partial<RevenueDraft>) {
  ensureRevenueDraftTable();
  const d = getDb().getFirstSync('SELECT * FROM revenue_drafts WHERE id=?', [id]) as
    | RevenueDraft
    | undefined;
  if (!d) return;
  const merged = { ...d, ...patch, updatedAt: Date.now() };
  getDb().runSync(
    `UPDATE revenue_drafts SET date=?, payments=?, total=?, note=?, status=?, updatedAt=? WHERE id=?`,
    [merged.date, merged.payments, merged.total, merged.note, merged.status, merged.updatedAt, id]
  );
}

/**
 * 供 runSync 使用：先回收孤儿，再取出本轮要同步的草稿。
 * conflict 也纳入重试（上一轮冲突后本地还留着的，值得再推一次）。
 */
export function claimSyncableDrafts(): Draft[] {
  reclaimStaleSyncing();
  return getDb().getAllSync(
    "SELECT * FROM drafts WHERE status IN ('pending','conflict') ORDER BY createdAt DESC"
  ) as Draft[];
}

export function setDraftStatus(id: string, status: DraftStatus) {
  getDb().runSync('UPDATE drafts SET status=?, updatedAt=? WHERE id=?', [status, Date.now(), id]);
}

export function deleteDraft(id: string) {
  getDb().runSync('DELETE FROM drafts WHERE id=?', [id]);
}

export function updateDraft(id: string, patch: Partial<Draft>) {
  const d = getDb().getFirstSync('SELECT * FROM drafts WHERE id=?', [id]) as Draft | undefined;
  if (!d) return;
  const merged = { ...d, ...patch, updatedAt: Date.now() };
  getDb().runSync(
    `UPDATE drafts SET orderNo=?, date=?, supplierName=?, items=?, totalAmount=?, paidAmount=?,
       discount=?, paid=?, arrivalDate=?, note=?, images=?, uploadedMap=?, purchaseDate=?, stockStatus=?, category=?, saveToStockIn=?, status=?, updatedAt=? WHERE id=?`,
    [
      merged.orderNo, merged.date, merged.supplierName, merged.items, merged.totalAmount,
      merged.paidAmount, merged.discount, merged.paid, merged.arrivalDate, merged.note,
      merged.images, merged.uploadedMap ?? '{}', merged.purchaseDate, merged.stockStatus,
      merged.category || '',
      merged.saveToStockIn ?? 0,
      merged.status, merged.updatedAt, id,
    ]
  );
}

// ============ 图片上传幂等（修复「上传一张得到六张」）============
//
// /api/upload 没有任何去重：同一张照片重复 POST 就重复插 image_resource 行，
// 而网页端单据图片是按 /api/images?orderNo= 渲染的，于是重试几次就显示几张。
// 这里把「本地 uri → 远端 url」持久化到草稿上，让重试复用已有结果，不再重复上传。

/** 读取某草稿已上传成功的照片映射；结构损坏时安全退化为空表 */
export function getUploadedMap(draftId: string): Record<string, string> {
  const row = getDb().getFirstSync('SELECT uploadedMap FROM drafts WHERE id=?', [draftId]) as
    | { uploadedMap: string | null }
    | undefined;
  if (!row?.uploadedMap) return {};
  try {
    const v = JSON.parse(row.uploadedMap);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/**
 * 记住一张照片的上传结果。
 * 必须「传完一张就落一张」——整批传完再写的话，中途进程被杀就前功尽弃，
 * 下一轮又会把已经传上去的照片重传一遍，重复行照样产生。
 */
export function rememberUploadedImage(draftId: string, localUri: string, remoteUrl: string) {
  const map = getUploadedMap(draftId);
  if (map[localUri] === remoteUrl) return;
  map[localUri] = remoteUrl;
  getDb().runSync('UPDATE drafts SET uploadedMap=?, updatedAt=? WHERE id=?', [
    JSON.stringify(map),
    Date.now(),
    draftId,
  ]);
}

// ============ 已同步数据本地缓存（v4：概览/明细/报表消费）============
// 手机端为临时录入端，连 LAN 时拉服务端快照存本地，离线读缓存

export interface CachedPurchase {
  id: string;
  orderNo: string;
  date: string;
  supplierName: string;
  totalAmount: number;
  paidAmount: number;
  paid: number;
  note: string;
  images: string; // JSON 数组
  category: string; // 进货类别：食品/水饮/百货/其他（可自定义）
  createdAt: number;
  raw: string; // 完整服务端对象 JSON
}

export interface CachedRevenue {
  id: string;
  date: string;
  total: number;
  note: string;
  payments: string; // JSON
  createdAt: number;
  raw: string;
}

function ensureCacheTables() {
  const db = getDb();
  db.execSync(`CREATE TABLE IF NOT EXISTS purchases_cache (
    id TEXT PRIMARY KEY, orderNo TEXT, date TEXT, supplierName TEXT,
    totalAmount REAL, paidAmount REAL, paid INTEGER, note TEXT,
    images TEXT, category TEXT, createdAt INTEGER, raw TEXT
  );`);
  const cacheCols = db.getAllSync('PRAGMA table_info(purchases_cache)') as { name: string }[];
  const hasCacheCol = (n: string) => cacheCols.some((c) => c.name === n);
  if (!hasCacheCol('category')) db.execSync("ALTER TABLE purchases_cache ADD COLUMN category TEXT DEFAULT ''");
  db.execSync(`CREATE TABLE IF NOT EXISTS revenues_cache (
    id TEXT PRIMARY KEY, date TEXT, total REAL, note TEXT,
    payments TEXT, createdAt INTEGER, raw TEXT
  );`);
  db.execSync(`CREATE TABLE IF NOT EXISTS cache_meta (
    key TEXT PRIMARY KEY, value TEXT
  );`);
}

function setMeta(key: string, value: string) {
  getDb().runSync('INSERT OR REPLACE INTO cache_meta (key, value) VALUES (?, ?)', [key, value]);
}

function getMeta(key: string): string | null {
  const row = getDb().getFirstSync('SELECT value FROM cache_meta WHERE key=?', [key]) as
    | { value: string }
    | undefined;
  return row ? row.value : null;
}

/** 连 LAN 时拉取服务端快照写入本地缓存；失败抛错由调用方处理 */
export async function fetchAndCacheSnapshot(baseUrl: string) {
  ensureCacheTables();
  const db = getDb();

  // 进货 / 营收快照：软失败，不阻塞后面的桶装水 downlink / 主数据 downlink。
  // 否则 PC 端这两个接口一旦出错，桶装水的 press/refund/type/stock 全拉不下来。
  let purList: any[] = [];
  let revList: any[] = [];
  try {
    const purRes = await apiFetch(`${baseUrl}/api/purchases`, { method: 'GET' });
    if (purRes.ok && purRes.json?.data) {
      purList = purRes.json.data;
      db.execSync('DELETE FROM purchases_cache');
    }
  } catch (e: any) {
    console.warn('[localDb] fetch purchases snapshot failed:', e?.message || e);
  }
  try {
    const revRes = await apiFetch(`${baseUrl}/api/revenue`, { method: 'GET' });
    if (revRes.ok && revRes.json?.data) {
      revList = revRes.json.data;
      db.execSync('DELETE FROM revenues_cache');
    }
  } catch (e: any) {
    console.warn('[localDb] fetch revenue snapshot failed:', e?.message || e);
  }

  for (const p of purList) {
    db.runSync(
      `INSERT INTO purchases_cache
       (id,orderNo,date,supplierName,totalAmount,paidAmount,paid,note,images,category,createdAt,raw)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        p.id, p.orderNo, p.date, p.supplierName || '',
        Number(p.totalAmount) || 0, Number(p.paidAmount) || 0, p.paid ? 1 : 0,
        p.note || '', JSON.stringify(p.images || []), p.category || '', Number(p.createdAt) || 0,
        JSON.stringify(p),
      ]
    );
  }

  for (const r of revList) {
    db.runSync(
      `INSERT INTO revenues_cache (id,date,total,note,payments,createdAt,raw)
       VALUES (?,?,?,?,?,?,?)`,
      [
        r.id, r.date, Number(r.total) || 0, r.note || '',
        JSON.stringify(r.payments || {}), Number(r.createdAt) || 0, JSON.stringify(r),
      ]
    );
  }

  // 营业日口径（今日→昨日）
  try {
    const ruleRes = await apiFetch(`${baseUrl}/api/display-rule`, { method: 'GET' });
    if (ruleRes.ok && ruleRes.json?.data) {
      setMeta('day_offset', String(ruleRes.json.data.offsetDays ?? 1));
    }
  } catch {
    /* 容错：沿用已有值 */
  }

  // 自定义收款渠道配置（网页端「自定义收款 1/2/3」写在 /api/settings）。
  // 缓存下来，RevenueForm / RecordDetail 才能离线同步渲染同一份渠道名。
  try {
    const setRes = await apiFetch(`${baseUrl}/api/settings`, { method: 'GET' });
    if (setRes.ok && setRes.json?.code === 0) {
      setCachedCustomChannels(normalizeCustomChannels(setRes.json.data?.customChannels));
    }
  } catch {
    /* 容错：沿用已有值 */
  }

  // ===== 主数据下行（PC → 移动端，PC 为准，本地为只读镜像）=====
  // 第一步仅做单向拉取：商品 / 供应商 / 分类 / 桶装水库存。
  // 移动端本地新增的草稿不回传 PC（第二步上行专项处理）。
  // 冲突策略：PC 为准——每次同步全量覆盖本地镜像（UPSERT）。
  let productsSynced = 0, suppliersSynced = 0, categoriesSynced = 0, barrelSynced = 0;
  const dbx = getDb();

  // 商品：本地 products.id 直接存 PC id，按 id UPSERT（批量 + 事务，避免 1.4w 条逐条卡 UI）
  try {
    const pRes = await apiFetch(`${baseUrl}/api/products`, { method: 'GET' });
    if (pRes.ok && Array.isArray(pRes.json?.data)) {
      const list = pRes.json.data as any[];
      ensureCatalogTables(); // 确保 products 表存在
      dbx.execSync('DELETE FROM products'); // PC 为准，先清空镜像
      const BATCH = 500;
      const esc = (v: string) => `'${String(v ?? '').replace(/'/g, "''")}'`;
      for (let i = 0; i < list.length; i += BATCH) {
        const batch = list.slice(i, i + BATCH);
        const values = batch
          .map(
            (p) =>
              `(${[
                Number(p.id) || 0,
                esc(p.name),
                esc(p.spec),
                esc(p.unit),
                esc(p.category),
                esc(p.brand),
                esc(p.supplierName),
                Number(p.purchasePrice) || 0,
                Number(p.retailPrice) || 0,
                Number(p.stockQty) || 0,
                Number(p.safetyStock) || 0,
                Number(p.shelfLifeDays) || 0,
                esc(p.remark),
                Number(p.createdAt) || 0,
              ].join(',')})`
          )
          .join(',');
        dbx.execSync(
          `BEGIN; INSERT OR REPLACE INTO products (id,name,spec,unit,categoryName,brand,supplierName,purchasePrice,retailPrice,stockQty,safetyStock,shelfLifeDays,note,createdAt) VALUES ${values}; COMMIT;`
        );
        productsSynced += batch.length;
      }
    }
  } catch { /* 容错：本次同步其余部分仍可用 */ }

  // 供应商：PC 无稳定 id 对齐，本地 name 非 UNIQUE，故全量覆盖（先清后插，PC 为准，批量）
  try {
    const sRes = await apiFetch(`${baseUrl}/api/suppliers`, { method: 'GET' });
    if (sRes.ok && Array.isArray(sRes.json?.data)) {
      const list = sRes.json.data as any[];
      ensureCatalogTables();
      dbx.execSync('DELETE FROM suppliers');
      const BATCH = 200;
      const esc = (v: string) => `'${String(v ?? '').replace(/'/g, "''")}'`;
      for (let i = 0; i < list.length; i += BATCH) {
        const batch = list.slice(i, i + BATCH);
        const values = batch
          .filter((s: any) => (s.name || '').trim())
          .map(
            (s: any) =>
              `(${[
                esc(s.name),
                esc(s.contact),
                esc(s.phone),
                esc(s.address),
                esc(s.note),
                Number(s.createdAt) || 0,
              ].join(',')})`
          )
          .join(',');
        if (values) {
          dbx.execSync(
            `BEGIN; INSERT INTO suppliers (name, contact, phone, address, note, createdAt) VALUES ${values}; COMMIT;`
          );
          suppliersSynced += batch.filter((s: any) => (s.name || '').trim()).length;
        }
      }
    }
  } catch { /* 容错 */ }

  // 分类：PC 从 product.category DISTINCT 聚合；本地按 name 补（不删本地草稿分类，批量）
  try {
    const cRes = await apiFetch(`${baseUrl}/api/categories`, { method: 'GET' });
    if (cRes.ok && Array.isArray(cRes.json?.data)) {
      const list = cRes.json.data as any[];
      ensureCatalogTables();
      const esc = (v: string) => `'${String(v ?? '').replace(/'/g, "''")}'`;
      const values = list
        .filter((c: any) => (c.name || '').trim())
        .map((c: any) => `(${esc(c.name)}, ${Date.now()})`)
        .join(',');
      if (values) {
        dbx.execSync(
          `BEGIN; INSERT OR IGNORE INTO categories (name, createdAt) VALUES ${values}; COMMIT;`
        );
        categoriesSynced = list.filter((c: any) => (c.name || '').trim()).length;
      }
    }
  } catch { /* 容错 */ }

  // 桶装水库存：只同步 PC 的「在库 inStore」，保留手机本地「在押 inUse」。
  // 原因：手机端也要独立做压桶/退桶登记，若按 PC 为准全量覆盖 inUse，用户刚登记的压桶数据会被同步瞬间抹掉。
  try {
    const bRes = await apiFetch(`${baseUrl}/api/barrel/stock`, { method: 'GET' });
    if (bRes.ok && Array.isArray(bRes.json?.data)) {
      const list = bRes.json.data as any[];
      ensureBarrelTables();
      const esc = (v: string) => `'${String(v ?? '').replace(/'/g, "''")}'`;
      const now = Date.now();
      const values = list
        .filter((b: any) => (b.type || '').trim())
        .map((b: any) => {
          const type = esc(b.type);
          return `(${type}, ${Number(b.inStore) || 0}, COALESCE((SELECT inUse FROM barrel_stock WHERE type = ${type}), 0), ${now})`;
        })
        .join(',');
      if (values) {
        dbx.execSync(
          `BEGIN; INSERT INTO barrel_stock (type, inStore, inUse, updatedAt) VALUES ${values} ON CONFLICT(type) DO UPDATE SET inStore=excluded.inStore, updatedAt=excluded.updatedAt; COMMIT;`
        );
        barrelSynced = list.filter((b: any) => (b.type || '').trim()).length;
      }
    }
  } catch { /* 容错 */ }

  // 桶装水业务记录下行：拉 PC 的压桶 / 退桶，按业务单号 no 去重合并。
  // 与上面「主数据全量覆盖」不同：业务记录手机端可能离线先登记，不能全量覆盖，否则刚登记的会被抹掉。
  // 但 PC 端已删除（软删）的记录，手机端必须跟着清：先删掉本地 synced=1（即从 PC 下来的）记录，
  // 再重新拉 PC 全量；本地 synced=0 的草稿保留不动。
  try {
    ensureBarrelTables();
    db.execSync('BEGIN; DELETE FROM barrel_press WHERE synced=1; DELETE FROM barrel_refund WHERE synced=1; COMMIT;');
  } catch (e: any) {
    console.warn('[localDb] clear synced barrel records failed:', e?.message || e);
  }
  try {
    console.log('[localDb] fetching barrel press from', `${baseUrl}/api/barrel/press`);
    const pRes = await apiFetch(`${baseUrl}/api/barrel/press`, { method: 'GET' });
    const pressDataLen = Array.isArray(pRes.json?.data) ? pRes.json.data.length : 'N/A';
    console.log('[localDb] barrel press response ok=', pRes.ok, 'data.length=', pressDataLen, 'jsonType=', typeof pRes.json, 'textPreview=', (pRes.text || '').slice(0, 80));
    if (pRes.ok && Array.isArray(pRes.json?.data)) {
      const added = mergeBarrelPressFromRemote(pRes.json.data);
      barrelSynced += added;
      console.log('[localDb] barrel press merged:', added);
    } else if (pRes.ok) {
      console.warn('[localDb] barrel press response is 200 but not a valid {data:[]} payload. Wrong port?');
    }
  } catch (e: any) {
    console.warn('[localDb] fetch barrel press failed:', e?.message || e);
  }
  try {
    console.log('[localDb] fetching barrel refund from', `${baseUrl}/api/barrel/refund`);
    const rRes = await apiFetch(`${baseUrl}/api/barrel/refund`, { method: 'GET' });
    const refundDataLen = Array.isArray(rRes.json?.data) ? rRes.json.data.length : 'N/A';
    console.log('[localDb] barrel refund response ok=', rRes.ok, 'data.length=', refundDataLen, 'jsonType=', typeof rRes.json, 'textPreview=', (rRes.text || '').slice(0, 80));
    if (rRes.ok && Array.isArray(rRes.json?.data)) {
      const added = mergeBarrelRefundFromRemote(rRes.json.data);
      barrelSynced += added;
      console.log('[localDb] barrel refund merged:', added);
    } else if (rRes.ok) {
      console.warn('[localDb] barrel refund response is 200 but not a valid {data:[]} payload. Wrong port?');
    }
  } catch (e: any) {
    console.warn('[localDb] fetch barrel refund failed:', e?.message || e);
  }

  // 桶类型：PC 有则按 name 覆盖/补充到本地（UPSERT），让 PC 真实押金金额生效。
  // 不采用先删后插：PC 的 barrelTypes 可能为空，全量覆盖会清空手机本地已有类型。
  try {
    const tRes = await apiFetch(`${baseUrl}/api/barrel/type`, { method: 'GET' });
    if (tRes.ok && Array.isArray(tRes.json?.data)) {
      const list = tRes.json.data as any[];
      ensureBarrelTables();
      const esc = (v: string) => `'${String(v ?? '').replace(/'/g, "''")}'`;
      const values = list
        .filter((t: any) => (t.name || '').trim())
        .map((t: any) => `(${esc(t.name)}, ${esc(t.material || '')}, ${Number(t.deposit) || 0}, '${t.status === 'disabled' ? 'disabled' : 'active'}')`)
        .join(',');
      if (values) {
        dbx.execSync(
          `BEGIN; INSERT INTO barrel_types (name, material, deposit, status) VALUES ${values} ` +
          `ON CONFLICT(name) DO UPDATE SET material=excluded.material, deposit=excluded.deposit, status=excluded.status; COMMIT;`
        );
      }
    }
  } catch { /* 容错 */ }
  // 客户档案（/api/barrel/customer）PC 端有、手机端无对应存储（压桶客户为自由文本），暂不同步。

  // 下行合并完 PC 的压桶/退桶/库存后，统一重算在押：
  // 以有效单号 no 为准，旧版空 no 脏数据不再影响库存，从而与 PC 真实数据对齐。
  // 包 try/catch：重算异常绝不该掐断整段下行同步（否则后续商品/供应商镜像也就位了但同步报错）。
  try { recalcBarrelStockInUse(); } catch (e) { console.warn('[localDb] recalc after downlink failed:', e); }

  const ts = Date.now();
  setMeta('last_sync', String(ts));
  return {
    purchases: purList.length, revenues: revList.length, ts,
    products: productsSynced, suppliers: suppliersSynced,
    categories: categoriesSynced, barrelStock: barrelSynced,
  };
}

export function getCachedPurchases(): CachedPurchase[] {
  ensureCacheTables();
  return getDb().getAllSync(
    'SELECT * FROM purchases_cache ORDER BY date DESC, createdAt DESC'
  ) as CachedPurchase[];
}

export function getCachedRevenues(): CachedRevenue[] {
  ensureCacheTables();
  return getDb().getAllSync(
    'SELECT * FROM revenues_cache ORDER BY date DESC, createdAt DESC'
  ) as CachedRevenue[];
}

export function getLastSync(): number {
  const v = getMeta('last_sync');
  return v ? Number(v) : 0;
}

export function getDayOffset(): number {
  const v = getMeta('day_offset');
  return v ? Number(v) : 1;
}

// ============ 自定义收款渠道缓存 ============
// 单一数据源：服务端 /api/settings.customChannels。
// 缓存在 cache_meta 里，让 RevenueForm / RecordDetail 能同步读取（不必等异步请求），
// 离线时也能沿用上一次的渠道名。

export function setCachedCustomChannels(list: CustomChannel[]) {
  ensureCacheTables();
  setMeta('custom_channels', JSON.stringify(list));
}

/** 全部自定义渠道（含被禁用的）；缓存缺失/损坏时回退到与网页端一致的默认配置 */
export function getCachedCustomChannels(): CustomChannel[] {
  ensureCacheTables();
  const v = getMeta('custom_channels');
  if (!v) return DEFAULT_CUSTOM_CHANNELS;
  try {
    return normalizeCustomChannels(JSON.parse(v));
  } catch {
    return DEFAULT_CUSTOM_CHANNELS;
  }
}

/** 仅「启用」的自定义渠道——录入页动态渲染金额输入框用的就是这份 */
export function getEnabledCustomChannels(): CustomChannel[] {
  return getCachedCustomChannels().filter((c) => c.enabled !== false);
}

// ============ 营收暂存（刻意不上传，区别于 revenue_drafts 待同步队列）============
//
// 用户语义（对照网页端「暂存」按钮）：营业录入有时只录了一半（比如只有日期+现金，
// 微信/支付宝还没数），想先"暂存"下来关掉，下次回来接着录，录完才点"保存营收"上传。
// 它**不能进 revenue_drafts**——那张表会被 syncEngine 当成待同步草稿自动 POST 出去，
// 等于没录完就传了。所以暂存单独存在 cache_meta 里（key 'revenue_stash'），
// syncEngine 只认草稿表，永远碰不到这个 key，物理上隔离。
// 同一时刻只保留一份暂存（覆盖式），符合"当前正在录的那一笔没录完"的语义。

export interface RevenueStash {
  date: string;
  cash: string;
  wechat: string;
  alipay: string;
  customAmounts: Record<string, string>;
  note: string;
  savedAt: number;
}

export function setRevenueStash(stash: RevenueStash | null): void {
  ensureCacheTables();
  if (stash === null) {
    getDb().runSync('DELETE FROM cache_meta WHERE key=?', ['revenue_stash']);
    return;
  }
  setMeta('revenue_stash', JSON.stringify(stash));
}

export function getRevenueStash(): RevenueStash | null {
  ensureCacheTables();
  const v = getMeta('revenue_stash');
  if (!v) return null;
  try {
    const p = JSON.parse(v);
    return p && typeof p === 'object' && !Array.isArray(p) ? (p as RevenueStash) : null;
  } catch {
    return null;
  }
}

// ============ 电器保修（本地，手机端极简版）============
// 仅「购买登记」+「设备查询」两项；完整报修工单流程在 PC 端。
// 纯本地 SQLite，无后端依赖，离线可用，重装/清数据即清空。
export interface WarrantyDevice {
  id: string; // uuid
  customerName: string;
  customerPhone: string;
  brand: string; // 品牌
  model: string; // 型号
  serialNo: string; // 设备号 / 序列号
  purchaseDate: string; // YYYY-MM-DD
  warrantyMonths: number; // 保修月数
  price: number; // 购价（元）
  note: string;
  createdAt: number;
}

/** 保修到期日 = 购买日 + 保修月数（按自然月进位） */
export function warrantyEndDate(d: Pick<WarrantyDevice, 'purchaseDate' | 'warrantyMonths'>): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d.purchaseDate);
  if (!m) return '';
  const dt = new Date(Number(m[1]), Number(m[2]) - 1 + d.warrantyMonths, Number(m[3]));
  return toLocalDateStr(dt);
}

export type WarrantyStatus = '在保' | '即将到期' | '已过保';

/** 距到期 ≤30 天视为「即将到期」 */
const WARRANTY_NEAR_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * 由购买日 + 保修月数推导保修状态。
 * 与 PC 端 device.warrantyStatus 口径一致：在保 / 即将到期(30天内) / 已过保。
 */
export function getWarrantyStatus(d: Pick<WarrantyDevice, 'purchaseDate' | 'warrantyMonths'>): {
  status: WarrantyStatus;
  endDate: string;
} {
  const endDate = warrantyEndDate(d);
  if (!endDate) return { status: '已过保', endDate: '' };
  const end = new Date(endDate + 'T00:00:00').getTime();
  const now = Date.now();
  if (end < now) return { status: '已过保', endDate };
  if (end - now <= WARRANTY_NEAR_MS) return { status: '即将到期', endDate };
  return { status: '在保', endDate };
}

function ensureWarrantyTable() {
  getDb().execSync(`CREATE TABLE IF NOT EXISTS warranty_devices (
    id TEXT PRIMARY KEY,
    customerName TEXT,
    customerPhone TEXT,
    brand TEXT,
    model TEXT,
    serialNo TEXT,
    purchaseDate TEXT,
    warrantyMonths INTEGER,
    price REAL,
    note TEXT,
    createdAt INTEGER
  );`);
}

export function insertWarrantyDevice(d: WarrantyDevice) {
  getDb().runSync(
    `INSERT OR REPLACE INTO warranty_devices
     (id,customerName,customerPhone,brand,model,serialNo,purchaseDate,warrantyMonths,price,note,createdAt)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [
      d.id, d.customerName, d.customerPhone, d.brand, d.model, d.serialNo,
      d.purchaseDate, d.warrantyMonths, d.price, d.note, d.createdAt,
    ]
  );
}

export function getAllWarrantyDevices(): WarrantyDevice[] {
  ensureWarrantyTable();
  return getDb().getAllSync(
    'SELECT * FROM warranty_devices ORDER BY createdAt DESC'
  ) as WarrantyDevice[];
}

export function getWarrantyDeviceById(id: string): WarrantyDevice | undefined {
  ensureWarrantyTable();
  return getDb().getFirstSync('SELECT * FROM warranty_devices WHERE id=?', [id]) as
    | WarrantyDevice
    | undefined;
}

/**
 * 设备查询：按客户名 / 电话 / 品牌 / 型号 / 序列号模糊匹配。
 * 空关键字返回全部（按登记时间倒序）。
 */
export function searchWarrantyDevices(kw: string): WarrantyDevice[] {
  ensureWarrantyTable();
  const trimmed = kw.trim();
  if (!trimmed) return getAllWarrantyDevices();
  const like = `%${trimmed}%`;
  return getDb().getAllSync(
    `SELECT * FROM warranty_devices
     WHERE customerName LIKE ? OR customerPhone LIKE ? OR brand LIKE ?
        OR model LIKE ? OR serialNo LIKE ?
     ORDER BY createdAt DESC`,
    [like, like, like, like, like]
  ) as WarrantyDevice[];
}

export function deleteWarrantyDevice(id: string) {
  ensureWarrantyTable();
  getDb().runSync('DELETE FROM warranty_devices WHERE id=?', [id]);
}

// ============ 桶装水（手机端极简版：压桶/退桶登记 + 押金流水 + 桶库存）============
// 领域模型对齐 PC 端 BarrelWater（retail-admin/src/api/barrel.ts + pages/BarrelWater/*）：
//   - BarrelType    桶类型（名称/押金单价）
//   - BarrelPress   压桶登记（客户/日期/桶明细/押金/收款/找零）
//   - BarrelRefund  退桶登记（关联压桶单/客户/日期/桶明细/扣减/实退）
//   - BarrelStock   桶库存（按桶类型：inStore 用户维护、inUse 随压退自动维护）
// 报表（押金流水）按 PC 惯例从 press+refund 派生，不冗余存储。
// 手机端不接 PC 端「采购入库」流程：inStore 在「桶库存」页由用户直接维护。
export interface BarrelType {
  id: number;
  name: string;
  material: string; // 材质
  deposit: number;  // 桶押金单价（元/桶）
  status: 'active' | 'disabled';
}

export interface BarrelPressItem {
  barrel: string;     // 桶类型名
  count: number;
  unitPrice: number;  // 押金单价（与桶类型 deposit 同步，可微调）
}

export interface BarrelPress {
  id: string; // uuid
  no: string; // YT+日期+3位序号
  customer: string;
  phone: string;
  handler: string;
  date: string; // YYYY-MM-DD
  items: BarrelPressItem[]; // JSON
  totalDeposit: number; // 押金合计
  received: number;     // 收款
  change: number;       // 找零
  note: string;
  createdAt: number;
}

export interface BarrelRefundItem {
  barrel: string;
  count: number;
  unitPrice: number;
  deduct: number; // 扣减损耗
}

export interface BarrelRefund {
  id: string;
  no: string; // TK+...
  pressNo: string; // 关联压桶单
  customer: string;
  phone: string;
  date: string;
  items: BarrelRefundItem[];
  totalDeduct: number;
  refund: number; // 实退
  note: string;
  createdAt: number;
}

export interface BarrelStockRow {
  type: string;       // 桶类型名（PK）
  inStore: number;    // 在库（用户维护）
  inUse: number;      // 在押（自动维护）
  updatedAt: number;
}

// 单号：YT/TK + 日期(YYYYMMDD) + 3 位随机序列
function genBarrelNo(prefix: 'YT' | 'TK', date: string): string {
  return `${prefix}${date.replace(/-/g, '')}${String(Math.floor(100 + Math.random() * 900))}`;
}

function ensureBarrelTables() {
  const db = getDb();
  db.execSync(`CREATE TABLE IF NOT EXISTS barrel_types (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE,
    material TEXT,
    deposit REAL DEFAULT 0,
    status TEXT DEFAULT 'active'
  );`);
  db.execSync(`CREATE TABLE IF NOT EXISTS barrel_press (
    id TEXT PRIMARY KEY,
    no TEXT, customer TEXT, phone TEXT, handler TEXT, date TEXT,
    items TEXT, totalDeposit REAL, received REAL, change REAL,
    note TEXT, createdAt INTEGER,
    synced INTEGER DEFAULT 0
  );`);
  db.execSync(`CREATE TABLE IF NOT EXISTS barrel_refund (
    id TEXT PRIMARY KEY,
    no TEXT, pressNo TEXT, customer TEXT, phone TEXT, date TEXT,
    items TEXT, totalDeduct REAL, refund REAL,
    note TEXT, createdAt INTEGER,
    synced INTEGER DEFAULT 0
  );`);
  db.execSync(`CREATE TABLE IF NOT EXISTS barrel_stock (
    type TEXT PRIMARY KEY,
    inStore INTEGER DEFAULT 0,
    inUse INTEGER DEFAULT 0,
    updatedAt INTEGER
  );`);
  // 种子：3 个常见 18L 桶类型（对齐 PC STOCK_TYPES）
  const row = db.getFirstSync('SELECT COUNT(*) AS c FROM barrel_types') as { c: number };
  if (row.c === 0) {
    const seeds: Pick<BarrelType, 'name' | 'material' | 'deposit'>[] = [
      { name: '18L云湾桶', material: 'PC', deposit: 30 },
      { name: '18L送福桶', material: 'PC', deposit: 30 },
      { name: '18L高路达桶', material: 'PC', deposit: 30 },
    ];
    seeds.forEach((s) => {
      db.runSync('INSERT INTO barrel_types (name, material, deposit, status) VALUES (?, ?, ?, ?)',
        [s.name, s.material, s.deposit, 'active']);
    });
  }
  // 升级补列：旧库 barrel_press / barrel_refund 可能没有 synced 列（双向同步所需）
  try { db.execSync('ALTER TABLE barrel_press ADD COLUMN synced INTEGER DEFAULT 0'); } catch { /* 已存在则忽略 */ }
  try { db.execSync('ALTER TABLE barrel_refund ADD COLUMN synced INTEGER DEFAULT 0'); } catch { /* 已存在则忽略 */ }
}

function safeParsePressItems(raw: string): BarrelPressItem[] {
  try { const p = JSON.parse(raw); return Array.isArray(p) ? p : []; } catch { return []; }
}
function safeParseRefundItems(raw: string): BarrelRefundItem[] {
  try { const p = JSON.parse(raw); return Array.isArray(p) ? p : []; } catch { return []; }
}

export function getAllBarrelTypes(): BarrelType[] {
  ensureBarrelTables();
  return getDb().getAllSync('SELECT * FROM barrel_types WHERE status=? ORDER BY id', ['active']) as BarrelType[];
}

export function insertBarrelPress(p: BarrelPress, synced = 0, skipRecalc = false) {
  ensureBarrelTables();
  const db = getDb();
  db.runSync(
    `INSERT OR REPLACE INTO barrel_press
     (id,no,customer,phone,handler,date,items,totalDeposit,received,change,note,createdAt,synced)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [p.id, p.no, p.customer, p.phone, p.handler, p.date, JSON.stringify(p.items),
     p.totalDeposit, p.received, p.change, p.note, p.createdAt, synced]
  );
  // 维护 inUse：重算而非累加，避免脏数据/同步合并导致重复记账。
  // 包 try/catch：重算失败绝不影响"记录已写入"这一事实，避免表单误报保存失败。
  // skipRecalc=true 用于批量下行合并：等全部插入完再统一 recalc，避免 O(n²) SQL。
  if (!skipRecalc) {
    try { recalcBarrelStockInUse(); } catch (e) { console.warn('[localDb] recalc after insert press failed:', e); }
  }
}

export function getAllBarrelPress(): BarrelPress[] {
  ensureBarrelTables();
  const rows = getDb().getAllSync('SELECT * FROM barrel_press ORDER BY createdAt DESC') as Array<Omit<BarrelPress, 'items'> & { items: string }>;
  return rows.map((r) => ({ ...r, items: safeParsePressItems(r.items) }));
}

export function searchBarrelPress(kw: string): BarrelPress[] {
  ensureBarrelTables();
  const trimmed = kw.trim();
  if (!trimmed) return getAllBarrelPress();
  const like = `%${trimmed}%`;
  const rows = getDb().getAllSync(
    `SELECT * FROM barrel_press
     WHERE no LIKE ? OR customer LIKE ? OR phone LIKE ?
     ORDER BY createdAt DESC`,
    [like, like, like]
  ) as Array<Omit<BarrelPress, 'items'> & { items: string }>;
  return rows.map((r) => ({ ...r, items: safeParsePressItems(r.items) }));
}

export function deleteBarrelPress(id: string) {
  ensureBarrelTables();
  const row = getDb().getFirstSync('SELECT items FROM barrel_press WHERE id=?', [id]) as { items: string } | undefined;
  if (!row) return;
  getDb().runSync('DELETE FROM barrel_press WHERE id=?', [id]);
  try { recalcBarrelStockInUse(); } catch (e) { console.warn('[localDb] recalc after delete press failed:', e); }
}

export function insertBarrelRefund(r: BarrelRefund, synced = 0, skipRecalc = false) {
  ensureBarrelTables();
  const db = getDb();
  db.runSync(
    `INSERT OR REPLACE INTO barrel_refund
     (id,no,pressNo,customer,phone,date,items,totalDeduct,refund,note,createdAt,synced)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [r.id, r.no, r.pressNo, r.customer, r.phone, r.date, JSON.stringify(r.items),
     r.totalDeduct, r.refund, r.note, r.createdAt, synced]
  );
  // skipRecalc=true 用于批量下行合并：等全部插入完再统一 recalc，避免 O(n²) SQL。
  if (!skipRecalc) {
    try { recalcBarrelStockInUse(); } catch (e) { console.warn('[localDb] recalc after insert refund failed:', e); }
  }
}

export function getAllBarrelRefund(): BarrelRefund[] {
  ensureBarrelTables();
  const rows = getDb().getAllSync('SELECT * FROM barrel_refund ORDER BY createdAt DESC') as Array<Omit<BarrelRefund, 'items'> & { items: string }>;
  return rows.map((r) => ({ ...r, items: safeParseRefundItems(r.items) }));
}

// ============ 桶装水双向同步辅助 ============
// 上行：取本地未同步（synced=0）的压桶 / 退桶记录，由 syncEngine 推到 PC。
export function getUnsyncedBarrelPress(): BarrelPress[] {
  ensureBarrelTables();
  const rows = getDb().getAllSync('SELECT * FROM barrel_press WHERE synced=0 OR synced IS NULL ORDER BY createdAt ASC') as Array<Omit<BarrelPress, 'items'> & { items: string }>;
  return rows.map((r) => ({ ...r, items: safeParsePressItems(r.items) }));
}
export function getUnsyncedBarrelRefund(): BarrelRefund[] {
  ensureBarrelTables();
  const rows = getDb().getAllSync('SELECT * FROM barrel_refund WHERE synced=0 OR synced IS NULL ORDER BY createdAt ASC') as Array<Omit<BarrelRefund, 'items'> & { items: string }>;
  return rows.map((r) => ({ ...r, items: safeParseRefundItems(r.items) }));
}
export function getUnsyncedBarrelPressCount(): number {
  ensureBarrelTables();
  const row = getDb().getFirstSync('SELECT COUNT(*) AS c FROM barrel_press WHERE synced=0 OR synced IS NULL') as { c: number } | undefined;
  return row?.c ?? 0;
}
export function getUnsyncedBarrelRefundCount(): number {
  ensureBarrelTables();
  const row = getDb().getFirstSync('SELECT COUNT(*) AS c FROM barrel_refund WHERE synced=0 OR synced IS NULL') as { c: number } | undefined;
  return row?.c ?? 0;
}
export function markBarrelPressSynced(id: string) {
  ensureBarrelTables();
  getDb().runSync('UPDATE barrel_press SET synced=1 WHERE id=?', [id]);
}
export function markBarrelRefundSynced(id: string) {
  ensureBarrelTables();
  getDb().runSync('UPDATE barrel_refund SET synced=1 WHERE id=?', [id]);
}

// 下行：把 PC 的压桶 / 退桶记录按服务端 id 合并进本地。
// 已存在同 id 的 PC 记录会被覆盖，保证与 PC 完全一致；
// 仅当本地存在同 no 的未同步草稿（synced=0）时才跳过远端该条，避免覆盖用户离线录入的内容。
function remotePressToLocal(pc: any): BarrelPress {
  return {
    id: `pc-${pc.id}`,
    no: pc.no || '',
    customer: pc.customer || '',
    phone: pc.phone || '',
    handler: pc.handler || '',
    date: pc.date,
    items: (Array.isArray(pc.items) ? pc.items : []).map((i: any) => ({
      barrel: i.barrel, count: Number(i.count) || 0, unitPrice: Number(i.unitPrice) || 0,
    })),
    totalDeposit: Number(pc.deposit) || Number(pc.totalDeposit) || 0,
    received: pc.paid != null ? Number(pc.paid) : 0,
    change: (pc.paid != null ? Number(pc.paid) : 0) - (Number(pc.deposit) || 0),
    note: '',
    createdAt: pc.createdAt ? new Date(pc.createdAt).getTime() : Date.now(),
  };
}
function remoteRefundToLocal(rpc: any): BarrelRefund {
  return {
    id: `pc-${rpc.id}`,
    no: rpc.no || '',
    pressNo: rpc.pressNo || '',
    customer: rpc.customer || '',
    phone: rpc.phone || '',
    date: rpc.date,
    items: (Array.isArray(rpc.items) ? rpc.items : []).map((i: any) => ({
      barrel: i.barrel, count: Number(i.count) || 0, unitPrice: Number(i.unitPrice) || 0, deduct: 0,
    })),
    totalDeduct: Number(rpc.deduct) || 0,
    refund: Number(rpc.refund) || 0,
    note: '',
    createdAt: rpc.createdAt ? new Date(rpc.createdAt).getTime() : Date.now(),
  };
}
export function mergeBarrelPressFromRemote(list: any[]): number {
  ensureBarrelTables();
  let added = 0;
  let replaced = 0;
  let skippedDraft = 0;
  let skippedEmpty = 0;
  for (const pc of list || []) {
    if (!pc || !pc.id) { skippedEmpty++; continue; }
    // 本地未同步草稿优先保留：远端同 no 且本地 synced=0 时跳过，避免覆盖离线录入
    if (pc.no) {
      const localDraft = getDb().getFirstSync(
        'SELECT 1 FROM barrel_press WHERE no=? AND (synced=0 OR synced IS NULL)',
        [pc.no]
      );
      if (localDraft) { skippedDraft++; continue; }
    }
    const localId = `pc-${pc.id}`;
    const exist = getDb().getFirstSync('SELECT 1 FROM barrel_press WHERE id=?', [localId]);
    insertBarrelPress(remotePressToLocal(pc), 1, true); // 批量：先不重算
    if (exist) replaced++; else added++;
  }
  console.log('[localDb] mergeBarrelPressFromRemote stats: input=', list?.length, 'added=', added, 'replaced=', replaced, 'skippedDraft=', skippedDraft, 'skippedEmptyId=', skippedEmpty);
  // 批量插入完成后再统一重算，避免每条都重算导致 O(n²) SQL 阻塞真机。
  if (added > 0 || replaced > 0) {
    try { recalcBarrelStockInUse(); } catch (e) { console.warn('[localDb] recalc after merge press failed:', e); }
  }
  return added;
}
export function mergeBarrelRefundFromRemote(list: any[]): number {
  ensureBarrelTables();
  let added = 0;
  let replaced = 0;
  let skippedDraft = 0;
  let skippedEmpty = 0;
  for (const rpc of list || []) {
    if (!rpc || !rpc.id) { skippedEmpty++; continue; }
    if (rpc.no) {
      const localDraft = getDb().getFirstSync(
        'SELECT 1 FROM barrel_refund WHERE no=? AND (synced=0 OR synced IS NULL)',
        [rpc.no]
      );
      if (localDraft) { skippedDraft++; continue; }
    }
    const localId = `pc-${rpc.id}`;
    const exist = getDb().getFirstSync('SELECT 1 FROM barrel_refund WHERE id=?', [localId]);
    insertBarrelRefund(remoteRefundToLocal(rpc), 1, true);
    if (exist) replaced++; else added++;
  }
  console.log('[localDb] mergeBarrelRefundFromRemote stats: input=', list?.length, 'added=', added, 'replaced=', replaced, 'skippedDraft=', skippedDraft, 'skippedEmptyId=', skippedEmpty);
  if (added > 0 || replaced > 0) {
    try { recalcBarrelStockInUse(); } catch (e) { console.warn('[localDb] recalc after merge refund failed:', e); }
  }
  return added;
}

// 重新计算在押数量：与 PC 端保持一致，所有非删除记录都参与统计。
// 旧版按 no 过滤会漏掉 PC 已计入但 no 为空/重复的脏数据，导致手机在押数量偏少。
export function recalcBarrelStockInUse() {
  ensureBarrelTables();
  const db = getDb();
  db.runSync('UPDATE barrel_stock SET inUse = 0');
  const pressRows = db.getAllSync(
    "SELECT items FROM barrel_press"
  ) as { items: string }[];
  for (const row of pressRows) {
    const items = safeParsePressItems(row.items);
    for (const it of items) {
      if (!it.barrel || !(it.count > 0)) continue;
      db.runSync(
        `INSERT INTO barrel_stock (type, inStore, inUse, updatedAt) VALUES (?, 0, ?, ?)
         ON CONFLICT(type) DO UPDATE SET inUse = inUse + ?, updatedAt = ?`,
        [it.barrel, it.count, Date.now(), it.count, Date.now()]
      );
    }
  }
  const refundRows = db.getAllSync(
    "SELECT items FROM barrel_refund"
  ) as { items: string }[];
  for (const row of refundRows) {
    const items = safeParseRefundItems(row.items);
    for (const it of items) {
      if (!it.barrel || !(it.count > 0)) continue;
      db.runSync(
        `INSERT INTO barrel_stock (type, inStore, inUse, updatedAt) VALUES (?, 0, 0, ?)
         ON CONFLICT(type) DO UPDATE SET inUse = MAX(0, inUse - ?), updatedAt = ?`,
        [it.barrel, Date.now(), it.count, Date.now()]
      );
    }
  }
  // 调试用：打印本次重算看到的记录数和各类型在押。
  const summary = db.getAllSync('SELECT type, inUse FROM barrel_stock WHERE inUse > 0 ORDER BY type') as { type: string; inUse: number }[];
  console.log('[localDb] recalcBarrelStockInUse: pressRows=', pressRows.length, 'refundRows=', refundRows.length, 'inUse>0:', summary.map((s) => `${s.type}:${s.inUse}`).join(','));
}

// 清理测试压桶/退桶数据：按客户名或桶类型匹配，常用于验收后清脏数据。
// 返回 {pressRemoved, refundRemoved}。
export function clearTestBarrelRecords(): { pressRemoved: number; refundRemoved: number } {
  ensureBarrelTables();
  const db = getDb();
  const testCustomers = ['手机测试2', '手机测试3', '手机测试4', '测试', '验收客户'];
  const testBarrels = ['验证桶_TEST2', '验证桶_TEST', 'TEST2'];
  const esc = (v: string) => `'${String(v).replace(/'/g, "''")}'`;
  const likeCustomers = testCustomers.map((c) => `%${c}%`);
  const likeBarrels = testBarrels.map((b) => `%${b}%`);

  // 先根据 items JSON 里的桶类型匹配（items 存的是 JSON 字符串）
  const pressItemsMatch = likeBarrels.map((pat) => `items LIKE ${esc(pat)}`).join(' OR ');
  const refundItemsMatch = likeBarrels.map((pat) => `items LIKE ${esc(pat)}`).join(' OR ');

  const pressWhere = likeCustomers.map((pat) => `customer LIKE ${esc(pat)}`).join(' OR ') +
    (pressItemsMatch ? ` OR ${pressItemsMatch}` : '');
  const refundWhere = likeCustomers.map((pat) => `customer LIKE ${esc(pat)}`).join(' OR ') +
    (refundItemsMatch ? ` OR ${refundItemsMatch}` : '');

  const pressBefore = db.getFirstSync(`SELECT COUNT(*) AS c FROM barrel_press WHERE ${pressWhere}`) as { c: number } | undefined;
  const refundBefore = db.getFirstSync(`SELECT COUNT(*) AS c FROM barrel_refund WHERE ${refundWhere}`) as { c: number } | undefined;

  db.runSync(`DELETE FROM barrel_press WHERE ${pressWhere}`);
  db.runSync(`DELETE FROM barrel_refund WHERE ${refundWhere}`);

  recalcBarrelStockInUse();
  return {
    pressRemoved: pressBefore?.c ?? 0,
    refundRemoved: refundBefore?.c ?? 0,
  };
}

// 桶库存：在库用户编辑；在押自动维护
export function getAllBarrelStock(): BarrelStockRow[] {
  ensureBarrelTables();
  // 改为从 barrel_stock 本身读取所有类型，而不是只读 barrel_types 中 active 的类型。
  // 原因：PC 端会按业务记录实时计算任意桶类型的在押（如"验证桶_TEST2"），手机端下行同步后
  // recalcBarrelStockInUse 也会把这些类型写入 barrel_stock。如果这里只显示 active 桶类型，
  // 首页汇总和明细都会漏掉这些在押，导致与 PC 端数字对不上。
  const rows = getDb().getAllSync(
    `SELECT type, COALESCE(inStore, 0) AS inStore, COALESCE(inUse, 0) AS inUse,
            COALESCE(updatedAt, 0) AS updatedAt
     FROM barrel_stock
     WHERE inStore > 0 OR inUse > 0
     ORDER BY type`
  ) as BarrelStockRow[];
  return rows;
}

export function updateBarrelStockInStore(type: string, inStore: number) {
  ensureBarrelTables();
  const now = Date.now();
  getDb().runSync(
    `INSERT INTO barrel_stock (type, inStore, inUse, updatedAt) VALUES (?, ?, 0, ?)
     ON CONFLICT(type) DO UPDATE SET inStore = ?, updatedAt = ?`,
    [type, inStore, now, inStore, now]
  );
}

// 押金流水：聚合压桶 + 退桶，按 createdAt 倒序（同一天记录也按真实时间排，最新在最上）
export interface DepositFlowRow {
  key: string;
  no: string;
  date: string;
  createdAt: number;
  type: 'press' | 'refund';
  customer: string;
  amount: number; // 压桶正 / 退桶负
  remark: string;
}

export function getDepositFlows(): DepositFlowRow[] {
  ensureBarrelTables();
  const pressList = getAllBarrelPress();
  const refundList = getAllBarrelRefund();
  const pressRows: DepositFlowRow[] = pressList.map((p) => ({
    key: `press-${p.id}`,
    no: p.no,
    date: p.date,
    createdAt: p.createdAt || 0,
    type: 'press',
    customer: p.customer,
    amount: p.totalDeposit,
    remark: p.items.map((i) => `${i.barrel}×${i.count}`).join('、'),
  }));
  const refundRows: DepositFlowRow[] = refundList.map((r) => ({
    key: `refund-${r.id}`,
    no: r.no,
    date: r.date,
    createdAt: r.createdAt || 0,
    type: 'refund',
    customer: r.customer,
    amount: -r.refund,
    remark: `退 ${r.pressNo || '—'} 扣减 ¥${r.totalDeduct}`,
  }));
  return [...pressRows, ...refundRows].sort((a, b) => {
    const tA = a.createdAt || parseTimeKey(a.date, a.no);
    const tB = b.createdAt || parseTimeKey(b.date, b.no);
    // 时间大的排前面（最新记录在最上）；时间相同按单号降序兜底
    return tB - tA || String(b.no).localeCompare(String(a.no));
  });
}

// 从 date 或 no 中的 YYYYMMDD 解析时间戳，用于 createdAt 缺失时的兜底排序
function parseTimeKey(date: string, no: string): number {
  if (date) {
    const d = new Date(date + 'T00:00:00');
    if (!isNaN(d.getTime())) return d.getTime();
  }
  const m = /\d{4}(\d{2})(\d{2})/.exec(String(no));
  if (m) {
    const d = new Date(`${m[0].slice(0, 4)}-${m[0].slice(4, 6)}-${m[0].slice(6, 8)}T00:00:00`);
    if (!isNaN(d.getTime())) return d.getTime();
  }
  return 0;
}

// 桶装水 3 项统计（在押/在库/现有库存）—— 看板核心指标，对齐 PC：available = 在库 - 在押
export interface BarrelSummary {
  inUse: number;   // 在押（压 - 退）
  inStore: number; // 在库（用户维护）
  available: number;// 现有库存 = 在库 - 在押
}

export function getBarrelSummary(): BarrelSummary {
  ensureBarrelTables();
  const stock = getAllBarrelStock();
  let inStore = 0, inUse = 0;
  stock.forEach((s) => { inStore += s.inStore; inUse += s.inUse; });
  return { inUse, inStore, available: inStore - inUse };
}

// ============ 商品目录（手机端本地：分类 / 供应商 / 商品）============
// 商品主数据 PC 端维护为主，手机端提供本地「快速录入 + 查询 + 库存预警」闭环。
// 离线可用，与「进销存后台」无实时联动；如需双向同步留待后续接 /api/*。
export interface Category {
  id: number;
  name: string;
  createdAt: number;
}

export interface Supplier {
  id: number;
  name: string;
  contact: string;
  phone: string;
  address: string;
  note: string;
  createdAt: number;
}

export interface Product {
  id: number;
  name: string;
  spec: string;        // 规格
  unit: string;        // 单位
  categoryName: string;
  brand: string;
  supplierName: string;
  purchasePrice: number; // 进货价
  retailPrice: number;   // 零售价
  stockQty: number;      // 库存
  safetyStock: number;   // 安全库存（预警阈值）
  shelfLifeDays: number; // 保质期天数
  note: string;
  createdAt: number;
}

function ensureCatalogTables() {
  const db = getDb();
  db.execSync(`CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE,
    createdAt INTEGER
  );`);
  db.execSync(`CREATE TABLE IF NOT EXISTS suppliers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT, contact TEXT, phone TEXT, address TEXT, note TEXT,
    createdAt INTEGER
  );`);
  db.execSync(`CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT, spec TEXT, unit TEXT, categoryName TEXT, brand TEXT, supplierName TEXT,
    purchasePrice REAL DEFAULT 0, retailPrice REAL DEFAULT 0,
    stockQty INTEGER DEFAULT 0, safetyStock INTEGER DEFAULT 0, shelfLifeDays INTEGER DEFAULT 0,
    note TEXT, createdAt INTEGER
  );`);
}

// 分类
export function listCategories(): Category[] {
  ensureCatalogTables();
  return getDb().getAllSync('SELECT * FROM categories ORDER BY id') as Category[];
}
export function createCategory(name: string): Category {
  ensureCatalogTables();
  const now = Date.now();
  const trimmed = name.trim();
  if (!trimmed) throw new Error('分类名不能为空');
  getDb().runSync('INSERT OR IGNORE INTO categories (name, createdAt) VALUES (?, ?)', [trimmed, now]);
  return getDb().getFirstSync('SELECT * FROM categories WHERE name=?', [trimmed]) as Category;
}
export function deleteCategory(id: number) {
  ensureCatalogTables();
  // 有商品引用时禁止删除
  const row = getDb().getFirstSync('SELECT name FROM categories WHERE id=?', [id]) as { name: string } | undefined;
  if (!row) return;
  const used = getDb().getFirstSync('SELECT COUNT(*) AS c FROM products WHERE categoryName=?', [row.name]) as { c: number };
  if (used.c > 0) throw new Error(`「${row.name}」下还有 ${used.c} 件商品，无法删除`);
  getDb().runSync('DELETE FROM categories WHERE id=?', [id]);
}

// 供应商
export function listSuppliers(): Supplier[] {
  ensureCatalogTables();
  return getDb().getAllSync('SELECT * FROM suppliers ORDER BY id DESC') as Supplier[];
}
export function createSupplier(s: Omit<Supplier, 'id' | 'createdAt'>): Supplier {
  ensureCatalogTables();
  const now = Date.now();
  const trimmed = s.name.trim();
  if (!trimmed) throw new Error('供应商名称不能为空');
  const r = getDb().runSync(
    'INSERT INTO suppliers (name, contact, phone, address, note, createdAt) VALUES (?,?,?,?,?,?)',
    [trimmed, s.contact || '', s.phone || '', s.address || '', s.note || '', now]
  );
  return { id: Number(r.lastInsertRowId), name: trimmed, contact: s.contact || '', phone: s.phone || '', address: s.address || '', note: s.note || '', createdAt: now };
}
export function deleteSupplier(id: number) {
  ensureCatalogTables();
  getDb().runSync('DELETE FROM suppliers WHERE id=?', [id]);
}

// 商品
export function listProducts(): Product[] {
  ensureCatalogTables();
  return getDb().getAllSync('SELECT * FROM products ORDER BY id DESC') as Product[];
}
export function createProduct(p: Omit<Product, 'id' | 'createdAt'>): Product {
  ensureCatalogTables();
  const now = Date.now();
  const trimmed = p.name.trim();
  if (!trimmed) throw new Error('商品名称不能为空');
  const r = getDb().runSync(
    `INSERT INTO products
     (name, spec, unit, categoryName, brand, supplierName,
      purchasePrice, retailPrice, stockQty, safetyStock, shelfLifeDays, note, createdAt)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [trimmed, p.spec || '', p.unit || '', p.categoryName || '', p.brand || '', p.supplierName || '',
     p.purchasePrice || 0, p.retailPrice || 0, p.stockQty || 0, p.safetyStock || 0, p.shelfLifeDays || 0, p.note || '', now]
  );
  return { id: Number(r.lastInsertRowId), ...p, name: trimmed, createdAt: now };
}
export function deleteProduct(id: number) {
  ensureCatalogTables();
  getDb().runSync('DELETE FROM products WHERE id=?', [id]);
}
export function listLowStockProducts(): Product[] {
  return listProducts().filter((p) => p.safetyStock > 0 && p.stockQty < p.safetyStock);
}

// ============ OCR 主图库（手机端本地，对照 PC「OCR主图生成」主图库）============
// 纯本地：识别结果 + 原图 URI 落地，离线可用；不依赖后端 OCR 接口（后端无主图生成接口，PC 同为 mock）。
export interface OcrCard {
  id: number;
  imageUri: string;        // 拍照/选图得到的本地文件 URI
  barcode: string;
  productName: string;
  brand: string;
  ingredients: string;
  nutritionJson: string;   // NutritionItem[]
  viewFormat: 'nutrition' | 'ingredient' | 'both';
  bg: 'white' | 'beige' | 'transparent';
  sizeJson: string;        // { w:number; h:number }
  createdAt: number;
}

function ensureOcrCardsTable() {
  getDb().execSync(`CREATE TABLE IF NOT EXISTS ocr_cards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    imageUri TEXT,
    barcode TEXT,
    productName TEXT,
    brand TEXT,
    ingredients TEXT,
    nutritionJson TEXT,
    viewFormat TEXT,
    bg TEXT,
    sizeJson TEXT,
    createdAt INTEGER
  );`);
}

export function insertOcrCard(c: Omit<OcrCard, 'id' | 'createdAt'>): OcrCard {
  ensureOcrCardsTable();
  const now = Date.now();
  const res = getDb().runSync(
    `INSERT INTO ocr_cards (imageUri, barcode, productName, brand, ingredients, nutritionJson, viewFormat, bg, sizeJson, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [c.imageUri, c.barcode, c.productName, c.brand, c.ingredients, c.nutritionJson, c.viewFormat, c.bg, c.sizeJson, now]
  );
  return { id: Number(res.lastInsertRowId), createdAt: now, ...c };
}

export function listOcrCards(): OcrCard[] {
  ensureOcrCardsTable();
  return getDb().getAllSync('SELECT * FROM ocr_cards ORDER BY createdAt DESC') as OcrCard[];
}

export function deleteOcrCard(id: number) {
  ensureOcrCardsTable();
  getDb().runSync('DELETE FROM ocr_cards WHERE id=?', [id]);
}
