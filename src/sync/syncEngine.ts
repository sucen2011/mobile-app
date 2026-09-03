// ⚠️ 同 config.ts：SDK 54 下 deleteAsync 只在 'expo-file-system/legacy' 里可用，
//    从主入口拿到的是"调用即 throw"的弃用桩，本地照片会永远删不掉（磁盘泄漏）。
import * as FileSystem from 'expo-file-system/legacy';
import { getApiToken } from '../config';
import {
  claimSyncableDrafts,
  reclaimStaleSyncing,
  setDraftStatus,
  deleteDraft,
  getUploadedMap,
  rememberUploadedImage,
  claimSyncableRevenueDrafts,
  setRevenueDraftStatus,
  markRevenueDraftPushed,
  deleteRevenueDraft,
  getUnsyncedBarrelPress,
  getUnsyncedBarrelRefund,
  markBarrelPressSynced,
  markBarrelRefundSynced,
  type RevenueDraft,
  type Draft,
} from '../db/localDb';
import { pushRecords } from '../api/sync';
import { apiFetch } from '../api/client';
import { uploadImage } from '../api/upload';

function isApiJson(body: any, text: string): boolean {
  if (!body) return false;
  if (typeof body === 'object') {
    if (Array.isArray(body)) return true;
    if (Array.isArray(body.data)) return true;
    if (typeof body.code === 'number') return true;
  }
  const t = text.trimStart();
  return !(t.startsWith('<!DOCTYPE') || t.startsWith('<html') || t.startsWith('<'));
}

// 实际连通探测：带 token 请求 /api/revenue，必须返回合法 API JSON 才算真正连上。
// 如果返回的是静态网页（如把前端页面端口 8081 错填成后端地址），这里会判为不可达，
// 避免后续把所有 API 都当成“已同步”但实际没拿到数据。
export type UnreachableReason =
  | 'unconfigured' // 服务器地址还是占位串，压根没配过
  | 'unreachable' // 网络不通 / 超时（电脑关机、不在一个网段）
  | 'unauthorized' // 401：token 缺失或失效（未从 /api/bootstrap 取到）
  | 'bad-response' // 能连上但返回的不是 API JSON（典型：端口填成了前端页面/静态服务）
  | 'error'; // 其它服务端错误（5xx）

export interface ProbeResult {
  ok: boolean;
  reason: UnreachableReason | 'ok';
  /** 可直接展示给用户的原因说明 */
  message: string;
}

const REASON_MESSAGE: Record<UnreachableReason, string> = {
  unconfigured: '尚未配置店铺服务器地址，请到「我的 → 服务器地址」填写电脑端显示的地址',
  unreachable: '连接不上店铺服务器，请确认电脑已开机、后端已启动，且手机与电脑在同一 WiFi',
  unauthorized: '鉴权失败（401），请在「我的 → 服务器地址」点测试连接重新获取令牌',
  'bad-response': '服务器地址端口可能填错（返回的不是接口数据），常见是填成了前端页面端口',
  error: '服务器返回错误，请稍后重试或检查后端日志',
};

/** 超时竞速：RN 的 fetch 不会自己超时，iOS 真机上可能静默挂起 */
const timeout = (ms: number) =>
  new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms));

/** 占位地址特征：config.ts 里 DEFAULT_STORE_BASE_URL 的占位串，未配置时会直接拿来用 */
function isPlaceholderUrl(baseUrl: string): boolean {
  return !baseUrl || baseUrl.includes('<') || baseUrl.includes('电脑局域网IP');
}

/** 实际连通探测，并区分失败原因——原来一律报「未连接到店铺 WiFi」，把 401/端口填错也混进去了 */
export async function probeConnection(baseUrl: string): Promise<ProbeResult> {
  if (isPlaceholderUrl(baseUrl)) {
    return { ok: false, reason: 'unconfigured', message: REASON_MESSAGE.unconfigured };
  }
  try {
    const res = (await Promise.race([
      fetch(`${baseUrl}/api/revenue`, {
        method: 'GET',
        headers: { 'x-api-token': await getApiToken() },
      }),
      timeout(4000),
    ])) as Response;
    const text = await res.text();
    let body: any = null;
    try { body = text ? JSON.parse(text) : null; } catch { /* ignore */ }
    console.log('[syncEngine] probe status=', res.status, text.slice(0, 80));
    if (res.status === 401 || res.status === 403) {
      return { ok: false, reason: 'unauthorized', message: REASON_MESSAGE.unauthorized };
    }
    if (res.status >= 500) {
      return { ok: false, reason: 'error', message: REASON_MESSAGE.error };
    }
    if (!isApiJson(body, text)) {
      return { ok: false, reason: 'bad-response', message: REASON_MESSAGE['bad-response'] };
    }
    if (!res.ok) {
      return { ok: false, reason: 'error', message: REASON_MESSAGE.error };
    }
    return { ok: true, reason: 'ok', message: '' };
  } catch (e: any) {
    console.log('[syncEngine] probe fail', e?.message || e);
    return { ok: false, reason: 'unreachable', message: REASON_MESSAGE.unreachable };
  }
}

