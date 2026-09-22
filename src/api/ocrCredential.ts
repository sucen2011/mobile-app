import { apiFetch, type ApiResult } from './client';
import { getApiToken } from '../config';
import { getMeta, setMeta } from '../db/localDb';
import { recognizeWithTencentDirect, type OcrCredential, OcrError } from '../utils/tencentOcrDirect';

const OCR_CREDENTIAL_KEY = 'ocr_credential';
// 密钥缓存有效期 180 天：店铺电脑关机时手机靠本地缓存直连腾讯云识别。
// 原为 7 天——到期后若电脑正好关机，缓存作废且无法刷新，识别就只剩电脑代理一条路（必失败）。
// 现在改为：过期后**先尝试刷新**，刷新失败则继续复用旧密钥（优雅降级），保证长期可用。
export const CREDENTIAL_TTL_MS = 180 * 24 * 60 * 60 * 1000;
/** 缓存有效天数（界面展示用） */
export const CREDENTIAL_TTL_DAYS = Math.round(CREDENTIAL_TTL_MS / 86400000);

/** 读取本机缓存的腾讯云 OCR 密钥。allowExpired=true 时过期也返回（用于刷新失败后的降级复用）。 */
export function getCachedCredential(allowExpired = false): OcrCredential | null {
  const v = getMeta(OCR_CREDENTIAL_KEY);
  if (!v) return null;
  try {
    const c = JSON.parse(v) as Partial<OcrCredential & { cachedAt?: number }>;
    if (!c || !c.secretId || !c.secretKey) return null;
    if (typeof c.cachedAt === 'number' && Date.now() - c.cachedAt > CREDENTIAL_TTL_MS && !allowExpired) {
      console.log('[ocrCredential] 密钥缓存已过期，将回源刷新');
      return null;
    }
    return {
      secretId: c.secretId,
      secretKey: c.secretKey,
      region: c.region || 'ap-guangzhou',
    };
  } catch {
    /* 损坏则视为无缓存 */
  }
  return null;
}

/** 密钥缓存状态（给「设置」页展示直连可用性 / 剩余天数用） */
export function getCredentialStatus(): {
  has: boolean;
  secretIdMasked: string;
  region: string;
  cachedAt: number | null;
  expired: boolean;
  daysLeft: number;
} {
  const v = getMeta(OCR_CREDENTIAL_KEY);
  const empty = { has: false, secretIdMasked: '', region: '', cachedAt: null as number | null, expired: false, daysLeft: 0 };
  if (!v) return empty;
  try {
    const c = JSON.parse(v) as Partial<OcrCredential & { cachedAt?: number }>;
    if (!c || !c.secretId || !c.secretKey) return empty;
    const cachedAt = typeof c.cachedAt === 'number' ? c.cachedAt : null;
    const age = cachedAt ? Date.now() - cachedAt : 0;
    const expired = age > CREDENTIAL_TTL_MS;
    const daysLeft = cachedAt ? Math.max(0, Math.ceil((CREDENTIAL_TTL_MS - age) / 86400000)) : 0;
    const sid = String(c.secretId);
    return {
      has: true,
      secretIdMasked: sid.length > 8 ? sid.slice(0, 4) + '…' + sid.slice(-4) : '****',
      region: c.region || 'ap-guangzhou',
      cachedAt,
      expired,
      daysLeft,
    };
  } catch {
    return empty;
  }
}

/** 清除本机密钥缓存（设置页「清除密钥」用） */
export function clearCredential(): void {
  setMeta(OCR_CREDENTIAL_KEY, '');
}

/** 写入本机缓存（cache_meta 表，key=ocr_credential），并打上写入时间戳供 TTL 判断 */
export function saveCredential(cred: OcrCredential): void {
  setMeta(OCR_CREDENTIAL_KEY, JSON.stringify({ ...cred, cachedAt: Date.now() }));
}

/**
 * 从电脑后端拉取 OCR 密钥下发接口 GET {baseUrl}/api/ocr/credential。
 * 电脑关机 / 接口未配 / 任何错误都返回 null（交由上层回退或继续用缓存）。
 */
export async function fetchOcrCredential(
  baseUrl: string,
  token?: string
): Promise<OcrCredential | null> {
  try {
    const full =
      /^https?:\/\//.test(baseUrl)
        ? baseUrl.replace(/\/+$/, '')
        : `http://${baseUrl.replace(/\/+$/, '')}`;
    const headers: Record<string, string> = {};
    const tk = token || (await getApiToken());
    if (tk) headers['X-Api-Token'] = tk;
    const res = await apiFetch(`${full}/api/ocr/credential`, {
      method: 'GET',
      headers,
    });
    if (!res.ok) return null;
    const code = res.json?.code;
    // 后端未配密钥：{ code: 1, data: { enabled: false } } → 不直连
    if (code === 1) return null;
    if (code !== 0) return null;
    const d = res.json?.data;
    if (!d || !d.secretId || !d.secretKey) return null;
    return {
      secretId: d.secretId,
      secretKey: d.secretKey,
      region: typeof d.region === 'string' && d.region ? d.region : 'ap-guangzhou',
    };
  } catch {
    return null;
  }
}

