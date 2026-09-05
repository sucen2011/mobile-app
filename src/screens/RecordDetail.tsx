import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  Image,
  Modal,
  ActivityIndicator,
  Alert,
  Animated,
  PanResponder,
  Dimensions,
  BackHandler,
} from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import { useTheme } from '../theme/ThemeProvider';
import {
  getCachedPurchases,
  getCachedRevenues,
  getDraftById,
  getRevenueDraftById,
  getDayOffset,
  getCachedCustomChannels,
} from '../db/localDb';
import { formatDayLabel } from '../utils/dateLabel';
import { SafeAreaHeader, TOP_INSET, BOTTOM_INSET } from '../components/SafeArea';
import { FIXED_CHANNEL_KEYS, LEGACY_CHANNEL_LABELS } from '../api/settings';
import { fetchImagesByOrder, ImageMeta } from '../api/images';

interface Props {
  /** 'revenueDraft' = 尚未推送到服务端的本机营收草稿（离线记的那一笔） */
  rec: { kind: 'revenue' | 'purchase' | 'draft' | 'revenueDraft'; id: string };
  /** 服务端地址：进货单的图片是 /uploads/xxx 相对路径，必须拼成绝对地址才能渲染 */
  baseUrl: string;
  onClose: () => void;
  onEdit?: (id: string) => void;
}

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window');

/** 等宽三列网格：页面内边距 16*2 + 卡片内边距 16*2 + 两道 8pt 间隙 */

/** 图片列表轮询间隔：只拉元数据，不预下载二进制 */
const POLL_MS = 10000;
const NOTICE_MS = 3500;

