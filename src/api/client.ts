import { getApiToken } from '../config';

export interface ApiResult {
  ok: boolean;
  status: number;
  json: any;
}

function timeout(ms: number) {
  return new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`fetch timeout ${ms}ms`)), ms)
  );
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
    try {
      const text = await res.text();
      console.log('[apiFetch] response text length=', text.length, path);
      json = text ? JSON.parse(text) : {};
    } catch (e) {
      console.log('[apiFetch] parse json fail', e, path);
      /* 忽略解析失败，交由调用方按 status 判断 */
    }
    console.log('[apiFetch] end', path, 'ok=', res.ok);
    return { ok: res.ok, status: res.status, json };
  } catch (e: any) {
    console.log('[apiFetch] error', e?.message || e, path);
    throw e;
  }
}
