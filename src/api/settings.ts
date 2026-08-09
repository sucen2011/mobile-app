import { apiFetch } from './client';

// 自定义收款渠道（与网页端 public/js/app.js DEFAULT_CHANNELS、
// 后端 server.js DEFAULT_SETTINGS.customChannels 完全同构）。
//
// 数据来源：GET /api/settings → { code:0, data:{ storeName, customChannels:[...] } }
// 网页端设置页用 PUT /api/settings 写回，手机端只读，不提供编辑入口（避免两端各写一份）。
//
// 关键约束：后端 POST /api/revenue 只认 custom1 / custom2 / custom3 三个键
// （server.js:650-654 归一化；insertRevenue 把 custom1→agg_wechat、custom2→agg_alipay、custom3→custom3），
// 所以渠道 key 必须原样透传，不能自己造新 key。
export interface CustomChannel {
  key: string;
  name: string;
  enabled?: boolean;
}

/** 后端拿不到时的兜底，与网页端 DEFAULT_CHANNELS 保持字面一致 */
export const DEFAULT_CUSTOM_CHANNELS: CustomChannel[] = [
  { key: 'custom1', name: '聚合微信', enabled: true },
  { key: 'custom2', name: '聚合支付宝', enabled: true },
  { key: 'custom3', name: '江南', enabled: true },
];

/** 后端 sumPay / insertRevenue 支持的自定义渠道键白名单 */
export const SUPPORTED_CUSTOM_KEYS = ['custom1', 'custom2', 'custom3'] as const;

/** 固定渠道（三端一致，不可禁用） */
export const FIXED_CHANNEL_KEYS = ['cash', 'wechat', 'alipay'] as const;

/** 历史遗留键的展示名（老数据里可能有值，详情页不能把它们吞掉） */
export const LEGACY_CHANNEL_LABELS: Record<string, string> = {
  polymer: '聚合码',
  combo: '组合支付',
};

function normalize(list: any): CustomChannel[] {
  if (!Array.isArray(list)) return DEFAULT_CUSTOM_CHANNELS;
  const out = list
    .filter((c) => c && typeof c.key === 'string' && (SUPPORTED_CUSTOM_KEYS as readonly string[]).includes(c.key))
    .map((c) => ({
      key: String(c.key),
      name: String(c.name || c.key),
      // 与网页端判定口径一致：只有显式 false 才算禁用
      enabled: c.enabled !== false,
    }));
  return out.length ? out : DEFAULT_CUSTOM_CHANNELS;
}

/** 拉取自定义收款渠道配置；失败由调用方决定是否回退到本地缓存 */
export async function fetchCustomChannels(baseUrl: string): Promise<CustomChannel[]> {
  const res = await apiFetch(`${baseUrl}/api/settings`);
  if (!res.ok || res.json?.code !== 0) {
    throw new Error(res.json?.msg || `拉取渠道配置失败 HTTP ${res.status}`);
  }
  return normalize(res.json.data?.customChannels);
}

export function normalizeCustomChannels(list: any): CustomChannel[] {
  return normalize(list);
}
