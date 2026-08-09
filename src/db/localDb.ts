import { openDatabaseSync, type SQLiteDatabase } from 'expo-sqlite';
import { LOCAL_DB_NAME } from '../config';
import { apiFetch } from '../api/client';
import {
  DEFAULT_CUSTOM_CHANNELS,
  normalizeCustomChannels,
  type CustomChannel,
} from '../api/settings';

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
    ensureCacheTables();
    ensureRevenueDraftTable();
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
     (id,orderNo,date,supplierName,items,totalAmount,paidAmount,discount,paid,arrivalDate,note,images,uploadedMap,purchaseDate,stockStatus,status,syncVersion,deviceId,createdAt,updatedAt)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      d.id, d.orderNo, d.date, d.supplierName, d.items, d.totalAmount, d.paidAmount,
      d.discount, d.paid, d.arrivalDate, d.note, d.images, d.uploadedMap ?? '{}',
      d.purchaseDate, d.stockStatus,
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
       discount=?, paid=?, arrivalDate=?, note=?, images=?, uploadedMap=?, purchaseDate=?, stockStatus=?, status=?, updatedAt=? WHERE id=?`,
    [
      merged.orderNo, merged.date, merged.supplierName, merged.items, merged.totalAmount,
      merged.paidAmount, merged.discount, merged.paid, merged.arrivalDate, merged.note,
      merged.images, merged.uploadedMap ?? '{}', merged.purchaseDate, merged.stockStatus,
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
    images TEXT, createdAt INTEGER, raw TEXT
  );`);
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
  const purRes = await apiFetch(`${baseUrl}/api/purchases`, { method: 'GET' });
  if (!purRes.ok || !purRes.json?.data) throw new Error('拉取进货快照失败');
  const revRes = await apiFetch(`${baseUrl}/api/revenue`, { method: 'GET' });
  if (!revRes.ok || !revRes.json?.data) throw new Error('拉取营收快照失败');

  const db = getDb();
  db.execSync('DELETE FROM purchases_cache');
  db.execSync('DELETE FROM revenues_cache');

  const purList: any[] = purRes.json.data;
  for (const p of purList) {
    db.runSync(
      `INSERT INTO purchases_cache
       (id,orderNo,date,supplierName,totalAmount,paidAmount,paid,note,images,createdAt,raw)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [
        p.id, p.orderNo, p.date, p.supplierName || '',
        Number(p.totalAmount) || 0, Number(p.paidAmount) || 0, p.paid ? 1 : 0,
        p.note || '', JSON.stringify(p.images || []), Number(p.createdAt) || 0,
        JSON.stringify(p),
      ]
    );
  }

  const revList: any[] = revRes.json.data;
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

  const ts = Date.now();
  setMeta('last_sync', String(ts));
  return { purchases: purList.length, revenues: revList.length, ts };
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
