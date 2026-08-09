// 商超台账·手机端 配置
// 与 3001 后端共用同一套接口约定（详见 server.js requireWriteAuth / /api/upload / /api/sync）
//
// ⚠️ 必须从 'expo-file-system/legacy' 导入：
//   Expo SDK 54 的 expo-file-system@19 换成了 File/Directory 新 API，
//   主入口的 documentDirectory 已被移除，getInfoAsync / readAsStringAsync /
//   writeAsStringAsync 变成"调用即 throw"的弃用桩（见 node_modules/expo-file-system/src/legacyWarnings.ts）。
//   之前这里从 'expo-file-system' 主入口导入，导致：
//     · DEVICE_ID 每次启动都是新随机值（持久化全被 catch 吞掉）→ 服务端无法稳定识别设备
//     · 用户在「设置」里保存的后端地址永远读不回来 → 每次启动都退回默认局域网地址
//   src/api/upload.ts 早就用的是 /legacy，这里对齐。
import * as FileSystem from 'expo-file-system/legacy';

// 接口鉴权 token：移动端不再把 token 硬写在鉴权主路径上（F-016）。
// 正常路径改由 getApiToken() 从服务端 /api/bootstrap（仅局域网内可拉）动态获取并缓存；
// FALLBACK_API_TOKEN 仅作 bootstrap 拉取失败时的兜底，避免改动导致手机端鉴权硬崩。
export const FALLBACK_API_TOKEN = 'c4d7aee83c3165e5b7e05e69f0ce9b170a6ff8d152d8f127';

// 店铺后端地址（局域网）。用户在「设置」页可覆盖，这里给默认。
// 注意：不要写死具体 IP——IP 会因路由器/电脑重启或 DHCP 续租而变化。
// 首次使用请在「设置」里填入电脑端【设置】页面显示的服务器地址。
export const DEFAULT_STORE_BASE_URL = 'http://<电脑局域网IP>:3001';

// 店铺 WiFi 子网（用于 UI 判断是否连上店铺局域网；同步触发以实际连通探测为准）
export const STORE_LAN_PREFIX = '192.168.3.';

// 自动同步轮询间隔（毫秒）
export const SYNC_INTERVAL_MS = 15000;

// 本地草稿数据库文件名
export const LOCAL_DB_NAME = 'retail_ledger.db';

// 本机设备标识（用于 push/pull 的 deviceId，区分不同手机）
// 必须稳定持久化：每次启动随机会让服务端无法稳定识别设备，破坏双向同步与冲突处理
export let DEVICE_ID = `phone-${Math.random().toString(36).slice(2, 10)}`;

const DEVICE_ID_FILE = (FileSystem.documentDirectory || '') + 'device_id.txt';

/** 启动时调用一次：读取或生成并持久化设备标识（幂等） */
export async function loadDeviceId(): Promise<void> {
  try {
    const info = await FileSystem.getInfoAsync(DEVICE_ID_FILE);
    if (info.exists) {
      const saved = (await FileSystem.readAsStringAsync(DEVICE_ID_FILE)).trim();
      if (saved) {
        DEVICE_ID = saved;
        return;
      }
    }
    const fresh = `phone-${Math.random().toString(36).slice(2, 10)}`;
    await FileSystem.writeAsStringAsync(DEVICE_ID_FILE, fresh);
    DEVICE_ID = fresh;
  } catch {
    /* 文件不可用时保留临时值，下次启动再尝试持久化 */
  }
}

// 店铺后端地址持久化文件（让用户在店外也能填公网/域名地址并永久生效）
const BASE_URL_FILE = (FileSystem.documentDirectory || '') + 'base_url.txt';

/** 读取已保存的店铺后端地址；未保存则返回 null（由调用方回退到 DEFAULT_STORE_BASE_URL） */
export async function loadBaseUrl(): Promise<string | null> {
  try {
    const info = await FileSystem.getInfoAsync(BASE_URL_FILE);
    if (info.exists) {
      const saved = (await FileSystem.readAsStringAsync(BASE_URL_FILE)).trim().replace(/\/+$/, '');
      if (saved) return saved;
    }
  } catch {
    /* 忽略读取失败，回退默认 */
  }
  return null;
}

/** 持久化店铺后端地址（去掉尾部斜杠，保证 fetch 拼接路径正确） */
export async function saveBaseUrl(url: string): Promise<void> {
  try {
    await FileSystem.writeAsStringAsync(BASE_URL_FILE, (url || '').trim().replace(/\/+$/, ''));
  } catch {
    /* 忽略写入失败，内存态仍生效 */
  }
}

// 接口鉴权 token 动态获取（F-016）：优先返回已缓存的动态 token；未缓存则从
// /api/bootstrap 拉取（服务端仅向同源/局域网设备下发）。bootstrap 失败（离线/未配置服务器）
// 时回退到 FALLBACK_API_TOKEN，确保鉴权不硬崩。
let _apiToken: string | null = null;
let _tokenFetching = false;
export async function getApiToken(): Promise<string> {
  if (_apiToken) return _apiToken;
  if (_tokenFetching) {
    for (let i = 0; i < 50 && !_apiToken; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    if (_apiToken) return _apiToken;
  }
  _tokenFetching = true;
  try {
    const base = (await loadBaseUrl()) || DEFAULT_STORE_BASE_URL;
    const r = await fetch(`${base}/api/bootstrap`);
    if (r.ok) {
      const j = (await r.json()) as { apiToken?: string };
      _apiToken = j.apiToken || '';
    }
  } catch {
    /* 离线/网络不通：token 保持空，调用方会因 401 提示先配置服务器地址 */
  } finally {
    _tokenFetching = false;
  }
  return _apiToken || FALLBACK_API_TOKEN;
}
