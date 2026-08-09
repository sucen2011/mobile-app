import { apiFetch } from './client';

export interface PurchaseRecord {
  id: string;
  orderNo: string;
  date: string;
  supplierName: string;
  supplierId?: string;
  totalAmount: number;
  paidAmount?: number;
  paid?: boolean;
  items?: { name: string; quantity: number; unit: string; price: number; amount: number }[];
  images?: string[];
  note?: string;
  createdAt?: number;
}

export interface ImageMeta {
  id: number;
  original_url: string;
  hd_url?: string;
  file_size?: number;
  upload_terminal?: 'mobile' | 'pc';
  image_tag?: string;
  created_at: string;
  pc_preview_enabled?: number;
}

export interface DisplayRule {
  offsetDays: number;
  enabled: boolean;
}

export async function fetchDisplayRule(baseUrl: string): Promise<DisplayRule> {
  const res = await apiFetch(`${baseUrl}/api/display-rule`);
  if (!res.ok || res.json?.code !== 0) {
    return { offsetDays: 1, enabled: true };
  }
  return res.json.data as DisplayRule;
}

export async function fetchPurchases(
  baseUrl: string,
  opts?: { startDate?: string; endDate?: string; keyword?: string }
): Promise<PurchaseRecord[]> {
  const qs = new URLSearchParams();
  if (opts?.startDate) qs.append('startDate', opts.startDate);
  if (opts?.endDate) qs.append('endDate', opts.endDate);
  if (opts?.keyword) qs.append('keyword', opts.keyword);
  const query = qs.toString() ? `?${qs.toString()}` : '';
  const res = await apiFetch(`${baseUrl}/api/purchases${query}`);
  if (!res.ok || res.json?.code !== 0) {
    throw new Error(res.json?.msg || `拉取明细失败 HTTP ${res.status}`);
  }
  return (res.json.data || []) as PurchaseRecord[];
}

export async function fetchImagesByOrder(baseUrl: string, orderNo: string): Promise<ImageMeta[]> {
  const res = await apiFetch(`${baseUrl}/api/images?orderNo=${encodeURIComponent(orderNo)}`);
  if (!res.ok || res.json?.code !== 0) {
    throw new Error(res.json?.msg || `拉取图片失败 HTTP ${res.status}`);
  }
  return (res.json.data || []) as ImageMeta[];
}

// 反向同步辅助：拉取「哪些单据有电脑端原图」的汇总（orderNo -> pc图片数）。
// 列表态打 💻 标记用，单次请求覆盖全部单据，避免对每条单据发轮询请求。
export async function fetchPcImageSummary(baseUrl: string): Promise<Record<string, number>> {
  const res = await apiFetch(`${baseUrl}/api/pc-image-summary`);
  if (!res.ok || res.json?.code !== 0) {
    return {};
  }
  return (res.json.data || {}) as Record<string, number>;
}