function safeParseArray(s: unknown): any[] {
  if (Array.isArray(s)) return s;
  if (typeof s !== 'string' || !s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/** 一张图的引用：原图地址 + 可选的压缩预览图地址 */
interface ImageRef {
  original: string;
  hd: string;
}

/**
 * 从若干可能的字段里收集图片引用并去重。
 *
 * 为什么要兼容这么多字段名：草稿存的是本地相机 uri（images），
 * 服务端进货单来自 purchase_order.attachment（server.js:281 映射成 images），
 * 历史/其他写入方还可能用 imageUrls / attachments / photoPaths / attachment。
 * 少认一个字段的后果就是详情页一张图都不显示 —— 正是这次的故障现象。
 *
 * 去重口径（重要）：一律按 **原图地址 original_url** 归一化。
 * 旧实现是「先取 hd_url 当身份」，同一张原图只要压缩预览换了一版就会被当成两张，
 * 叠加 image_resource 按每次上传插行的行为，就是「一张变六张」的来源之一。
 */
function collectImageRefs(...sources: unknown[]): ImageRef[] {
  const out: ImageRef[] = [];
  const seen = new Set<string>();
  for (const src of sources) {
    for (const item of safeParseArray(src)) {
      // 可能是裸字符串，也可能是 { url } / { original_url } / { hd_url } 这类对象
      let original = '';
      let hd = '';
      if (typeof item === 'string') {
        original = item;
      } else if (item && typeof item === 'object') {
        original =
          item.original_url || item.url || item.uri || item.path || item.hd_url || '';
        hd = item.hd_url || '';
      }
      const key = String(original || '').trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push({ original: key, hd: String(hd || '').trim() });
    }
  }
  return out;
}

/** 兼容旧调用点：只要地址列表时用这个 */
function collectImageUris(...sources: unknown[]): string[] {
  return collectImageRefs(...sources).map((r) => r.original);
}

/**
 * 服务端 /api/images 的返回按 original_url 去重，**保留 id 最小的一条**。
 * image_resource 表按每次上传插行（既不按 file_hash 也不按 order_no 去重），
 * runSync 的重试路径又很密集，同一张照片会堆出 N 行 —— 不去重就是「一张变六张」。
 * 保留最小 id = 保留最早那次上传，后续重试产生的影子记录全部丢弃。
 */
function dedupeMetas(list: ImageMeta[]): ImageMeta[] {
  const byUrl = new Map<string, ImageMeta>();
  for (const m of list || []) {
    const key = String(m.original_url || m.hd_url || '').trim();
    if (!key) continue;
    const cur = byUrl.get(key);
    if (!cur || m.id < cur.id) byUrl.set(key, m);
  }
  return Array.from(byUrl.values()).sort((a, b) => a.id - b.id);
}

/** /uploads/xxx → http://host/uploads/xxx；本地 file:// 与已是绝对地址的原样返回 */
function toAbsolute(baseUrl: string, u: string): string {
  const s = String(u || '').trim();
  if (!s) return '';
  if (/^(https?:|file:|data:|content:|asset:)/i.test(s)) return s;
  const root = (baseUrl || '').replace(/\/+$/, '');
  return s.startsWith('/') ? `${root}${s}` : `${root}/${s}`;
}

/** 详情页统一的图片模型：草稿 / 服务端元数据 / 历史兜底字段都收敛到这里 */
interface Photo {
  /** 下载缓存文件名与各种 Set/Map 的键；兜底来源用负数，和服务端自增 id 不会撞 */
  id: number;
  /** 原图绝对地址（下载用） */
  originalUrl: string;
  /** 网络缩略图绝对地址；空串表示没有可直接渲染的预览图（走占位态） */
  thumbUrl: string;
  /** 已在本机的图（草稿的 file://）；服务端图下载后走 localUriMap */
  localUri?: string;
  fileSize?: number;
  terminal?: 'mobile' | 'pc';
}

const ZOOM_MAX = 6;
const DOUBLE_TAP_MS = 300;

function dist(a: { pageX: number; pageY: number }, b: { pageX: number; pageY: number }): number {
  const dx = a.pageX - b.pageX;
  const dy = a.pageY - b.pageY;
  return Math.sqrt(dx * dx + dy * dy);
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/**
 * 纯 RN 核心实现的图片缩放查看器（无损清晰版，搬自 DetailList）：
 * - 关键：按原图真实分辨率渲染（Image.getSize 取出 w/h），初始缩放 fit 到屏幕，
 *   再叠加 pinch/双击缩放。这样放大时是在放大原始高清图，不会糊。
 * - 双指捏合缩放（fit ~ fit*6）／单指拖动／双击在 fit 与 fit*2.5 间切换
 * 不依赖 gesture-handler / reanimated，避免原生链接风险。
 */
function ZoomableImage({ uri }: { uri: string }) {
  const { theme } = useTheme();
  const styles = makeStyles(theme);
  const scale = useRef(new Animated.Value(1)).current;
  const translate = useRef(new Animated.ValueXY({ x: 0, y: 0 })).current;
  const natural = useRef({ w: SCREEN_W, h: SCREEN_H });
  const st = useRef({ scale: 1, pinchBase: 1, pinchDist: 0, lastTap: 0, fit: 1 });
  const [ready, setReady] = useState(false);

  useEffect(() => {
    st.current.scale = 1;
    st.current.fit = 1;
    st.current.pinchDist = 0;
    st.current.lastTap = 0;
    translate.setValue({ x: 0, y: 0 });
    setReady(false);
    let cancelled = false;
    Image.getSize(
      uri,
      (w, h) => {
        if (cancelled) return;
        const fit = Math.min(SCREEN_W / w, SCREEN_H / h);
        natural.current = { w, h };
        st.current.fit = fit;
        st.current.scale = fit;
        scale.setValue(fit);
        setReady(true);
      },
      () => {
        if (cancelled) return;
        const fit = 1;
        natural.current = { w: SCREEN_W, h: SCREEN_H };
        st.current.fit = fit;
        st.current.scale = fit;
        scale.setValue(fit);
        setReady(true);
      }
    );
    return () => {
      cancelled = true;
    };
  }, [uri, scale, translate]);

  // 关键：PanResponder 挂在「查看区包裹层」上，而不是那张 4000x3000 的原图上。
  // 否则原图的超大布局盒会盖住顶部返回栏导致点不到、且手势区溢出到屏幕外。
  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (e) => {
        const t = e.nativeEvent.touches;
        if (t.length >= 2) {
          st.current.pinchDist = dist(t[0], t[1]);
          st.current.pinchBase = st.current.scale;
        } else if (t.length === 1) {
          const now = Date.now();
          if (now - st.current.lastTap < DOUBLE_TAP_MS) {
            const target =
              st.current.scale > st.current.fit * 1.1 ? st.current.fit : st.current.fit * 2.5;
            st.current.scale = target;
            Animated.spring(scale, { toValue: target, useNativeDriver: true }).start();
            Animated.spring(translate, { toValue: { x: 0, y: 0 }, useNativeDriver: true }).start();
          }
          st.current.lastTap = now;
        }
      },
      onPanResponderMove: (e, g) => {
        const t = e.nativeEvent.touches;
        if (t.length >= 2) {
          const d = dist(t[0], t[1]);
          if (st.current.pinchDist > 0) {
            const ns = clamp(
              st.current.pinchBase * (d / st.current.pinchDist),
              st.current.fit,
              st.current.fit * ZOOM_MAX
            );
            st.current.scale = ns;
            scale.setValue(ns);
          }
        } else if (t.length === 1 && st.current.scale > st.current.fit + 0.001) {
          const maxX = Math.max(0, (natural.current.w * st.current.scale - SCREEN_W) / 2);
          const maxY = Math.max(0, (natural.current.h * st.current.scale - SCREEN_H) / 2);
          translate.setValue({ x: clamp(g.dx, -maxX, maxX), y: clamp(g.dy, -maxY, maxY) });
        }
      },
      onPanResponderRelease: () => {
        st.current.pinchDist = 0;
        if (st.current.scale <= st.current.fit * 1.01) {
          st.current.scale = st.current.fit;
          Animated.spring(scale, { toValue: st.current.fit, useNativeDriver: true }).start();
          Animated.spring(translate, { toValue: { x: 0, y: 0 }, useNativeDriver: true }).start();
        }
      },
    })
  ).current;

  return (
    <View style={styles.viewerGestureArea} {...panResponder.panHandlers}>
      {!ready ? (
        <ActivityIndicator size="large" color="#fff" />
      ) : (
        <Animated.Image
          source={{ uri }}
          resizeMode="contain"
          style={[
            { width: natural.current.w, height: natural.current.h },
            { transform: [{ scale }, { translateX: translate.x }, { translateY: translate.y }] },
          ]}
        />
      )}
    </View>
  );
}

