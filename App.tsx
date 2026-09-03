import { useState, useEffect, useCallback, useRef } from 'react';
import { StyleSheet, View, Text, TouchableOpacity, Platform, AppState, Alert } from 'react-native';
import { StatusBar as ExpoStatusBar } from 'expo-status-bar';
import { DEFAULT_STORE_BASE_URL, DEVICE_ID, SYNC_INTERVAL_MS, loadDeviceId, loadBaseUrl, saveBaseUrl, refreshApiToken, loadSyncPrefs, saveSyncPrefs, loadOnboarding, saveOnboarding, type SyncPrefs } from './src/config';
import { ThemeProvider, useTheme } from './src/theme/ThemeProvider';
import {
  fetchAndCacheSnapshot,
  getUnsyncedDraftCount,
  getUnsyncedRevenueDraftCount,
  getUnsyncedBarrelPressCount,
  getUnsyncedBarrelRefundCount,
} from './src/db/localDb';
import { runSync } from './src/sync/syncEngine';
import { startSyncListener } from './src/sync/syncListener';
import { isOnStoreLan } from './src/net/lan';
import { SafeAreaRoot } from './src/components/SafeArea';
import type { TabKey, SyncState } from './src/nav';

import OverviewScreen from './src/screens/OverviewScreen';
import BusinessScreen from './src/screens/BusinessScreen';
import BarrelWaterScreen from './src/screens/BarrelWaterScreen';
import GoodsScreen from './src/screens/GoodsScreen';
import Settings from './src/screens/Settings';
import LoginScreen from './src/screens/LoginScreen';
import EntryForm from './src/screens/EntryForm';
import RevenueForm from './src/screens/RevenueForm';
import RecordDetail from './src/screens/RecordDetail';

const TABS: { key: TabKey; label: string; icon: string }[] = [
  { key: 'home', label: '首页', icon: '🏠' },
  { key: 'business', label: '经营', icon: '🧾' },
  { key: 'barrel', label: '桶装水', icon: '💧' },
  { key: 'goods', label: '商品', icon: '📦' },
  { key: 'mine', label: '我的', icon: '👤' },
];

/**
 * 待同步总数 = 进货草稿 + 营收草稿 + 桶装水压桶/退桶，四条独立队列必须一起算。
 *
 * 收敛成一个函数而不是在三处各写一遍 `a() + b()`：这个表达式有三个调用点
 * （初始值 / refreshPending / tick 闸门），漏改任何一处的后果都不一样且都很隐蔽 ——
 * 尤其是 tick 闸门漏算营收/桶装水时，会出现「只有该类草稿时 runSync 根本不被调用，
 * 电脑早开机了那笔数据却永远推不上去」。
 *
 * 全程 try/catch：它同时被 useState 惰性初始化在 **render 阶段**调用，
 * 此时抛错没有 ErrorBoundary 接，整棵树会卸载 → 白屏。计数宁可显示 0 也不能崩。
 */
function totalUnsyncedCount(): number {
  try {
    return (
      getUnsyncedDraftCount() +
      getUnsyncedRevenueDraftCount() +
      getUnsyncedBarrelPressCount() +
      getUnsyncedBarrelRefundCount()
    );
  } catch (e: any) {
    console.warn('[App] count unsynced failed:', e?.message || e);
    return 0;
  }
}

export default function App() {
  return (
    <ThemeProvider>
      <AppInner />
    </ThemeProvider>
  );
}