export async function isReachable(baseUrl: string): Promise<boolean> {
  return (await probeConnection(baseUrl)).ok;
}

async function deleteLocalImages(images: string[]) {
  for (const uri of images) {
    try {
      await FileSystem.deleteAsync(uri, { idempotent: true });
    } catch {
      /* 忽略删除失败 */
    }
  }
}

export interface SyncResult {
  synced: number;
  conflict: number;
  failed: number;
  /** 未连通时的具体原因；连通时为 'ok'（或省略，兼容旧调用方） */
  reason?: UnreachableReason | 'ok';
  /** 可直接展示给用户的结果说明（失败原因 / 成功汇总） */
  message?: string;
}

// ============ 营收草稿推送 ============
//
// 进货走 /api/sync/push（带 clientTempId，服务端按它去重，天然幂等）。
// 营收没有这个通道：/api/sync/push 只查 purchase_order（server.js:558），
// 只能一笔一笔 POST /api/revenue —— 而那个接口**自己 genId、不接受幂等键**（server.js:646）。
// 于是「请求发出去了但没收到响应」这种情况无法靠服务端兜底，只能在客户端做保护：
//   发之前先把 pushedAt 落盘 → 重试时先拉一次服务端清单比对 → 确认没落库才敢重发。

/** 拉服务端营收清单用于比对；失败返回 null（表示"无法确认"，与"确认为空"要区分开） */
async function fetchRemoteRevenues(baseUrl: string): Promise<any[] | null> {
  try {
    const res = await apiFetch(`${baseUrl}/api/revenue`, { method: 'GET' });
    if (!res.ok || !Array.isArray(res.json?.data)) return null;
    return res.json.data;
  } catch {
    return null;
  }
}

/**
 * 判断服务端这条记录是否就是本地这笔草稿。
 * 没有幂等键可比，只能按业务字段（日期 + 合计 + 备注）匹配。
 * 金额用 0.005 容差，避免服务端 REAL 存取带来的浮点尾差。
 */
function looksLikeSameRevenue(remote: any, d: RevenueDraft): boolean {
  if (String(remote?.date || '') !== String(d.date || '')) return false;
  if (Math.abs(Number(remote?.total || 0) - Number(d.total || 0)) > 0.005) return false;
  return String(remote?.note || '') === String(d.note || '');
}

