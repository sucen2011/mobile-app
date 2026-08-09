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
  type RevenueDraft,
} from '../db/localDb';
import { pushRecords } from '../api/sync';
import { apiFetch } from '../api/client';
import { uploadImage } from '../api/upload';

// 实际连通探测：带 token 请求 /api/revenue（GET 能响应即视为已连上店铺局域网）
export async function isReachable(baseUrl: string): Promise<boolean> {
  const timeout = (ms: number) =>
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('timeout')), ms)
    );
  console.log('[syncEngine] isReachable start', baseUrl);
  try {
    const res = (await Promise.race([
      fetch(`${baseUrl}/api/revenue`, {
        method: 'GET',
        headers: { 'x-api-token': await getApiToken() },
      }),
      timeout(4000),
    ])) as Response;
    console.log('[syncEngine] isReachable ok status=', res.status);
    return res.status !== 0; // 任何 HTTP 响应都说明网络可达
  } catch (e: any) {
    console.log('[syncEngine] isReachable fail', e?.message || e);
    return false;
  }
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

// 执行一次完整同步（对齐 §18 M-06/M-07/M-08）：
// 遍历 pending 草稿 → 上传照片(B方案) → push → 成功即删本地 → 冲突保留云端删本地
export async function runSync(
  baseUrl: string,
  deviceId: string,
  onProgress?: (msg: string) => void
): Promise<SyncResult> {
  console.log('[syncEngine] runSync start', baseUrl, deviceId);
  onProgress?.('正在探测服务器连通性…');
  const reachable = await isReachable(baseUrl);
  console.log('[syncEngine] reachable=', reachable);
  if (!reachable) {
    onProgress?.('未连接到店铺 WiFi，稍后自动重试');
    console.log('[syncEngine] abort: unreachable');
    return { synced: 0, conflict: 0, failed: 0 };
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
      };
      console.log('[syncEngine] push record', record);
      onProgress?.(`推送单据 ${d.orderNo}…`);
      const resp = await pushRecords(baseUrl, deviceId, [record]);
      console.log('[syncEngine] push response', JSON.stringify(resp));
      const r = resp?.data?.results?.[0];
      if (r?.ok) {
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

  if (synced === 0 && conflict === 0 && failed === 0) {
    onProgress?.('无待同步单据');
    console.log('[syncEngine] nothing to sync');
    return { synced, conflict, failed };
  }

  onProgress?.(
    failed === 0
      ? `同步完成（成功 ${synced}${conflict ? `，冲突 ${conflict}` : ''}）`
      : `同步结束：成功 ${synced}，失败 ${failed}`
  );
  return { synced, conflict, failed };
}
