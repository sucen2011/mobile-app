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
// 正常路径由 getApiToken() 从服务端 /api/bootstrap（仅局域网内可拉）动态获取并缓存；
// 离线/未配置服务器时 token 保持空，调用方会因 401 提示先配置店铺服务器地址（不再内置硬编码兜底 token）。

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
// 时 token 保持空，由调用方按 401 提示用户先配置店铺服务器地址。
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
      // 只在真正拿到 token 时缓存：bootstrap 返回 200 但 apiToken 为空（如非店铺网段）时，
      // 不能把 '' 当成「已鉴权」缓存住——否则换地址/连上店铺 WiFi 后也不会重新拉取，
      // 表现为「连上了但 OCR 一直 401」。留空则下次请求惰性重试。
      if (j.apiToken) _apiToken = j.apiToken;
    }
  } catch {
    /* 离线/网络不通：token 保持空，调用方会因 401 提示先配置服务器地址 */
  } finally {
    _tokenFetching = false;
  }
  return _apiToken || ''; // 不再回退硬编码 token
}

/** 手动刷新接口 Token：清空缓存后重新从 /api/bootstrap 拉取（离线则返回空）。 */
export async function refreshApiToken(): Promise<string> {
  _apiToken = null;
  _tokenFetching = false;
  return getApiToken();
}

// ============ 同步设置（用户可控）============
// 同步开关只在「设置」页持久化，App 启动读取后喂给同步引擎。
// 默认两项都开启：小店场景下「连上就自动同步」最符合直觉；
// 用户想省流量 / 临时不让手机上传，关掉「自动同步」即可。
export interface SyncPrefs {
  autoSync: boolean; // 自动同步总开关
  wifiOnly: boolean; // 仅店铺 WiFi 同步（关掉则任意可达网络都同步）
}
const SYNC_PREFS_FILE = (FileSystem.documentDirectory || '') + 'sync_prefs.json';
const DEFAULT_SYNC_PREFS: SyncPrefs = { autoSync: true, wifiOnly: true };

export async function loadSyncPrefs(): Promise<SyncPrefs> {
  try {
    const info = await FileSystem.getInfoAsync(SYNC_PREFS_FILE);
    if (info.exists) {
      const raw = JSON.parse((await FileSystem.readAsStringAsync(SYNC_PREFS_FILE)) || '{}');
      return {
        autoSync: raw.autoSync !== false,
        wifiOnly: raw.wifiOnly !== false,
      };
    }
  } catch {
    /* 读取失败回退默认 */
  }
  return { ...DEFAULT_SYNC_PREFS };
}

export async function saveSyncPrefs(p: SyncPrefs): Promise<void> {
  try {
    await FileSystem.writeAsStringAsync(SYNC_PREFS_FILE, JSON.stringify(p));
  } catch {
    /* 写入失败：内存态仍生效，下次启动回退默认 */
  }
}

// ============ 主题模式持久化 ============
// 浅色默认（对齐 Ardot 移动端视觉稿 visual-base-v1）；用户对主题的切换在重启后保持。
// 沿用与 DEVICE_ID / SyncPrefs 同一套 expo-file-system/legacy 文件持久化，不引入 AsyncStorage 依赖。
export type ThemeMode = 'light' | 'dark';
const THEME_MODE_FILE = (FileSystem.documentDirectory || '') + 'theme_mode.txt';

export async function loadThemeMode(): Promise<ThemeMode> {
  try {
    const info = await FileSystem.getInfoAsync(THEME_MODE_FILE);
    if (info.exists) {
      const saved = (await FileSystem.readAsStringAsync(THEME_MODE_FILE)).trim();
      if (saved === 'dark' || saved === 'light') return saved;
    }
  } catch {
    /* 读取失败回退浅色 */
  }
  return 'light';
}

export async function saveThemeMode(mode: ThemeMode): Promise<void> {
  try {
    await FileSystem.writeAsStringAsync(THEME_MODE_FILE, mode);
  } catch {
    /* 写入失败：内存态仍生效 */
  }
}

// ============ 本地操作员档案（账号管理）============
// 手机端为设备绑定的录入端，无独立账号体系（角色/权限在电脑端管理，手机端已移除）。
// 这里的「账号」指本机操作员档案：谁在用这台手机录单。纯本地存储，离线可用，
// 与 DEVICE_ID / SyncPrefs / ThemeMode 同一套文件持久化机制。登录体系由后续 LoginScreen 扩展。
export interface AccountProfile {
  operatorName: string; // 操作员姓名（必填）
  phone: string; // 手机号（选填）
  storeName: string; // 本店名称（选填）
}
const ACCOUNT_PROFILE_FILE = (FileSystem.documentDirectory || '') + 'account_profile.json';
const DEFAULT_ACCOUNT_PROFILE: AccountProfile = { operatorName: '', phone: '', storeName: '' };

