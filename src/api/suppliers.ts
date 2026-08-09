import { apiFetch } from './client';

// 供应商名称自动补全的数据源。
// 后端 3001 提供 GET /api/suppliers；这里对返回形态做容错（数组 / {suppliers} / {data} / 字符串或对象）。
export async function fetchSuppliers(baseUrl: string): Promise<string[]> {
  try {
    const res = await apiFetch(`${baseUrl}/api/suppliers`, { method: 'GET' });
    if (!res.ok) return [];
    const body = res.json || {};
    const raw: any[] = Array.isArray(body)
      ? body
      : Array.isArray(body.suppliers)
        ? body.suppliers
        : Array.isArray(body.data)
          ? body.data
          : [];
    const names = raw
      .map((s) => (typeof s === 'string' ? s : (s?.name ?? s?.supplierName ?? '').toString()))
      .map((n) => (n || '').trim())
      .filter(Boolean);
    return Array.from(new Set(names));
  } catch {
    // 离线 / 超时：返回空，由调用方回退到本地缓存的供应商名
    return [];
  }
}