export interface OcrScanResult {
  text: string;
  lines: { text: string; confidence?: number }[];
  engine: string;
}

/** 去掉 data: 前缀，得到纯 base64（腾讯云要求不含前缀） */
function stripDataUrlPrefix(dataUrl: string): string {
  const m = /^data:.*?;base64,/.exec(dataUrl);
  return m ? dataUrl.slice(m[0].length) : dataUrl;
}

function normalizeBaseUrl(baseUrl: string): string {
  return /^https?:\/\//.test(baseUrl)
    ? baseUrl.replace(/\/+$/, '')
    : `http://${baseUrl.replace(/\/+$/, '')}`;
}

/**
 * 统一 OCR 入口：直连腾讯云优先，失败回退后端代理。
 * - 先读本机缓存密钥；缓存没有且能连上电脑后端则拉取并刷新缓存（电脑关机时走缓存）。
 * - 直连成功 → 返回 engine='tencent-direct'。
 * - 直连失败 → 回退后端 /api/ocr/scan（apiFetch 自动带 x-api-token）。
 * - 两者都失败才抛出可读错误（不吞成空白）。
 *
 * @param dataUrl 完整 data URL（data:image/jpeg;base64,...）
 * @param baseUrl 店铺后端地址（可能是 host 或带 http:// 前缀）
 */
export async function recognizeOcr(
  dataUrl: string,
  baseUrl: string
): Promise<OcrScanResult> {
  const pure = stripDataUrlPrefix(dataUrl);
  const full = normalizeBaseUrl(baseUrl);
  const token = await getApiToken();

  // a. 先读缓存；缓存没有（或已过期）且能连后端则刷新
  let cred = getCachedCredential();
  if (!cred) {
    try {
      const c = await fetchOcrCredential(full, token);
      if (c) {
        cred = c;
        saveCredential(c);
      } else {
        // 后端未配置密钥 / 未开启直连：不报错，交给下方回退
        console.log('[recognizeOcr] 后端未下发直连密钥，跳过腾讯云直连');
      }
    } catch (e: any) {
      // 不静默吞掉：明确记录，便于排查「店铺电脑不可达」导致直连一直被跳过
      console.warn('[recognizeOcr] 拉取 OCR 密钥失败，将回退后端代理：', e?.message || e);
    }
    // 优雅降级：刷新失败（多为店铺电脑关机）时**继续复用已过期的旧密钥**，
    // 让「电脑关机也能识别」成立；直连若仍失败会再回退后端，失败信息照旧可读。
    if (!cred) {
      const stale = getCachedCredential(true);
      if (stale) {
        cred = stale;
        console.warn('[recognizeOcr] 密钥已过期且无法刷新（店铺电脑不可达），复用旧密钥直连');
      }
    }
  }

  // b. 直连优先
  let directError: OcrError | Error | null = null;
  if (cred) {
    try {
      const r = await recognizeWithTencentDirect(pure, cred);
      return { text: r.text, lines: r.lines, engine: 'tencent-direct' };
    } catch (e: any) {
      directError = e instanceof Error ? e : new Error(e?.message || String(e));
      console.warn('[recognizeOcr] 腾讯云直连失败，回退后端代理：', e?.message || e);
    }
  }

  // c. 回退后端代理
  let res: ApiResult;
  try {
    res = await apiFetch(`${full}/api/ocr/scan`, {
      method: 'POST',
      body: JSON.stringify({ data: dataUrl }),
    });
  } catch (e: any) {
    // 后端代理不可达（店铺电脑关机 / WiFi 未连 / 地址填错 / 30s 超时）：
    // 不把原始 e.message（可能是底层 Java/okhttp 栈）透给用户，只给可操作文案 + 分类码。
    const detail = directError
      ? `（腾讯云直连也失败了：${directError instanceof OcrError ? directError.friendlyMessage : (directError.message || '未知原因')}）`
      : '';
    throw new OcrError(
      'LAN_UNREACHABLE',
      `识别失败：未连接到店铺电脑。请确认：①手机已连店铺 WiFi；②「设置」里服务器地址填写正确；③店铺电脑已开机且 3001 服务在运行。${detail}`
    );
  }

  if (!res.ok) {
    const reason =
      res.status === 401
        ? '未连接店铺服务器或鉴权失败：请在「设置」填入服务器地址，并确保手机连店铺 WiFi（仅局域网下发接口令牌）。'
        : res.status === 503
          ? '数据库启动中，请稍候重试。'
          : `识别请求被拒绝（HTTP ${res.status}），请确认已连接店铺服务器。`;
    throw new Error(reason);
  }
  if (res.json && res.json.code && res.json.code !== 0) {
    throw new Error(res.json.msg || '服务端识别异常，请稍后重试');
  }
  const d = res.json?.data || {};
  return {
    text: typeof d.text === 'string' ? d.text : '',
    lines: Array.isArray(d.lines) ? d.lines : [],
    engine: typeof d.engine === 'string' ? d.engine : 'backend',
  };
}
