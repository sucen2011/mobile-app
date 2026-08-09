// #10 实时双向同步：手机端订阅服务端 SSE（/api/sync），收到广播即刷新本地快照缓存。
// React Native 无原生 EventSource，这里用 fetch + ReadableStream 自实现，零额外依赖。
import { getApiToken } from '../config';
import { isOnStoreLan } from '../net/lan';

export interface SyncListenerHandle {
  stop: () => void;
}

/**
 * 连接服务端 SSE 并持续监听。
 * @param baseUrl 店铺后端地址（如 http://192.168.3.146:3001）
 * @param onEvent 每收到一条广播事件回调（已 JSON.parse）
 * @param onStatus 连接状态变化回调（true=已连上 / false=断开）
 */
export function startSyncListener(
  baseUrl: string,
  onEvent: (evt: any) => void,
  onStatus?: (connected: boolean) => void
): SyncListenerHandle {
  let stopped = false;
  let controller: AbortController | null = null;
  let retry = 1000;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const connect = async () => {
    if (stopped) return;

    // 不在店铺局域网时不必浪费连接，5s 后再探；连上后才真正建 SSE 长连
    if (!(await isOnStoreLan())) {
      if (!stopped) timer = setTimeout(connect, 5000);
      return;
    }

    controller = new AbortController();
    try {
      const res = await fetch(`${baseUrl}/api/sync`, {
        method: 'GET',
        headers: {
          Accept: 'text/event-stream',
          'x-api-token': await getApiToken(),
        },
        signal: controller.signal,
      });
      if (!res.ok || !res.body || typeof (res.body as any).getReader !== 'function') {
        throw new Error(`SSE connect failed ${res.status}`);
      }
      onStatus?.(true);
      retry = 1000; // 连上后重置退避

      const reader = (res.body as any).getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      // 逐块读取并解析 SSE：事件以空行(\n\n)分隔，数据行以 "data:" 开头
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const raw = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          for (const line of raw.split('\n')) {
            if (line.startsWith('data:')) {
              const payload = line.slice(5).trim();
              if (payload) {
                try {
                  onEvent(JSON.parse(payload));
                } catch {
                  /* 非法 JSON 忽略 */
                }
              }
            }
          }
        }
      }
      onStatus?.(false); // 流正常结束（服务端可能关闭空闲连接）→ 触发重连
    } catch (e: any) {
      onStatus?.(false);
      if (stopped || e?.name === 'AbortError') return;
    }
    // 断线/出错后指数退避重连（1s→2s→…→15s 上限）
    if (!stopped) {
      timer = setTimeout(connect, retry);
      retry = Math.min(retry * 2, 15000);
    }
  };

  connect();

  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (controller) controller.abort();
    },
  };
}
