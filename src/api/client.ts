import { getApiToken } from '../config';

export interface ApiResult {
  ok: boolean;
  status: number;
  json: any;
  text?: string;
}

function timeout(ms: number) {
  return new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`fetch timeout ${ms}ms`)), ms)
  );
}

/** 判断响应体是不是网页而非 API JSON（常见于填成静态文件服务器端口） */
function looksLikeHtml(text: string): boolean {
  const t = text.trimStart();
  return t.startsWith('<!DOCTYPE') || t.startsWith('<html') || t.startsWith('<');
}

// 统一 fetch 封装：自动携带 x-api-token（与 web 端一致，所有非 GET 写操作必须）
export async function apiFetch(path: string, opts: RequestInit = {}): Promise<ApiResult> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-api-token': await getApiToken(),
    ...(opts.headers as Record<string, string> | undefined),
  };
  console.log('[apiFetch] start', opts.method || 'GET', path);
  try {
    const res = (await Promise.race([
      fetch(path, { ...opts, headers }),
      timeout(30000), // 30 秒总超时，避免 iOS 真机 fetch 静默挂起
    ])) as Response;
    console.log('[apiFetch] response status=', res.status, path);
    let json: any = {};
    let text = '';
    try {
      text = await res.text();
      console.log('[apiFetch] response text length=', text.length, path);
      if (looksLikeHtml(text)) {
        console.warn('[apiFetch] WARN response looks like HTML, not API JSON. Check baseUrl port.', path, text.slice(0, 120));
      }
      json = text ? JSON.parse(text) : {};
    } catch (e) {
      console.log('[apiFetch] parse json fail', e, path);
      /* 忽略解析失败，交由调用方按 status 判断 */
    }
    console.log('[apiFetch] end', path, 'ok=', res.ok);
    return { ok: res.ok, status: res.status, json, text };
  } catch (e: any) {
    console.log('[apiFetch] error', e?.message || e, path);
    throw e;
  }
}

/**
 * 两步删除（与 PC 端、后端 requireConfirm 中间件一致）：
 * 先 POST /api/confirm 领一次性令牌，再带 X-Confirm-Token 发 DELETE。
 *
 * 后端默认不强制（config.ini require_confirm），但一旦开启就会对没有令牌的
 * DELETE 直接 403，所以所有会打到后端的删除都必须走这里，不能裸发 DELETE。
 *
 * @param baseUrl 店铺后端地址
 * @param path    删除接口路径（含 /api 前缀），如 /api/supplier-expenses/12
 * @param targetType 后端 requireConfirm 注册的类型，如 'supplier_expense'
 * @param targetId   记录 id
 * @param targetNo   业务单号（可空）
 */
export async function twoStepDelete(
  baseUrl: string,
  path: string,
  targetType: string,
  targetId: string | number,
  targetNo = ''
): Promise<void> {
  const confirmRes = await apiFetch(`${baseUrl}/api/confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'delete', targetType, targetId: String(targetId), targetNo }),
  });
  const token: string | undefined =
    confirmRes.json?.token ?? confirmRes.json?.data?.token;
  if (!confirmRes.ok || !token) {
    throw new Error(confirmRes.json?.msg || `获取删除令牌失败（HTTP ${confirmRes.status}）`);
  }
  const res = await apiFetch(`${baseUrl}${path}`, {
    method: 'DELETE',
    headers: { 'X-Confirm-Token': token },
  });
  if (!res.ok) {
    throw new Error(res.json?.msg || `删除失败（HTTP ${res.status}）`);
  }
}
