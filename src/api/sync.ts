import { apiFetch } from './client';

export async function pushRecords(baseUrl: string, deviceId: string, records: any[]) {
  const res = await apiFetch(`${baseUrl}/api/sync/push`, {
    method: 'POST',
    body: JSON.stringify({ deviceId, records }),
  });
  return res.json;
}

export async function pullRecords(baseUrl: string, deviceId: string) {
  const res = await apiFetch(`${baseUrl}/api/sync/pull`, {
    method: 'POST',
    body: JSON.stringify({ deviceId }),
  });
  return res.json;
}