async function pushRevenueDrafts(
  baseUrl: string,
  onProgress?: (msg: string) => void
): Promise<SyncResult> {
  const drafts = claimSyncableRevenueDrafts();
  if (drafts.length === 0) return { synced: 0, conflict: 0, failed: 0 };

  // 只有存在"发过但结果未知"的草稿时才多拉一次清单；正常首次推送零额外请求
  const needProbe = drafts.some((d) => Number(d.pushedAt || 0) > 0);
  const remote = needProbe ? await fetchRemoteRevenues(baseUrl) : null;

  onProgress?.(`开始同步 ${drafts.length} 笔营收…`);
  let synced = 0;
  let conflict = 0;
  let failed = 0;

  for (const d of drafts) {
    try {
      if (Number(d.pushedAt || 0) > 0) {
        if (remote === null) {
          // 拉不到清单 = 无法确认上次那一发到底落库没有。
          // 这种时候宁可这轮不推（下轮再来），也不能赌 —— 赌错就是同一笔营收记两遍。
          setRevenueDraftStatus(d.id, 'pending');
          failed++;
          onProgress?.(`营收 ${d.date} 待确认，下轮重试`);
          continue;
        }
        if (remote.some((r) => looksLikeSameRevenue(r, d))) {
          // 上一发其实已经落库了，只是响应没回来。直接清掉本地，不再重发。
          deleteRevenueDraft(d.id);
          synced++;
          onProgress?.(`营收 ${d.date} 服务端已存在，本机已清理`);
          continue;
        }
      }

      setRevenueDraftStatus(d.id, 'syncing');
      // 顺序关键：先落盘"我要发了"，再发。反过来的话请求发出后被杀进程，
      // 这个事实就丢了，下轮会当成全新草稿裸推一遍 → 重复记账。
      markRevenueDraftPushed(d.id);

      const payments = JSON.parse(d.payments || '{}');
      onProgress?.(`推送营收 ${d.date}…`);
      const res = await apiFetch(`${baseUrl}/api/revenue`, {
        method: 'POST',
        body: JSON.stringify({ date: d.date, payments, note: d.note }),
      });

      if (res.ok && res.json?.code === 0) {
        deleteRevenueDraft(d.id);
        synced++;
        onProgress?.(`营收 ${d.date} 已同步`);
      } else if (res.status === 401 || res.status === 403) {
        // 鉴权失败重试一万次也不会成功（token 由 /api/bootstrap 下发），
        // 必须明确提示，否则用户只看到草稿一直推不出去、又没有任何原因。
        setRevenueDraftStatus(d.id, 'pending');
        failed++;
        onProgress?.(`营收 ${d.date} 鉴权失败（${res.status}），请到「我的 → 服务器地址」重新测试连接`);
      } else if (res.status >= 400 && res.status < 500 && res.status !== 401 && res.status !== 408 && res.status !== 429) {
        // 服务端明确拒绝了这份数据（字段不合法等），重试多少次都一样。
        // 标 conflict 让它在 UI 上显出来，等人工处理，别静默无限重试。
        setRevenueDraftStatus(d.id, 'conflict');
        conflict++;
        onProgress?.(`营收 ${d.date} 被服务端拒绝（${res.json?.msg || res.status}）`);
      } else {
        setRevenueDraftStatus(d.id, 'pending');
        failed++;
        onProgress?.(`营收 ${d.date} 同步失败，留待重试`);
      }
    } catch (e: any) {
      // 网络异常/超时：结果未知，打回 pending。pushedAt 已落盘，下轮会先比对再决定是否重发。
      setRevenueDraftStatus(d.id, 'pending');
      failed++;
      onProgress?.(`营收 ${d.date} 异常：${e?.message || '失败'}`);
    }
  }

  return { synced, conflict, failed };
}

/**
 * 进货单成功推送后，按草稿标记派生一条入库单。
 * 入库单是采购单的只读派生：后端落库不调库存接口，绝不会造成库存双扣。
 * 返回 true=生成成功（或无需生成），false=需重试。
 */
