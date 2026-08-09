import { getIpAddressAsync } from 'expo-network';
import { STORE_LAN_PREFIX } from '../config';

// 启发式：本机 IP 是否落在店铺子网（用于 UI 状态展示）
export async function isOnStoreLan(): Promise<boolean> {
  try {
    const ip = await getIpAddressAsync();
    return ip.startsWith(STORE_LAN_PREFIX);
  } catch {
    return false;
  }
}
