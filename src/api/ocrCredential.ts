import { apiFetch, type ApiResult } from './client';
import { getApiToken } from '../config';
import { getMeta, setMeta } from '../db/localDb';
import { recognizeWithTencentDirect, type OcrCredential } from '../utils/tencentOcrDirect';

const OCR_CREDENTIAL_KEY = 'ocr_credential';

/** 读取本机缓存的腾讯云 OCR 密钥；缺失/损坏返回 null */
export function getCachedCredential(): OcrCredential | null {
  const v = getMeta(OCR_CREDENTIAL_KEY);
  if (!v) return null;
  try {
    const c = JSON.parse(v) as Partial<OcrCredential>;
    if (c && c.secretId && c.secretKey) {
      return {
        secretId: c.secretId,
        secretKey: c.secretKey,
        region: c.region || 'ap-guangzhou',
      };
    }
  } catch {
    /* 损坏则视为无缓存 */
  }
  return null;
}

/** 写入本机缓存（cache_meta 表，key=ocr_credential），与项目既有 kv 存储风格一致 */
export function saveCredential(cred: OcrCredential): void {
  setMeta(OCR_CREDENTIAL_KEY, JSON.stringify(cred));
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

  // a. 先读缓存；缓存没有且能连后端则刷新
  let cred = getCachedCredential();
  if (!cred) {
    try {
      const c = await fetchOcrCredential(full, token);
      if (c) {
        cred = c;
        saveCredential(c);
      }
    } catch {
      /* 静默：后端不可达时直连也无凭据，下面回退 */
    }
  }

  // b. 直连优先
  if (cred) {
    try {
      const r = await recognizeWithTencentDirect(pure, cred);
      return { text: r.text, lines: r.lines, engine: 'tencent-direct' };
    } catch (e: any) {
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
    throw new Error(e?.message || '识别请求失败：请确认已连接店铺服务器');
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