export async function loadAccountProfile(): Promise<AccountProfile> {
  try {
    const info = await FileSystem.getInfoAsync(ACCOUNT_PROFILE_FILE);
    if (info.exists) {
      const raw = JSON.parse((await FileSystem.readAsStringAsync(ACCOUNT_PROFILE_FILE)) || '{}');
      return {
        operatorName: raw.operatorName || '',
        phone: raw.phone || '',
        storeName: raw.storeName || '',
      };
    }
  } catch {
    /* 读取失败回退默认 */
  }
  return { ...DEFAULT_ACCOUNT_PROFILE };
}

export async function saveAccountProfile(p: AccountProfile): Promise<void> {
  try {
    await FileSystem.writeAsStringAsync(ACCOUNT_PROFILE_FILE, JSON.stringify(p));
  } catch {
    /* 写入失败：内存态仍生效 */
  }
}

// ============ 首次连接引导（登录 / 设备激活）============
// 后端无用户名/密码登录体系（静态 X-Api-Token，仅局域网内经 /api/bootstrap 下发），
// 手机端「登录」实为「首次连接店铺 + 拉取接口令牌」引导：填店铺服务器地址 → 测连通 → 拉 Token → 标记已激活。
// 离线优先：用户也可「稍后设置，离线使用」，进入 App 但仍先录本地、连上店铺 WiFi 再同步。
export interface OnboardingState {
  done: boolean;
  mode: 'connected' | 'offline';
}
const ONBOARDING_FILE = (FileSystem.documentDirectory || '') + 'onboarding.json';
const DEFAULT_ONBOARDING: OnboardingState = { done: false, mode: 'offline' };

export async function loadOnboarding(): Promise<OnboardingState> {
  try {
    const info = await FileSystem.getInfoAsync(ONBOARDING_FILE);
    if (info.exists) {
      const raw = JSON.parse((await FileSystem.readAsStringAsync(ONBOARDING_FILE)) || '{}');
      return {
        done: raw.done === true,
        mode: raw.mode === 'connected' ? 'connected' : 'offline',
      };
    }
  } catch {
    /* 读取失败回退未引导 */
  }
  return { ...DEFAULT_ONBOARDING };
}

export async function saveOnboarding(s: OnboardingState): Promise<void> {
  try {
    await FileSystem.writeAsStringAsync(ONBOARDING_FILE, JSON.stringify(s));
  } catch {
    /* 忽略写入失败 */
  }
}

/** 连接店铺服务器：探测可达性 +（局域网内）拉取接口令牌。返回 ok / msg / token。 */
export async function connectStore(url: string): Promise<{ ok: boolean; msg: string; token: string }> {
  const u = (url || '').trim();
  if (!u) return { ok: false, msg: '请填写店铺服务器地址', token: '' };
  const full = /^https?:\/\//.test(u) ? u : `http://${u}`;
  const timeout = (ms: number) => new Promise<never>((_, rej) => setTimeout(() => rej(new Error('连接超时')), ms));
  try {
    const b = (await Promise.race([fetch(`${full}/api/bootstrap`), timeout(6000)])) as Response;
    const text = await b.text();
    const looksLikeHtml = text.trimStart().startsWith('<!DOCTYPE') || text.trimStart().startsWith('<html') || text.trimStart().startsWith('<');
    if (looksLikeHtml) {
      return { ok: false, msg: `返回的是网页而不是接口，请检查端口（正确端口通常是 :3001 或 :8089，不是 :8081 等前端页面端口）`, token: '' };
    }
    let token = '';
    let reached = b.ok;
    if (b.ok) {
      try {
        const j = JSON.parse(text) as { apiToken?: string };
        token = j.apiToken || '';
      } catch {
        reached = false;
      }
    } else if (b.status === 403) {
      reached = true; // 服务器在线，但令牌仅局域网下发
    }
    if (!reached) return { ok: false, msg: `服务器无响应（HTTP ${b.status}）`, token: '' };
    return {
      ok: true,
      msg: token
        ? '连接成功，已获取接口令牌'
        : '已连上服务器（接口令牌需连店铺 WiFi 后自动获取）',
      token,
    };
  } catch (e: any) {
    let tip = '店铺电脑未开机时属正常，可先离线使用';
    if (/:\s*8089/.test(full)) tip = ':8089 生产后端当前未启动，开发测试请改用 :3001';
    else if (/:\s*8081/.test(full)) tip = ':8081 是前端页面端口，不是后端接口，请改用 :3001 或 :8089';
    return { ok: false, msg: `连接失败：${e?.message || '网络不可达'}（${tip}）`, token: '' };
  }
}