export default function RecordDetail({ rec, baseUrl, onClose, onEdit }: Props) {
  const { theme } = useTheme();
  const styles = makeStyles(theme);
  // ⚠️ hooks 必须全部声明在分支之前，不能塞进 if/else 里
  const [metas, setMetas] = useState<ImageMeta[] | null>(null);
  const [imgLoading, setImgLoading] = useState(false);
  const [localUriMap, setLocalUriMap] = useState<Record<number, string>>({});
  const [downloadingSet, setDownloadingSet] = useState<Set<number>>(new Set());
  const [thumbErrorSet, setThumbErrorSet] = useState<Set<number>>(new Set());
  const [notice, setNotice] = useState<string | null>(null);
  const [zoomIndex, setZoomIndex] = useState<number | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const offset = getDayOffset();

  // 三种记录都是同步 DB 读，memo 住是为了给下面的 effect 一个稳定依赖，
  // 否则每次 render 都是新对象引用 → 轮询 effect 无限重挂。
  const draft = useMemo(
    () => (rec.kind === 'draft' ? getDraftById(rec.id) : undefined),
    [rec.kind, rec.id]
  );
  const purchase = useMemo(
    () => (rec.kind === 'purchase' ? getCachedPurchases().find((x) => x.id === rec.id) : undefined),
    [rec.kind, rec.id]
  );
  const revenue = useMemo(
    () => (rec.kind === 'revenue' ? getCachedRevenues().find((x) => x.id === rec.id) : undefined),
    [rec.kind, rec.id]
  );
  // 本机营收草稿：还没推到服务端，缓存快照里查不到，只能读 revenue_drafts
  const revenueDraft = useMemo(
    () => (rec.kind === 'revenueDraft' ? getRevenueDraftById(rec.id) : undefined),
    [rec.kind, rec.id]
  );

  const purchaseRaw = useMemo<Record<string, any>>(() => {
    if (!purchase) return {};
    try {
      const v = JSON.parse(purchase.raw || '{}');
      return v && typeof v === 'object' ? v : {};
    } catch {
      return {};
    }
  }, [purchase]);

  const orderNo = draft?.orderNo || purchase?.orderNo || '';

  // 切换记录时清空上一条的图片态，否则会把上一单的缩略图/下载缓存带过来
  useEffect(() => {
    setMetas(null);
    setLocalUriMap({});
    setDownloadingSet(new Set());
    setThumbErrorSet(new Set());
    setZoomIndex(null);
    setNotice(null);
  }, [rec.kind, rec.id]);

  // 首次拉取服务端图片元数据（仅 purchase）：
  // 失败或空结果都不覆盖 metas（保持 null），渲染层自动回落到 collectImageRefs 的多字段兼容逻辑。
  useEffect(() => {
    if (rec.kind !== 'purchase' || !purchase) {
      setImgLoading(false);
      return;
    }
    let cancelled = false;
    setImgLoading(true);
    fetchImagesByOrder(baseUrl, purchase.orderNo)
      .then((list) => {
        if (cancelled) return;
        const deduped = dedupeMetas(list);
        setMetas(deduped.length ? deduped : null);
      })
      .catch(() => {
        if (cancelled) return;
        setMetas(null);
      })
      .finally(() => {
        if (!cancelled) setImgLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [rec.kind, purchase, baseUrl]);

  // 反向同步（电脑端→手机端）：打开 purchase 详情期间每 10s 拉一次图片列表，
  // 只拉元数据、绝不预下载二进制；发现电脑端新增才提示，用户点缩略图才真下载。
  // 关页即停，草稿不轮询。
  useEffect(() => {
    if (rec.kind !== 'purchase' || !purchase) return;
    const orderNoForPoll = purchase.orderNo;
    let stopped = false;
    const tick = async () => {
      try {
        const list = dedupeMetas(await fetchImagesByOrder(baseUrl, orderNoForPoll));
        if (stopped || !list.length) return;
        setMetas((prev) => {
          if (!prev) return list;
          const prevKeys = new Set(prev.map((m) => String(m.original_url || m.hd_url || '')));
          const added = list.filter((m) => !prevKeys.has(String(m.original_url || m.hd_url || '')));
          if (added.length === 0 && prev.length === list.length) return prev;
          const pcAdded = added.filter((m) => m.upload_terminal === 'pc').length;
          if (pcAdded > 0) {
            // 移出 updater 再触发通知，避免在 state 更新函数内直接 setState 的告警
            queueMicrotask(() => {
              setNotice(`💻 电脑端新增 ${pcAdded} 张原图，点击缩略图下载回看`);
              if (noticeTimer.current) clearTimeout(noticeTimer.current);
              noticeTimer.current = setTimeout(() => setNotice(null), NOTICE_MS);
            });
          }
          return list;
        });
      } catch {
        /* 轮询失败静默忽略，不阻断看图 */
      }
    };
    const timer = setInterval(tick, POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [rec.kind, purchase, baseUrl]);

  useEffect(
    () => () => {
      if (noticeTimer.current) clearTimeout(noticeTimer.current);
    },
    []
  );

  const photos = useMemo<Photo[]>(() => {
    if (rec.kind === 'draft') {
      if (!draft) return [];
      // 草稿的照片还没上传，是本机相机文件 uri，RN <Image> 可直接渲染 file://
      return collectImageUris(draft.images).map((u, i) => {
        const abs = toAbsolute(baseUrl, u);
        return { id: i + 1, originalUrl: abs, thumbUrl: '', localUri: abs };
      });
    }
    if (rec.kind === 'purchase') {
      if (!purchase) return [];
      if (metas && metas.length) {
        return metas.map((m) => {
          const original = toAbsolute(baseUrl, m.original_url || m.hd_url || '');
          const terminal: 'mobile' | 'pc' = m.upload_terminal === 'pc' ? 'pc' : 'mobile';
          // 只有压缩预览图（hd_url）才直接联网渲染；手机端原图动辄 3~5MB，
          // 拿原图当缩略图会把用户流量烧光 —— 那种情况一律走占位态，点了才下。
          const thumb = m.hd_url
            ? toAbsolute(baseUrl, m.hd_url)
            : terminal === 'pc'
            ? original
            : '';
          return {
            id: m.id,
            originalUrl: original,
            thumbUrl: thumb,
            fileSize: m.file_size,
            terminal,
          };
        });
      }
      // 兜底：/api/images 拉不到时沿用缓存列 images 与 raw 里的各种别名字段
      return collectImageRefs(
        purchase.images,
        purchaseRaw.images,
        purchaseRaw.imageUrls,
        purchaseRaw.attachments,
        purchaseRaw.attachment,
        purchaseRaw.photoPaths
      ).map((r, i) => ({
        id: -(i + 1),
        originalUrl: toAbsolute(baseUrl, r.original),
        thumbUrl: r.hd ? toAbsolute(baseUrl, r.hd) : '',
        terminal: 'mobile' as const,
      }));
    }
    return [];
  }, [rec.kind, draft, purchase, purchaseRaw, metas, baseUrl]);

  const downloadPhoto = useCallback(
    async (photo: Photo, index: number) => {
      if (localUriMap[photo.id] || downloadingSet.has(photo.id)) return;
      if (!photo.originalUrl) {
        Alert.alert('下载失败', '这张图片没有可用的原图地址');
        return;
      }
      setDownloadingSet((prev) => new Set(prev).add(photo.id));
      try {
        const rawExt = photo.originalUrl.split('.').pop()?.split('?')[0] || '';
        const ext = (rawExt.replace(/[^a-zA-Z0-9]/g, '') || 'jpg').slice(0, 5);
        // orderNo 可能带 / 或中文，直接拼进文件名会写到不存在的子目录里
        const safeOrderNo = (orderNo || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_');
        const localUri = `${(FileSystem as any).cacheDirectory}ledger_img_${safeOrderNo}_${photo.id}.${ext}`;
        const info = await FileSystem.getInfoAsync(localUri);
        if (!info.exists) {
          const download = await FileSystem.downloadAsync(photo.originalUrl, localUri);
          if (download.status !== 200) {
            throw new Error(`下载失败 HTTP ${download.status}`);
          }
        }
        setLocalUriMap((prev) => ({ ...prev, [photo.id]: localUri }));
        // 一次点击到位：下完直接开查看器定位到这张
        setZoomIndex(index);
      } catch (e: any) {
        Alert.alert('下载失败', e?.message || '无法下载原图');
      } finally {
        setDownloadingSet((prev) => {
          const next = new Set(prev);
          next.delete(photo.id);
          return next;
        });
      }
    },
    [localUriMap, downloadingSet, orderNo]
  );

  /** 已下载→直接开查看器；未下载→先下载，成功后自动开 */
  const openAt = useCallback(
    (index: number) => {
      const p = photos[index];
      if (!p) return;
      const local = p.localUri || localUriMap[p.id];
      if (local) setZoomIndex(index);
      else void downloadPhoto(p, index);
    },
    [photos, localUriMap, downloadPhoto]
  );

  // Android 物理返回键两级返回：先关看图器，再关整页
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (zoomIndex !== null) {
        setZoomIndex(null);
        return true;
      }
      onClose();
      return true;
    });
    return () => sub.remove();
  }, [zoomIndex, onClose]);

  const zoomPhoto = zoomIndex !== null ? photos[zoomIndex] : undefined;
  const zoomUri = zoomPhoto ? zoomPhoto.localUri || localUriMap[zoomPhoto.id] || '' : '';

  // ——— 分支渲染（此处起不得再有 hooks）———
  let title = '';
  let headerRight: React.ReactNode = <View style={styles.headerSlot} />;
  let body: React.ReactNode = null;

  const imagesBlock = (
    <ImagesBlock
      photos={photos}
      isDraft={rec.kind === 'draft'}
      loading={imgLoading}
      notice={notice}
      localUriMap={localUriMap}
      downloadingSet={downloadingSet}
      thumbErrorSet={thumbErrorSet}
      onThumbError={(id) => setThumbErrorSet((prev) => new Set(prev).add(id))}
      onPress={openAt}
    />
  );

  if (rec.kind === 'draft') {
    if (draft) {
      title = draft.supplierName || '未填供应商';
      if (onEdit) {
        // 已同步单据不可编辑，只有草稿给「编辑」入口
        headerRight = (
          <TouchableOpacity
            style={[styles.headerBtn, styles.headerSlot, styles.headerSlotRight]}
            onPress={() => onEdit(rec.id)}
            hitSlop={12}
            accessibilityRole="button"
          >
            <Text style={styles.edit} numberOfLines={1}>
              编辑
            </Text>
          </TouchableOpacity>
        );
      }
      body = (
        <>
          <Line label="单号" value={`进货草稿 ${draft.orderNo}`} />
          <Line label="日期" value={formatDayLabel(draft.date, offset)} />
          <Line label="合计" value={`¥${draft.totalAmount.toFixed(2)}`} color={theme.color.expense} />
          <Line label="已付" value={`¥${Number(draft.paidAmount || 0).toFixed(2)}`} />
          {imagesBlock}
          <ItemsBlock items={safeParseArray(draft.items)} />
          {draft.note ? <Line label="备注" value={draft.note} /> : null}
        </>
      );
    }
  } else if (rec.kind === 'purchase') {
    if (purchase) {
      title = purchase.supplierName || '未填供应商';
      if (photos.length > 0) {
        headerRight = (
          <Text style={[styles.headerSlot, styles.headerSlotRight, styles.count]} numberOfLines={1}>
            {photos.length} 张
          </Text>
        );
      }
      body = (
        <>
          <Line label="单号" value={`进货单 ${purchase.orderNo}`} />
          <Line label="日期" value={formatDayLabel(purchase.date, offset)} />
          <Line
            label="合计"
            value={`¥${purchase.totalAmount.toFixed(2)}`}
            color={theme.color.expense}
          />
          <Line label="已付" value={`¥${Number(purchase.paidAmount || 0).toFixed(2)}`} />
          {imagesBlock}
          <ItemsBlock items={purchaseRaw.items || []} />
          {purchase.note ? <Line label="备注" value={purchase.note} /> : null}
        </>
      );
    }
  } else if (revenue || revenueDraft) {
    // 已同步营收（缓存快照）和本机营收草稿走同一套渲染 —— 字段结构一致，
    // 只在标题上标出「待同步」，让用户一眼看出这笔还在本机、电脑上还看不到。
    const r = revenue
      ? { date: revenue.date, total: revenue.total, note: revenue.note, payments: revenue.payments }
      : {
          date: revenueDraft!.date,
          total: revenueDraft!.total,
          note: revenueDraft!.note,
          payments: revenueDraft!.payments,
        };
    title = `营收 ${formatDayLabel(r.date, offset)}${revenueDraft ? ' · 待同步' : ''}`;
    const pay = (() => {
      try {
        const v = JSON.parse(r.payments || '{}');
        return v && typeof v === 'object' ? (v as Record<string, any>) : {};
      } catch {
        return {} as Record<string, any>;
      }
    })();

    // 自定义渠道：先按设置里「启用」的渠道展示（哪怕金额为 0，口径和录入页一致），
    // 再补上任何有金额但已被禁用/属于历史键（polymer、combo）的渠道 —— 否则老数据会被吞掉，
    // 出现「各渠道相加 ≠ 合计」。
    const channels = getCachedCustomChannels();
    const nameOf = (k: string) =>
      channels.find((c) => c.key === k)?.name || LEGACY_CHANNEL_LABELS[k] || k;
    const shownKeys: string[] = channels.filter((c) => c.enabled !== false).map((c) => c.key);
    Object.keys(pay).forEach((k) => {
      if ((FIXED_CHANNEL_KEYS as readonly string[]).includes(k)) return;
      if (shownKeys.includes(k)) return;
      if (Number(pay[k] || 0) > 0) shownKeys.push(k);
    });

    body = (
      <>
        <Line label="日期" value={formatDayLabel(r.date, offset)} />
        <Line label="现金" value={`¥${Number(pay.cash || 0).toFixed(2)}`} />
        <Line label="微信" value={`¥${Number(pay.wechat || 0).toFixed(2)}`} />
        <Line label="支付宝" value={`¥${Number(pay.alipay || 0).toFixed(2)}`} />
        {shownKeys.map((k) => (
          <Line key={k} label={nameOf(k)} value={`¥${Number(pay[k] || 0).toFixed(2)}`} />
        ))}
        <Line label="合计" value={`¥${r.total.toFixed(2)}`} color={theme.color.income} />
        {revenueDraft ? <Line label="状态" value="本机草稿 · 联网后自动同步" /> : null}
        {r.note ? <Line label="备注" value={r.note} /> : null}
      </>
    );
  }

  return (
    <View style={styles.root}>
      {/* 顶部安全区：本页是 App.tsx 的绝对定位 overlay，iOS 下根 SafeAreaRoot 的 inset
          落不到这里，「返回列表 / 编辑」会被状态栏、刘海、灵动岛压住点不到。
          SafeAreaHeader 在 iOS 用原生 SafeAreaView（相对 inset，嵌套幂等），Android 为 no-op。 */}
      <SafeAreaHeader style={styles.header}>
        <TouchableOpacity
          style={[styles.headerBtn, styles.headerSlot]}
          onPress={onClose}
          hitSlop={12}
          accessibilityRole="button"
        >
          {/* 固定 width:48 塞不下「‹ 返回列表」五个字会截断，这里用 minWidth + 不收缩 */}
          <Text style={styles.back} numberOfLines={1}>
            ‹ 返回列表
          </Text>
        </TouchableOpacity>
        <Text style={styles.title} numberOfLines={1}>
          {title}
        </Text>
        {headerRight}
      </SafeAreaHeader>

      <ScrollView contentContainerStyle={styles.pad}>
        {body ?? <Text style={styles.empty}>记录不存在或已清理</Text>}
      </ScrollView>

      {/* 全屏回看原图：显式关闭按钮（旧版「点任意处关闭」和捏合手势冲突，一放大就退出） */}
      <Modal
        visible={zoomIndex !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setZoomIndex(null)}
      >
        <View style={styles.viewerRoot}>
          {/* Modal 是独立 native window，拿不到父级 safe area，顶部自己补 TOP_INSET */}
          <View style={styles.viewerHeader}>
            <TouchableOpacity
              style={[styles.headerBtn, styles.headerSlot]}
              onPress={() => setZoomIndex(null)}
              hitSlop={12}
              accessibilityRole="button"
            >
              <Text style={styles.back} numberOfLines={1}>
                ‹ 返回
              </Text>
            </TouchableOpacity>
            <Text style={styles.viewerTitle} numberOfLines={1}>
              {zoomIndex !== null ? `${zoomIndex + 1} / ${photos.length}` : ''}
            </Text>
            <View style={styles.headerSlot} />
          </View>

          <View style={styles.viewerBody}>
            {zoomUri ? (
              <ZoomableImage key={zoomUri} uri={zoomUri} />
            ) : (
              <ActivityIndicator size="large" color="#fff" />
            )}
            {photos.length > 1 && zoomIndex !== null ? (
              <View style={styles.viewerPager}>
                <TouchableOpacity
                  disabled={zoomIndex === 0}
                  onPress={() => openAt(Math.max(0, zoomIndex - 1))}
                  hitSlop={12}
                  accessibilityRole="button"
                >
                  <Text style={[styles.pagerBtn, zoomIndex === 0 && styles.pagerBtnDisabled]}>‹</Text>
                </TouchableOpacity>
                <Text style={styles.pagerCount}>
                  {zoomIndex + 1} / {photos.length}
                </Text>
                <TouchableOpacity
                  disabled={zoomIndex === photos.length - 1}
                  onPress={() => openAt(Math.min(photos.length - 1, zoomIndex + 1))}
                  hitSlop={12}
                  accessibilityRole="button"
                >
                  <Text
                    style={[
                      styles.pagerBtn,
                      zoomIndex === photos.length - 1 && styles.pagerBtnDisabled,
                    ]}
                  >
                    ›
                  </Text>
                </TouchableOpacity>
              </View>
            ) : null}
          </View>
        </View>
      </Modal>
    </View>
  );
}

function Line({ label, value, color }: { label: string; value: string; color?: string }) {
  const { theme } = useTheme();
  const styles = makeStyles(theme);
  return (
    <View style={styles.line}>
      <Text style={styles.lineLabel}>{label}</Text>
      <Text style={[styles.lineValue, color ? { color } : null]}>{value}</Text>
    </View>
  );
}

/**
 * 单据照片：等宽三列网格 + 三态缩略图（已下载 / 网络预览 / 纯占位）+ 点击回看。
 * 无图时整块消失 —— 不渲染「暂无照片」这种噪音行。
 */
function ImagesBlock({
  photos,
  isDraft,
  loading,
  notice,
  localUriMap,
  downloadingSet,
  thumbErrorSet,
  onThumbError,
  onPress,
}: {
  photos: Photo[];
  isDraft: boolean;
  loading: boolean;
  notice: string | null;
  localUriMap: Record<number, string>;
  downloadingSet: Set<number>;
  thumbErrorSet: Set<number>;
  onThumbError: (id: number) => void;
  onPress: (index: number) => void;
}) {
  const { theme } = useTheme();
  const styles = makeStyles(theme);
  const n = photos.length;
  if (!loading && n === 0) return null;
  return (
    <View style={styles.block}>
      <Text style={styles.blockTitle}>
        {loading && n === 0 ? '单据照片' : `单据照片（${n} 张）`}
        {isDraft ? ' · 尚未同步，显示本机照片' : ''}
      </Text>

      {notice ? (
        <View style={styles.notice}>
          <Text style={styles.noticeText}>{notice}</Text>
        </View>
      ) : null}

      {loading && n === 0 ? (
        <View style={styles.imgLoading}>
          <ActivityIndicator size="large" color={theme.color.primaryVivid} />
        </View>
      ) : (
        <View style={styles.grid}>
          {photos.map((p, i) => {
            const local = p.localUri || localUriMap[p.id];
            const downloading = downloadingSet.has(p.id);
            // 网络缩略图加载失败（图被清理/跨网段访问不到）就退回占位态，别留一块黑
            const showThumb = !local && !!p.thumbUrl && !thumbErrorSet.has(p.id);
            return (
              <View key={`${p.id}-${i}`} style={styles.cell}>
                <TouchableOpacity
                  activeOpacity={0.8}
                  onPress={() => onPress(i)}
                  accessibilityRole="imagebutton"
                  accessibilityLabel={`查看第 ${i + 1} 张单据照片`}
                >
                  {local ? (
                    // A 态：本机已有原图，直接铺满
                    <Image source={{ uri: local }} style={styles.thumb} resizeMode="cover" />
                  ) : showThumb ? (
                    // B 态：有网络预览图，压半透明遮罩提示点开看原图
                    <View style={styles.thumb}>
                      <Image
                        source={{ uri: p.thumbUrl }}
                        style={styles.thumb}
                        resizeMode="cover"
                        onError={() => onThumbError(p.id)}
                      />
                      <View style={styles.thumbOverlay}>
                        {downloading ? (
                          <ActivityIndicator size="small" color="#fff" />
                        ) : (
                          <Text style={styles.thumbOverlayText}>点击查看原图</Text>
                        )}
                      </View>
                    </View>
                  ) : (
                    // C 态：什么都没有，纯占位 + 「点击下载」
                    <View style={[styles.thumb, styles.thumbPlaceholder]}>
                      <Text style={styles.thumbText}>原图</Text>
                      {downloading ? (
                        <ActivityIndicator
                          size="small"
                          color={theme.color.primaryVivid}
                          style={styles.thumbSpinner}
                        />
                      ) : (
                        <Text style={styles.thumbHint}>点击下载</Text>
                      )}
                    </View>
                  )}
                </TouchableOpacity>
                {/* 草稿是本机照片，没有服务端体积/来源信息，不渲染这一行 */}
                {!isDraft ? (
                  <Text
                    style={[styles.thumbMeta, p.terminal === 'pc' ? styles.thumbMetaPc : null]}
                    numberOfLines={1}
                  >
                    {p.terminal === 'pc' ? '💻' : '📱'}
                    {p.fileSize ? ` ${(p.fileSize / 1024 / 1024).toFixed(2)}MB` : ''}
                  </Text>
                ) : null}
              </View>
            );
          })}
        </View>
      )}
    </View>
  );
}

function ItemsBlock({ items }: { items: any[] }) {
  const { theme } = useTheme();
  const styles = makeStyles(theme);
  if (!items || items.length === 0) return null;
  return (
    <View style={styles.block}>
      <Text style={styles.blockTitle}>商品明细（{items.length} 项）</Text>
      {items.map((it, i) => (
        <View key={i} style={styles.itemRow}>
          <Text style={styles.itemName}>{it.name}</Text>
          <Text style={styles.itemMeta}>
            {it.quantity} {it.unit || ''} × ¥{it.price} = ¥
            {(Number(it.quantity) * Number(it.price)).toFixed(2)}
          </Text>
        </View>
      ))}
    </View>
  );
}

function makeStyles(theme: any) {
  const S = theme.size;
  const GRID_GAP = theme.spaceScale[2];
  const CELL_W = Math.max(72, Math.floor((SCREEN_W - theme.spaceScale[4] * 4 - GRID_GAP * 2) / 3));
  return StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.color.bgApp },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: theme.spaceScale[4],
    paddingVertical: theme.spaceScale[2],
    minHeight: S.tapMin + theme.spaceScale[2],
    borderBottomWidth: 1,
    borderBottomColor: theme.color.dividerApp,
  },
  headerBtn: { minHeight: S.tapMin, justifyContent: 'center' },
  // 左右两栏等宽，中间标题才是真居中；且「‹ 返回列表」五个字不会被 width:48 截断
  headerSlot: { minWidth: 88, flexShrink: 0 },
  headerSlotRight: { alignItems: 'flex-end' },
  back: { color: theme.color.primaryVivid, fontSize: theme.font.size.md },
  title: {
    fontSize: theme.font.sizeV4.h3,
    fontWeight: theme.font.weight.bold,
    color: theme.color.textApp,
    flex: 1,
    textAlign: 'center',
    marginHorizontal: theme.spaceScale[2],
  },
  edit: { color: theme.color.primaryVivid, fontSize: theme.font.size.md, textAlign: 'right' },
  count: {
    color: theme.color.textAppSecondary,
    fontSize: theme.font.size.md,
    textAlign: 'right',
    fontFamily: theme.font.family.num,
  },
  pad: { padding: theme.spaceScale[4] },
  empty: { color: theme.color.textAppTertiary, textAlign: 'center', marginTop: theme.spaceScale[6] },
  line: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: S.listRowMinH,
    borderBottomWidth: 1,
    borderBottomColor: theme.color.dividerApp,
  },
  lineLabel: { fontSize: theme.font.sizeV4.body, color: theme.color.textAppSecondary },
  lineValue: {
    fontSize: theme.font.sizeV4.body,
    color: theme.color.textApp,
    fontFamily: theme.font.family.num,
    flexShrink: 1,
    textAlign: 'right',
    marginLeft: theme.spaceScale[4],
  },

  // 区块（照片 / 商品明细）：R3 零阴影
  block: {
    marginTop: theme.spaceScale[4],
    backgroundColor: theme.color.surfaceApp,
    borderRadius: theme.radius.lg,
    padding: theme.spaceScale[4],
  },
  blockTitle: {
    fontSize: theme.font.sizeV4.caption,
    color: theme.color.textAppTertiary,
    marginBottom: theme.spaceScale[2],
  },
  notice: {
    backgroundColor: theme.color.surfaceRaised,
    borderRadius: theme.radius.md,
    paddingHorizontal: theme.spaceScale[3],
    paddingVertical: theme.spaceScale[2],
    marginBottom: theme.spaceScale[2],
  },
  noticeText: { fontSize: theme.font.sizeV4.caption, color: theme.color.textApp },
  imgLoading: { height: 120, alignItems: 'center', justifyContent: 'center' },

  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: GRID_GAP },
  cell: { width: CELL_W },
  thumb: {
    width: '100%',
    aspectRatio: 1,
    borderRadius: theme.radius.md,
    backgroundColor: theme.color.surfaceSunken,
    overflow: 'hidden',
  },
  thumbPlaceholder: {
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: theme.color.borderApp,
  },
  thumbText: { fontSize: theme.font.sizeV4.micro, color: theme.color.textAppTertiary },
  thumbHint: { fontSize: theme.font.sizeV4.micro, color: theme.color.primaryVivid, marginTop: 2 },
  thumbSpinner: { marginTop: 4 },
  thumbOverlay: {
    position: "absolute", top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.35)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  thumbOverlayText: { fontSize: theme.font.sizeV4.micro, color: '#fff' },
  thumbMeta: {
    fontSize: theme.font.sizeV4.caption,
    color: theme.color.textAppTertiary,
    fontFamily: theme.font.family.num,
    textAlign: 'center',
    marginTop: theme.spaceScale[1],
  },
  thumbMetaPc: { color: theme.color.info },

  itemRow: {
    paddingVertical: theme.spaceScale[2],
    borderBottomWidth: 1,
    borderBottomColor: theme.color.dividerApp,
  },
  itemName: { fontSize: theme.font.sizeV4.bodyLg, color: theme.color.textApp },
  itemMeta: {
    fontSize: theme.font.sizeV4.caption,
    color: theme.color.textAppTertiary,
    marginTop: 2,
    fontFamily: theme.font.family.num,
  },

  // 全屏查看器
  viewerRoot: { flex: 1, backgroundColor: 'rgba(0,0,0,0.92)' },
  viewerHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: theme.spaceScale[4],
    paddingBottom: theme.spaceScale[2],
    // Modal 走独立 native window，父级 safe area 作用不到，顶部自己补
    paddingTop: TOP_INSET + theme.spaceScale[2],
    minHeight: S.tapMin + theme.spaceScale[2],
    borderBottomWidth: 1,
    borderBottomColor: theme.color.dividerApp,
    zIndex: 20,
    elevation: 20,
  },
  viewerTitle: {
    flex: 1,
    textAlign: 'center',
    color: theme.color.textApp,
    fontSize: theme.font.size.md,
    fontFamily: theme.font.family.num,
  },
  viewerBody: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  // 手势区：flex:1 精确覆盖查看区域（在标题栏下方），不向外溢出到标题栏
  viewerGestureArea: { flex: 1, width: '100%', alignItems: 'center', justifyContent: 'center' },
  viewerPager: {
    position: 'absolute',
    bottom: theme.spaceScale[3] + BOTTOM_INSET,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  pagerBtn: { fontSize: 36, color: '#fff', paddingHorizontal: theme.spaceScale[6] },
  pagerBtnDisabled: { opacity: 0.3 },
  pagerCount: {
    fontSize: theme.font.size.md,
    color: '#fff',
    fontFamily: theme.font.family.num,
  },
});
}