function AppInner() {
  const { theme, mode } = useTheme();
  const [tab, setTab] = useState<TabKey>('home');
  const [baseUrl, setBaseUrl] = useState(DEFAULT_STORE_BASE_URL);
  // 惰性初始化而不是先 0 再等 effect 刷：冷启动首帧就显示真实待同步数，
  // 离线打开 App 时用户第一眼看到的就是「待同步 3」，而不是先闪一下 0。
  const [pendingCount, setPendingCount] = useState(() => totalUnsyncedCount());
  const [lanOn, setLanOn] = useState(false);
  // 同步开关（设置页持久化）：自动同步总闸 + 仅店铺 WiFi 同步
  const [syncPrefs, setSyncPrefs] = useState<SyncPrefs>({ autoSync: true, wifiOnly: true });
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState('');
  const [cacheVersion, setCacheVersion] = useState(0);
  const [liveOn, setLiveOn] = useState(false);
  // 首次连接引导：未引导（done=false）时显示「连接店铺」登录页；连上或离线跳过后才进主界面
  const [onboarded, setOnboarded] = useState(false);

  // 模态
  const [entryEditId, setEntryEditId] = useState<string | undefined>();
  const [showEntry, setShowEntry] = useState(false);
  const [showRevenue, setShowRevenue] = useState(false);
  const [revenueEditId, setRevenueEditId] = useState<string | undefined>();
  // kind 'revenueDraft'：尚未推送到服务端的本机营收草稿（离线记的那一笔）
  const [detail, setDetail] = useState<{
    kind: 'revenue' | 'purchase' | 'draft' | 'revenueDraft';
    id: string;
  } | null>(null);

  // 计数口径统一为"所有未落到服务端的草稿"（pending + syncing + conflict），
  // 且**进货 + 营收两条队列都算**。
  // 之前用 getPendingDrafts()（只认 'pending'），一旦草稿卡在 'syncing'，
  // 概览「待同步草稿」就显示 0，而明细页却列着这条草稿 —— 两边对不上就是这么来的。
  //
  // 这里是纯本地 SQLite 计数，和后端是否可达无关 —— 电脑关机时它照样准。
  // totalUnsyncedCount 内部已吞异常（读库失败返回 0），不会把 effect 抛崩成白屏。
  const refreshPending = useCallback(() => {
    setPendingCount(totalUnsyncedCount());
  }, []);

  // 用 ref 兜住"是否正在同步"：
  // 原来只用 state 做闸门（if (syncing) return），闭包里拿到的是旧值，
  // 定时器 / SSE 回调持有过期闭包时闸门会失效，导致两次 runSync 并发跑同一批草稿。
  const syncingRef = useRef(false);

  // 地址变更：更新内存态并落盘，保证 App 重启后用户设置的（店外/公网）地址依然生效
  const handleBaseUrlChange = useCallback((v: string) => {
    setBaseUrl(v);
    saveBaseUrl(v);
  }, []);

  // 同步开关变更：更新内存态并落盘（下次启动照样生效）
  const handleSyncPrefsChange = useCallback((p: SyncPrefs) => {
    setSyncPrefs(p);
    void saveSyncPrefs(p);
  }, []);

  // 测试与店铺后端的连通性（容错：自动补 http:// 前缀）
  //
  // 必须自带超时：店里电脑一关机，这个地址就变成"没有主机应答"而不是"连接被拒绝"，
  // 裸 fetch 不会快速失败，而是挂到平台默认超时（iOS 60s）。用户按下「测试连接」后
  // 整整一分钟没有任何反馈，只会以为 App 卡死了。这里沿用 api/client.ts 里同一套
  // Promise.race 超时写法（零新依赖），6s 没应答就判定不可达。
  const testConnection = useCallback(async (url: string) => {
    const u = (url || '').trim();
    const full = /^https?:\/\//.test(u) ? u : `http://${u}`;
    const timeout = (ms: number) =>
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('连接超时')), ms));
    try {
      const res = (await Promise.race([
        fetch(`${full}/api/revenue`, { method: 'GET' }),
        timeout(6000),
      ])) as Response;
      const text = await res.text();
      const looksLikeHtml = text.trimStart().startsWith('<!DOCTYPE') || text.trimStart().startsWith('<html') || text.trimStart().startsWith('<');
      if (looksLikeHtml) {
        return { ok: false, msg: `返回的是网页而不是接口，请检查端口（正确端口通常是 :3001 或 :8089，不是 :8081 等前端页面端口）` };
      }
      let body: any = null;
      try { body = text ? JSON.parse(text) : null; } catch { /* ignore */ }
      const isApiJson = body && (Array.isArray(body) || Array.isArray(body.data) || typeof body.code === 'number');
      const ok = (res.ok || res.status === 401) && isApiJson;
      return { ok, msg: ok ? '连接成功，可正常使用' : `服务器返回 ${res.status}，但内容不是有效接口数据` };
    } catch (e: any) {
      let tip = '店铺电脑未开机时属正常，录入的草稿会先存本机';
      if (/:\s*8089/.test(full)) tip = ':8089 生产后端当前未启动，开发测试请改用 :3001';
      else if (/:\s*8081/.test(full)) tip = ':8081 是前端页面端口，请改用 :3001 或 :8089';
      return { ok: false, msg: `连接失败：${e?.message || '网络不可达'}（${tip}）` };
    }
  }, []);

  // 首次连接引导：连接店铺 / 离线使用 / 退出登录重置
  const handleConnect = useCallback((url: string) => {
    setBaseUrl(url);
    void saveBaseUrl(url);
    // 连接成功后立即用新地址拉取并缓存接口令牌：避免首笔 OCR 多走一次 bootstrap，
    // 也消除「bootstrap 曾返回空令牌被缓存」导致连上后依旧 401 的边界。
    void refreshApiToken();
    void saveOnboarding({ done: true, mode: 'connected' });
    setOnboarded(true);
  }, []);
  const handleSkip = useCallback(() => {
    void saveOnboarding({ done: true, mode: 'offline' });
    setOnboarded(true);
  }, []);
  const handleLogout = useCallback(() => {
    void saveOnboarding({ done: false, mode: 'offline' });
    setOnboarded(false);
  }, []);

  const refreshCache = useCallback(async () => {
    try {
      await fetchAndCacheSnapshot(baseUrl);
      setCacheVersion((v) => v + 1);
    } catch {
      /* 离线或失败：保留旧缓存 */
    }
  }, [baseUrl]);

  // 离线安全：这里只有 try/finally 时，runSync 一旦抛错就会原样往外冒 ——
  // 而它的所有调用点（tick 定时器、「同步全部」按钮、EntryForm 保存回调）
  // 都是不接 catch 的浮空 promise，最终变成未捕获 rejection。
  // 更要命的是启动时 `await tickRef.current()` 的成败门控着轮询定时器的创建（见下方 effect），
  // 抛一次就再也没有自动同步了。所以这里必须自己吃掉异常，只留一行 console.warn。
  // manual=true 表示用户手动点了「同步全部」：这种场景必须给结果反馈。
  // 之前失败原因只写进 syncMsg，而 syncMsg 只在首页渲染 —— 在「经营 / 草稿箱」
  // 页点同步，成功失败都看不到任何提示，用户只会觉得「点了没反应」。
  const doSync = useCallback(async (manual = false) => {
    if (syncingRef.current) return; // ref 闸门：并发/过期闭包都拦得住
    syncingRef.current = true;
    setSyncing(true);
    try {
      const res = await runSync(baseUrl, DEVICE_ID, setSyncMsg);
      if (res.reason && res.reason !== 'ok') {
        setSyncMsg(res.message || '同步未完成');
        if (manual) Alert.alert('同步未完成', res.message || '请稍后重试');
      } else if (res.failed > 0) {
        setSyncMsg(res.message || '部分单据同步失败');
        if (manual) Alert.alert('同步结束', res.message || '部分单据同步失败，稍后自动重试');
      } else if (manual) {
        Alert.alert('同步完成', res.message || '草稿已推送到电脑端');
      }
      if (await isOnStoreLan()) await refreshCache();
    } catch (e: any) {
      // 后端不可达是常态（店里电脑关机），不弹窗、不打断录入，下一轮自动重试
      console.warn('[App] doSync failed, will retry next tick:', e?.message || e);
      setSyncMsg('同步未完成，稍后自动重试');
      if (manual) Alert.alert('同步未完成', e?.message || '发生异常，稍后自动重试');
    } finally {
      syncingRef.current = false;
      setSyncing(false);
      refreshPending();
    }
  }, [baseUrl, refreshCache, refreshPending]);

  useEffect(() => {
    refreshPending();
  }, [tab, refreshPending]);

  // 定时任务始终调用最新一版 tick，这样 effect 依赖里就不必再放 doSync/syncing，
  // 从根上消掉"依赖一变就重建定时器"的抖动。
  //
  // tick 自己吞掉所有异常：它同时被启动流程 await、被定时器调用、被 AppState 恢复调用，
  // 任何一处抛出都会变成未捕获 rejection，启动流程那一处还会连带掐死定时器（见下方 effect）。
  const tickRef = useRef<() => Promise<void>>(async () => {});
  tickRef.current = async () => {
    try {
      const onLan = await isOnStoreLan(); // 内部已 catch，失败返回 false
      setLanOn(onLan);
      // 自动同步总闸：关掉后纯离线，只录本地，既不推送也不拉快照
      if (!syncPrefs.autoSync) return;
      // 仅店铺 WiFi 同步：开启时只有连上店铺局域网才同步；关掉则任意可达网络都同步
      if (syncPrefs.wifiOnly && !onLan) return;
      if (!onLan) return; // 不在店铺网段：纯离线态，只录本地，不做任何网络动作
      // 闸门必须用「进货 + 营收」的总数：只数进货的话，用户离线只记了营收时
      // 这里恒为 0 → 永远走 refreshCache 分支 → runSync 一次都不被调用 →
      // 电脑开机联网了，那笔营收还是躺在手机里推不出去。
      // 计数含被回收的孤儿草稿，卡住的单据这里就能重新排进同步队列。
      if (totalUnsyncedCount() > 0) await doSync();
      else await refreshCache();
    } catch (e: any) {
      console.warn('[App] sync tick failed:', e?.message || e);
    }
  };

  // 连 LAN 自动同步 + 拉取快照
  useEffect(() => {
    let alive = true;
    let iv: ReturnType<typeof setInterval> | undefined;
    (async () => {
      // 整段包 try/catch 的原因（离线首启动的真实故障）：
      //   原来 `await tickRef.current()` 是**裸 await**，而它下面才是 setInterval 的赋值。
      //   只要首个 tick 抛一次（例如某条草稿的 images 是坏 JSON，会从 runSync 一路冒上来），
      //   后面的 `iv = setInterval(...)` 就永远执行不到 ——
      //   于是轮询定时器压根没建起来，App 从此再也不会自动同步，直到用户重启进程。
      //   现象正是"电脑开机联网了，手机却一直不同步"。
      //   现在 tick 内部已自吞异常，这里再兜一层，保证**无论如何都会走到建定时器那一步**。
      try {
        await loadDeviceId(); // 先固化设备标识，确保首次同步即带稳定 deviceId
        const savedUrl = await loadBaseUrl(); // 恢复用户已保存的店铺后端地址（支持店外/公网地址）
        if (!alive) return;
        if (savedUrl) setBaseUrl(savedUrl);
        const prefs = await loadSyncPrefs(); // 恢复同步开关设置
        if (!alive) return;
        setSyncPrefs(prefs);
        const ob = await loadOnboarding(); // 恢复连接引导状态
        if (!alive) return;
        setOnboarded(ob.done);
        await tickRef.current();
      } catch (e: any) {
        console.warn('[App] sync bootstrap failed, timer still installed:', e?.message || e);
      }
      // 关键：await 之后必须重新确认 alive。
      // 之前 iv 是在 await tick() 之后才赋值的，而 cleanup 是同步执行的 ——
      // 只要在这段 await 期间依赖变化（syncing/doSync 每次同步都会变两次），
      // cleanup 就会带着 iv === undefined 空跑，随后这里再建一个**永远不会被清掉**的定时器。
      // 定时器越堆越多 → 多个 runSync 并发抢同一批草稿 → 状态互相覆盖。
      if (!alive) return;
      iv = setInterval(() => {
        void tickRef.current();
      }, SYNC_INTERVAL_MS);
    })();
    return () => {
      alive = false;
      if (iv) clearInterval(iv);
    };
  }, [baseUrl]);

  // 切回前台立刻探一次：iOS 把 App 挂起时 setInterval 是冻结的，
  // 用户"打开手机 → 发现电脑已经开机"这个场景下，干等 15s 才同步体验很差。
  // RN 内置 AppState，零新增依赖；tick 自身已吞异常，这里只做订阅与清理。
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') void tickRef.current();
    });
    return () => sub.remove();
  }, []);

  // #10 实时双向同步：订阅服务端 SSE，收到任意数据变更广播即刷新本地快照
  useEffect(() => {
    const handle = startSyncListener(
      baseUrl,
      async () => {
        // 服务端数据变更广播 → 立即拉取最新快照写本地缓存（概览/明细/报表消费）
        await refreshCache();
      },
      (connected) => setLiveOn(connected)
    );
    return () => handle.stop();
  }, [baseUrl, refreshCache]);

  const sync: SyncState = { pendingCount, lanOn, syncing, syncMsg, live: liveOn };

  const openEntry = (editId?: string) => {
    setEntryEditId(editId);
    setShowEntry(true);
  };

  const S = theme.size;
  const styles = StyleSheet.create({
    root: { flex: 1, backgroundColor: theme.color.bgApp },
    content: { flex: 1 },
    tabbar: {
      flexDirection: 'row',
      backgroundColor: theme.color.surfaceApp,
      borderTopWidth: 1,
      borderTopColor: theme.color.borderApp,
      // C3：iOS 底部内缩由 SafeAreaRoot（四边 inset）负责；
      //     Android 无 Home Indicator，补一点留白避免贴到手势条
      height: S.tabbarH + (Platform.OS === 'android' ? 8 : 0),
      paddingBottom: Platform.OS === 'android' ? 8 : 0,
    },
    tabItem: { flex: 1, alignItems: 'center', justifyContent: 'center' },
    tabIcon: { fontSize: 20, marginBottom: 2, opacity: 0.55 },
    tabLabel: { fontSize: theme.font.sizeV4.micro, color: theme.color.textAppTertiary },
    tabActive: { color: theme.color.navIndicator, opacity: 1, fontWeight: theme.font.weight.semibold },
    modal: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: theme.color.bgApp },
  });

  if (!onboarded) {
    return (
      <SafeAreaRoot style={styles.root}>
        <ExpoStatusBar style={mode === 'light' ? 'dark' : 'light'} />
        <LoginScreen initialUrl={baseUrl} onConnect={handleConnect} onSkip={handleSkip} />
      </SafeAreaRoot>
    );
  }

  return (
    // 安全区根容器：原先这里写的是 paddingTop: StatusBar.currentHeight，
    // 而 StatusBar.currentHeight 是 Android-only，iOS 上恒为 undefined → 内边距 0，
    // 顶部导航栏（取消/保存）被状态栏、刘海、灵动岛盖住点不到。
    // 注意：根节点的 inset 只在 Android（真 Yoga paddingTop）会传导到下面几个
    // 绝对定位 overlay；iOS 上 RCTSafeAreaView 的 inset 传不到四边钉死的绝对定位子节点，
    // 所以 EntryForm / RevenueForm / RecordDetail 的 header 各自用 SafeAreaHeader 补顶部安全区。
    <SafeAreaRoot style={styles.root}>
      <ExpoStatusBar style={mode === 'light' ? 'dark' : 'light'} />

      <View style={styles.content}>
        {tab === 'home' && (
          <OverviewScreen key={cacheVersion} sync={sync} onNavigate={setTab} onOpenDetail={setDetail} />
        )}
        {tab === 'business' && (
          <BusinessScreen
            sync={sync}
            onNavigate={setTab}
            onNewPurchase={() => openEntry()}
            onNewRevenue={() => {
              setRevenueEditId(undefined);
              setShowRevenue(true);
            }}
            onEditDraft={(id) => openEntry(id)}
            onEditRevenueDraft={(id) => {
              setRevenueEditId(id);
              setShowRevenue(true);
            }}
            onOpenDetail={setDetail}
            onSyncAll={() => void doSync(true)}
            onRefreshPending={refreshPending}
          />
        )}
        {tab === 'barrel' && <BarrelWaterScreen sync={sync} cacheVersion={cacheVersion} onSyncAll={() => void doSync(true)} />}
        {tab === 'goods' && <GoodsScreen sync={sync} cacheVersion={cacheVersion} />}
        {tab === 'mine' && (
          <Settings baseUrl={baseUrl} onBaseUrlChange={handleBaseUrlChange} onTestConnection={testConnection} sync={sync} syncPrefs={syncPrefs} onSyncPrefsChange={handleSyncPrefsChange} onLogout={handleLogout} />
        )}
      </View>

      {/* 底部 Tab 栏 */}
      <View style={styles.tabbar}>
        {TABS.map((t) => {
          const active = tab === t.key;
          return (
            <TouchableOpacity key={t.key} style={styles.tabItem} onPress={() => setTab(t.key)}>
              <Text style={[styles.tabIcon, active && styles.tabActive]}>{t.icon}</Text>
              <Text style={[styles.tabLabel, active && styles.tabActive]}>{t.label}</Text>
            </TouchableOpacity>
          );
        })}
      </View>

      {/* 模态：新建/编辑进货单 */}
      {showEntry && (
        <View style={styles.modal}>
          <EntryForm
            editId={entryEditId}
            baseUrl={baseUrl}
            onSaved={() => {
              setShowEntry(false);
              setEntryEditId(undefined);
              refreshPending();
              // 存本地已经完成了，这次同步纯属"顺手试一下"：
              // 后端不可达时 doSync 内部静默失败，草稿原样留在本机等下一轮。
              if (lanOn) void doSync();
            }}
            onCancel={() => {
              setShowEntry(false);
              setEntryEditId(undefined);
            }}
          />
        </View>
      )}

      {/* 模态：记一笔营收 / 编辑营收草稿 */}
      {showRevenue && (
        <View style={styles.modal}>
          <RevenueForm
            baseUrl={baseUrl}
            lanOn={lanOn}
            editId={revenueEditId}
            onSaved={() => {
              setShowRevenue(false);
              setRevenueEditId(undefined);
              // 营收现在也是「先落本机草稿」，所以和进货一样：先刷计数，
              // 再顺手试一次同步（后端不可达时 doSync 内部静默失败，草稿留在本机等下一轮）。
              // 原来这里只调 refreshCache()，那是个浮空 promise，且离线时必然失败 —— 白跑一趟。
              refreshPending();
              if (lanOn) void doSync();
            }}
            onCancel={() => {
              setShowRevenue(false);
              setRevenueEditId(undefined);
            }}
          />
        </View>
      )}

      {/* 模态：记录详情（只读） */}
      {detail && (
        <View style={styles.modal}>
          <RecordDetail
            rec={detail}
            baseUrl={baseUrl}
            onClose={() => setDetail(null)}
            onEdit={(id) => {
              setDetail(null);
              openEntry(id);
            }}
          />
        </View>
      )}
    </SafeAreaRoot>
  );
}