async function createStockInFromDraft(baseUrl: string, d: Draft, record: any): Promise<boolean> {
  try {
    // 过滤合成单（录单据/其他模式的「进货(总额)」「其他」占位行），它们不是真实商品明细
    const items = (record.items || []).filter(
      (it: any) => it && it.name && it.name !== '进货(总额)' && it.name !== '其他'
    );
    if (items.length === 0) return true; // 没有可导入的明细，视为无需生成
    const payload = {
      sourcePurchaseNo: d.orderNo,
      supplierName: d.supplierName,
      stockInDate: d.purchaseDate || d.date,
      status: 1, // 已入库
      remark: '',
      items: items.map((it: any) => ({
        barcode: it.barcode || '',
        name: it.name,
        spec: '',
        unit: it.unit || '',
        quantity: Number(it.quantity) || 0,
        price: Number(it.price) || 0,
        amount: Number(it.amount) || (Number(it.quantity) || 0) * (Number(it.price) || 0),
      })),
    };
    const res = await apiFetch(`${baseUrl}/api/stock-in`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    return res.ok && res.json?.code === 0;
  } catch {
    return false;
  }
}

// ============ 桶装水双向同步 ============
//
// 下行（PC→手机）已在 fetchAndCacheSnapshot 内完成：拉 /api/barrel/{press,refund} 按单号 no
// 去重合并、/api/barrel/type 补充本地。这里只做上行（手机→PC）：把本地 synced=0 的
// 压桶 / 退桶记录 POST 到 PC 对应接口，成功即标记 synced=1。
//
// 去重关键是业务单号 no：手机保存时生成 YT/TK+日期+随机，上行把 no 带给 PC，
// PC 用该 no（POST 契约 no 字段优先），所以 PC 上的 no 与手机本地一致；
// 下次下行拉 PC 记录时按 no 命中本地、跳过——不会重复记账。
export async function syncBarrelRecords(
  baseUrl: string,
  onProgress?: (msg: string) => void
): Promise<{ pushed: number; failed: number }> {
  let pushed = 0;
  let failed = 0;

  // ---- 上行：压桶 ----
  for (const p of getUnsyncedBarrelPress()) {
    try {
      onProgress?.(`同步压桶单 ${p.no || p.customer}…`);
      const res = await apiFetch(`${baseUrl}/api/barrel/press`, {
        method: 'POST',
        body: JSON.stringify({
          no: p.no,
          customer: p.customer,
          phone: p.phone || undefined,
          date: p.date,
          channel: 'cash',
          items: (p.items || []).map((i) => ({ barrel: i.barrel, count: i.count, unitPrice: i.unitPrice })),
          totalDeposit: p.totalDeposit,
          received: p.received,
          paid: p.received,
          handler: p.handler || undefined,
        }),
      });
      if (res.ok && res.json?.code === 0) {
        markBarrelPressSynced(p.id);
        pushed++;
        onProgress?.(`压桶单 ${p.no || p.customer} 已同步`);
      } else {
        failed++;
        onProgress?.(`压桶单 ${p.no || p.customer} 同步失败（${res.json?.msg || res.status}），稍后重试`);
      }
    } catch (e: any) {
      failed++;
      onProgress?.(`压桶单 ${p.no || p.customer} 异常：${e?.message || '失败'}`);
    }
  }

  // ---- 上行：退桶 ----
  for (const r of getUnsyncedBarrelRefund()) {
    try {
      onProgress?.(`同步退桶单 ${r.no || r.customer}…`);
      const res = await apiFetch(`${baseUrl}/api/barrel/refund`, {
        method: 'POST',
        body: JSON.stringify({
          no: r.no,
          pressNo: r.pressNo || null,
          customer: r.customer,
          phone: r.phone || undefined,
          date: r.date,
          items: (r.items || []).map((i) => ({
            barrel: i.barrel,
            count: i.count,
            // PC 的 deduct = sum(count*unitPrice)，手机退桶 item.deduct 是损耗金额；
            // 折算成单价让 PC 的扣减损耗近似等于手机总损耗。
            unitPrice: Number(i.deduct || 0) > 0
              ? Number(i.deduct) / Math.max(1, Number(i.count) || 1)
              : Number(i.unitPrice || 0),
          })),
          totalDeduct: r.totalDeduct,
          refund: r.refund,
        }),
      });
      if (res.ok && res.json?.code === 0) {
        markBarrelRefundSynced(r.id);
        pushed++;
        onProgress?.(`退桶单 ${r.no || r.customer} 已同步`);
      } else {
        failed++;
        onProgress?.(`退桶单 ${r.no || r.customer} 同步失败（${res.json?.msg || res.status}），稍后重试`);
      }
    } catch (e: any) {
      failed++;
      onProgress?.(`退桶单 ${r.no || r.customer} 异常：${e?.message || '失败'}`);
    }
  }

  return { pushed, failed };
}

// 执行一次完整同步（对齐 §18 M-06/M-07/M-08）：
// 遍历 pending 草稿 → 上传照片(B方案) → push → 成功即删本地 → 冲突保留云端删本地
export async function runSync(
  baseUrl: string,
  deviceId: string,
  onProgress?: (msg: string) => void
): Promise<SyncResult> {
  console.log('[syncEngine] runSync start', baseUrl, deviceId);
  onProgress?.('正在探测服务器连通性…');
  const probe = await probeConnection(baseUrl);
  console.log('[syncEngine] probe=', probe.reason, probe.ok);
  if (!probe.ok) {
    // 原来的「未连接到店铺 WiFi」把「没配地址 / 401 / 端口填错」全混成一句，
    // 用户根本无从下手。这里回传可区分的原因，由调用方直接提示到 UI。
    onProgress?.(probe.message);
    console.log('[syncEngine] abort:', probe.reason);
    return { synced: 0, conflict: 0, failed: 0, reason: probe.reason, message: probe.message };
  }

  // 先回收上一次没跑完、永久卡在 'syncing' 的孤儿草稿，再取本轮任务。
  // 不这么做的话，被卡住的草稿对所有重试路径都是隐形的（详见 localDb.reclaimStaleSyncing 注释）。
  const reclaimed = reclaimStaleSyncing();
  if (reclaimed > 0) {
    console.log('[syncEngine] reclaimed stale syncing drafts=', reclaimed);
    onProgress?.(`回收 ${reclaimed} 张卡住的单据，重新同步`);
  }

  const drafts = claimSyncableDrafts();
  console.log('[syncEngine] syncable drafts=', drafts.length);
  // 注意：这里**不能**在进货草稿为空时提前 return —— 营收草稿是另一条独立队列，
  // 早退会让「只有营收待同步」的场景永远推不出去（本机记着，服务端一直没有）。
  if (drafts.length > 0) onProgress?.(`开始同步 ${drafts.length} 张单据…`);
  let synced = 0;
  let conflict = 0;
  let failed = 0;

  for (const d of drafts) {
    // 去重：同一张本地照片在 images 里出现两次就会被上传两次、也会在单据上挂两条 url。
    // 这里按本地 uri 去重，顺序保持首次出现的顺序。
    //
    // ⚠️ 必须在 try 内部解析：这行原本在 try 之上，一旦某条草稿的 images 列是坏 JSON
    // （历史写入残留 / 存储损坏），JSON.parse 就会把整个 runSync 抛出去 ——
    // 而 runSync 的调用链（App 的 doSync → tick）当时也没有 catch，
    // 结果是一条坏草稿直接掐掉后续所有草稿的同步，且连累启动时的定时器建不起来。
    let localImages: string[] = [];
    try {
      localImages = Array.from(
        new Set((JSON.parse(d.images || '[]') as string[]).filter(Boolean))
      );
      console.log('[syncEngine] draft', d.orderNo, 'images=', localImages.length);
      setDraftStatus(d.id, 'syncing');
      // B 方案：先逐个上传照片，拿 /uploads/xxx.png url
      //
      // 幂等：/api/upload 每被调一次就往 image_resource 插一行（既不按 file_hash
      // 也不按 order_no 去重），而本函数的重试路径极其密集 —— push 失败会打回
      // 'pending'，卡死的 'syncing' 也会被 reclaimStaleSyncing 回收成 'pending'。
      // 以前每重试一轮就把同一批照片重传一遍，同一 orderNo 下就堆出 N 行记录，
      // 网页端按 /api/images?orderNo= 渲染，于是"上传一张得到六张"。
      // 现在先查已上传映射，传过的直接复用 url，绝不重复上传。
      const already = getUploadedMap(d.id);
      const uploadedUrls: string[] = [];
      for (let i = 0; i < localImages.length; i++) {
        const localUri = localImages[i];
        const cachedUrl = already[localUri];
        if (cachedUrl) {
          console.log('[syncEngine] reuse uploaded url', i, cachedUrl);
          onProgress?.(`照片 ${i + 1}/${localImages.length} 已上传，复用（单据 ${d.orderNo}）`);
          uploadedUrls.push(cachedUrl);
          continue;
        }
        // 心跳：每传一张就刷新 updatedAt，避免多图大单据传超 2 分钟时
        // 被 reclaimStaleSyncing 误判成孤儿而重复推送
        setDraftStatus(d.id, 'syncing');
        onProgress?.(`读取照片 ${i + 1}/${localImages.length}（单据 ${d.orderNo}）`);
        console.log('[syncEngine] read image', i, localUri);
        const url = await uploadImage(baseUrl, localUri, d.supplierName || '单据', d.date, i + 1, d.orderNo);
        console.log('[syncEngine] uploaded url', i, url);
        if (url) {
          // 传完一张立刻落盘：整批传完再写的话，中途被杀进程就白传，下轮又是重复上传
          rememberUploadedImage(d.id, localUri, url);
          already[localUri] = url;
          uploadedUrls.push(url); // 读取失败时返回 null，跳过单张照片
        }
      }
      const record = {
        clientTempId: d.id,
        orderNo: d.orderNo,
        date: d.date,
        supplierName: d.supplierName,
        items: JSON.parse(d.items || '[]'),
        totalAmount: d.totalAmount,
        paidAmount: d.paidAmount,
        discount: d.discount,
        paid: d.paid === 1,
        arrivalDate: d.arrivalDate || d.date || null,
        note: d.note,
        // 再兜一层：即使历史 uploadedMap 里出现同一 url 的多个键，单据上也只挂一份
        images: Array.from(new Set(uploadedUrls)),
        version: d.syncVersion,
        purchaseDate: d.purchaseDate || d.date,
        stockStatus: d.stockStatus ?? 1,
        category: d.category || '',
      };
      console.log('[syncEngine] push record', record);
      onProgress?.(`推送单据 ${d.orderNo}…`);
      const resp = await pushRecords(baseUrl, deviceId, [record]);
      console.log('[syncEngine] push response', JSON.stringify(resp));
      const r = resp?.data?.results?.[0];
      if (r?.ok) {
        // 「保存为入库单」：进货单推送成功后，派生一条入库单（只读派生，不调库存）。
        // 仅商品明细方式开启且确有可导入明细时才生成；失败则保留草稿打回 pending，
        // 借采购单 clientTempId 幂等键，下一轮同步会重新推送采购单并再次尝试生成入库单，
        // 不会因重试产生重复采购单。
        if (d.saveToStockIn) {
          const stockOk = await createStockInFromDraft(baseUrl, d, record);
          if (!stockOk) {
            setDraftStatus(d.id, 'pending');
            onProgress?.(`单据 ${d.orderNo} 入库单生成失败，稍后重试`);
            continue;
          }
        }
        // 成功即删本地（单据 + 照片）
        deleteDraft(d.id);
        await deleteLocalImages(localImages);
        synced++;
        onProgress?.(`单据 ${d.orderNo} 已同步`);
      } else if (r?.status === 'conflict') {
        // 云端版本更新：保留云端，删本地草稿 + 照片
        deleteDraft(d.id);
        await deleteLocalImages(localImages);
        conflict++;
        onProgress?.(`单据 ${d.orderNo} 冲突，已保留云端并删除本机`);
      } else {
        setDraftStatus(d.id, 'pending');
        failed++;
        onProgress?.(`单据 ${d.orderNo} 同步失败，留待重试`);
      }
    } catch (e: any) {
      setDraftStatus(d.id, 'pending');
      failed++;
      onProgress?.(`单据 ${d.orderNo} 异常：${e?.message || '失败'}`);
    }
  }

  // 营收草稿：独立队列，进货推完接着推。整段包 catch —— 营收推送出问题不该
  // 连累已经成功的进货同步，更不该把异常抛回 App 的 tick（那会掐掉后续轮询）。
  try {
    const rev = await pushRevenueDrafts(baseUrl, onProgress);
    synced += rev.synced;
    conflict += rev.conflict;
    failed += rev.failed;
  } catch (e: any) {
    console.warn('[syncEngine] pushRevenueDrafts failed:', e?.message || e);
    failed++;
  }

  // 桶装水双向同步：上行本地未同步的压桶 / 退桶到 PC（下行已在 fetchAndCacheSnapshot 内完成）。
  // 独立 try：桶装水同步出问题不该连累进货 / 营收同步结果。
  let barrelPushed = 0;
  let barrelFailed = 0;
  try {
    const bSync = await syncBarrelRecords(baseUrl, onProgress);
    barrelPushed = bSync.pushed;
    barrelFailed = bSync.failed;
    if (barrelPushed > 0 || barrelFailed > 0) {
      onProgress?.(`桶装水同步：成功 ${barrelPushed}${barrelFailed ? `，失败 ${barrelFailed}` : ''}`);
    }
  } catch (e: any) {
    console.warn('[syncEngine] syncBarrelRecords failed:', e?.message || e);
  }

  const totalSynced = synced + barrelPushed;
  const totalFailed = failed + barrelFailed;

  if (totalSynced === 0 && conflict === 0 && totalFailed === 0) {
    onProgress?.('无待同步单据');
    console.log('[syncEngine] nothing to sync');
    return { synced, conflict, failed, reason: 'ok', message: '无待同步单据' };
  }

  const summary =
    totalFailed === 0
      ? `同步完成（成功 ${totalSynced}${conflict ? `，冲突 ${conflict}` : ''}）`
      : `同步结束：成功 ${totalSynced}，失败 ${totalFailed}。失败的单据仍留在草稿箱，稍后自动重试`;
  onProgress?.(summary);
  return { synced: totalSynced, conflict, failed: totalFailed, reason: 'ok', message: summary };
}
