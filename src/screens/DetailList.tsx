import { useEffect, useState, useCallback, useRef } from 'react';
import {
  StyleSheet,
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  TextInput,
  Modal,
  Image,
  SafeAreaView,
  Animated,
  PanResponder,
  ActivityIndicator,
  Alert,
  Dimensions,
} from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import { theme } from '../theme';
import { fetchDisplayRule, fetchPurchases, fetchImagesByOrder, fetchPcImageSummary, PurchaseRecord, ImageMeta } from '../api/images';
import { formatDayLabel, toLocalDateStr } from '../utils/dateLabel';

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window');

interface DetailListProps {
  baseUrl: string;
  onBack: () => void;
}

function formatMoney(n?: number) {
  if (n === undefined || n === null) return '—';
  return `¥${Number(n).toFixed(2)}`;
}

function getImageUrl(baseUrl: string, meta: ImageMeta): string {
  // 缩略图优先用 hd_url（压缩预览图），没有才 fallback 原图
  const path = meta.hd_url || meta.original_url || '';
  if (!path) return '';
  if (path.startsWith('http')) return path;
  return `${baseUrl}${path.startsWith('/') ? '' : '/'}${path}`;
}

function getOriginalUrl(baseUrl: string, meta: ImageMeta): string {
  const path = meta.original_url || meta.hd_url || '';
  if (!path) return '';
  if (path.startsWith('http')) return path;
  return `${baseUrl}${path.startsWith('/') ? '' : '/'}${path}`;
}

function hashCode(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h << 5) - h + s.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h) || 1;
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
 * 纯 RN 核心实现的图片缩放查看器（无损清晰版）：
 * - 关键：按原图真实分辨率渲染（Image.getSize 取出 w/h），初始缩放 fit 到屏幕，
 *   再叠加 pinch/双击缩放。这样放大时是在放大原始高清图，不会糊。
 * - 双指捏合缩放（fit ~ fit*6）
 * - 单指拖动（缩放后可平移，按原图尺寸夹取边界）
 * - 双击在 fit / fit*2.5 之间切换
 * 不依赖 gesture-handler / reanimated，避免原生链接风险。
 */
function ZoomableImage({ uri }: { uri: string }) {
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
  }, [uri]);

  // 关键修复：PanResponder 挂在「查看区包裹层」上，而不是那张 4000x3000 的原图上。
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
            const target = st.current.scale > st.current.fit * 1.1 ? st.current.fit : st.current.fit * 2.5;
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
            const ns = clamp(st.current.pinchBase * (d / st.current.pinchDist), st.current.fit, st.current.fit * ZOOM_MAX);
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

export default function DetailList({ baseUrl, onBack }: DetailListProps) {
  const [rule, setRule] = useState({ offsetDays: 1, enabled: true });
  const [records, setRecords] = useState<PurchaseRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [keyword, setKeyword] = useState('');
  const [range, setRange] = useState<'7' | '30' | 'all'>('7');
  const [selected, setSelected] = useState<PurchaseRecord | null>(null);
  const [images, setImages] = useState<ImageMeta[]>([]);
  const [imgLoading, setImgLoading] = useState(false);
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
  const [localUriMap, setLocalUriMap] = useState<Record<number, string>>({});
  const [downloadingSet, setDownloadingSet] = useState<Set<number>>(new Set());
  const [thumbErrorSet, setThumbErrorSet] = useState<Set<number>>(new Set());
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pcImageMap, setPcImageMap] = useState<Record<string, number>>({});

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [r, list, pcMap] = await Promise.all([
        fetchDisplayRule(baseUrl),
        fetchPurchases(baseUrl, { keyword: keyword.trim() || undefined }),
        fetchPcImageSummary(baseUrl),
      ]);
      setRule(r);
      setPcImageMap(pcMap || {});

      const today = new Date();
      let startDate: string | undefined;
      if (range === '7') {
        const d = new Date(today);
        d.setDate(d.getDate() - 7);
        startDate = toLocalDateStr(d);
      } else if (range === '30') {
        const d = new Date(today);
        d.setDate(d.getDate() - 30);
        startDate = toLocalDateStr(d);
      }

      let filtered = list;
      if (startDate) {
        filtered = list.filter((p) => p.date >= startDate);
      }
      setRecords(filtered);
    } catch (e: any) {
      Alert.alert('加载失败', e?.message || '无法获取明细');
    } finally {
      setLoading(false);
    }
  }, [baseUrl, keyword, range]);

  useEffect(() => {
    load();
  }, [load]);

  const openOrder = async (record: PurchaseRecord) => {
    setSelected(record);
    setViewerIndex(null);
    setImages([]);
    setLocalUriMap({});
    setImgLoading(true);
    try {
      const list = await fetchImagesByOrder(baseUrl, record.orderNo);
      // 兼容历史数据：接口未命中但 purchase.images 仍有 URL 时，用 URL 兜底展示
      if (list.length === 0 && (record.images || []).length > 0) {
        const baseId = hashCode(record.orderNo) * 100;
        const fallback: ImageMeta[] = (record.images || []).map((url, idx) => ({
          id: -(baseId + idx + 1),
          original_url: url,
          upload_terminal: 'mobile',
          created_at: record.date,
        }));
        setImages(fallback);
      } else {
        setImages(list);
      }
    } catch (e: any) {
      Alert.alert('加载图片失败', e?.message || '无法获取图片列表');
    } finally {
      setImgLoading(false);
    }
  };

  // 反向同步（电脑端→手机端）：打开某单据看图时，轻量轮询 /api/images 检查电脑端是否新增了原图。
  // 只拉元数据、绝不预下载二进制；发现新图才追加到网格，用户点击缩略图才下载回看。
  const refreshImagesForSelected = useCallback(async () => {
    if (!selected) return;
    try {
      const list = await fetchImagesByOrder(baseUrl, selected.orderNo);
      setImages((old) => {
        const oldIds = new Set(old.map((p) => p.id));
        const added = list.filter((p) => !oldIds.has(p.id));
        if (added.length === 0) return old;
        const pcAdded = added.filter((p) => p.upload_terminal === 'pc').length;
        if (pcAdded > 0) {
          // 移出 updater 再触发通知，避免在 state 更新函数内直接 setState 的告警
          queueMicrotask(() => {
            setNotice(`💻 电脑端新增 ${pcAdded} 张原图，点击缩略图下载回看`);
            setTimeout(() => setNotice(null), 3500);
          });
        }
        return [...old, ...added].sort((a, b) => a.id - b.id);
      });
    } catch {
      /* 轮询失败静默忽略，不阻断看图 */
    }
  }, [selected, baseUrl]);

  // 打开明细期间每 10s 轮询一次；关掉 Modal 即停止，避免空耗流量/存储
  useEffect(() => {
    if (!selected) {
      if (pollTimer.current) {
        clearInterval(pollTimer.current);
        pollTimer.current = null;
      }
      return;
    }
    refreshImagesForSelected();
    pollTimer.current = setInterval(refreshImagesForSelected, 10000);
    return () => {
      if (pollTimer.current) {
        clearInterval(pollTimer.current);
        pollTimer.current = null;
      }
    };
  }, [selected, refreshImagesForSelected]);

  const downloadImage = async (meta: ImageMeta, index: number) => {
    if (!selected) return;
    if (localUriMap[meta.id] || downloadingSet.has(meta.id)) return;
    setDownloadingSet((prev) => new Set(prev).add(meta.id));
    try {
      const url = getOriginalUrl(baseUrl, meta);
      const ext = url.split('.').pop()?.split('?')[0] || 'jpg';
      const safeOrderNo = (selected.orderNo || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_');
      const localUri = `${(FileSystem as any).cacheDirectory}ledger_img_${safeOrderNo}_${meta.id}.${ext}`;
      const info = await FileSystem.getInfoAsync(localUri);
      if (!info.exists) {
        const download = await FileSystem.downloadAsync(url, localUri, {
          headers: { 'x-api-token': '' }, // /uploads 静态目录通常不鉴权；如需鉴权请替换为真实 token
        });
        if (download.status !== 200) {
          throw new Error(`下载失败 HTTP ${download.status}`);
        }
      }
      setLocalUriMap((prev) => ({ ...prev, [meta.id]: localUri }));
      setViewerIndex(index);
    } catch (e: any) {
      Alert.alert('下载失败', e?.message || '无法下载原图');
    } finally {
      setDownloadingSet((prev) => {
        const next = new Set(prev);
        next.delete(meta.id);
        return next;
      });
    }
  };

  const renderRecord = (record: PurchaseRecord) => {
    const imgCount = (record.images || []).length;
    const pcCount = pcImageMap[record.orderNo] || 0;
    return (
      <TouchableOpacity key={record.id} style={styles.card} onPress={() => openOrder(record)} activeOpacity={0.8}>
        <View style={styles.cardHeader}>
          <Text style={styles.dateLabel}>
            {formatDayLabel(record.date, rule.offsetDays, { withRealDate: true })}
          </Text>
          <Text style={styles.orderNo}>{record.orderNo}</Text>
        </View>
        <View style={styles.cardBody}>
          <View style={{ flex: 1 }}>
            <Text style={styles.supplier}>{record.supplierName || '未填写供应商'}</Text>
            <Text style={styles.items}>
              {(record.items || []).slice(0, 3).map((i) => i.name).join('、') || '无商品明细'}
            </Text>
          </View>
          <View style={styles.amountCol}>
            <Text style={styles.amount}>{formatMoney(record.totalAmount)}</Text>
            {imgCount > 0 && (
              <View style={styles.badge}>
                <Text style={styles.badgeText}>{imgCount} 张图</Text>
              </View>
            )}
            {pcCount > 0 && (
              <View style={[styles.badge, styles.pcBadge]}>
                <Text style={[styles.badgeText, styles.pcBadgeText]}>💻 {pcCount}</Text>
              </View>
            )}
          </View>
        </View>
      </TouchableOpacity>
    );
  };

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <TouchableOpacity onPress={onBack}>
          <Text style={styles.back}>‹ 返回</Text>
        </TouchableOpacity>
        <Text style={styles.title}>明细回看</Text>
        <TouchableOpacity onPress={load} disabled={loading}>
          <Text style={[styles.refresh, loading && styles.disabledText]}>刷新</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.searchBar}>
        <TextInput
          style={styles.searchInput}
          placeholder="搜索供应商 / 单号 / 商品"
          placeholderTextColor={theme.color.textMuted}
          value={keyword}
          onChangeText={setKeyword}
          onSubmitEditing={load}
          returnKeyType="search"
        />
      </View>

      <View style={styles.rangeRow}>
        {(['7', '30', 'all'] as const).map((key) => (
          <TouchableOpacity
            key={key}
            style={[styles.rangeBtn, range === key && styles.rangeBtnActive]}
            onPress={() => setRange(key)}
          >
            <Text style={[styles.rangeText, range === key && styles.rangeTextActive]}>
              {key === '7' ? '近 7 天' : key === '30' ? '近 30 天' : '全部'}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={theme.color.primary} />
        </View>
      ) : (
        <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
          {records.length === 0 ? (
            <View style={styles.empty}>
              <Text style={styles.emptyText}>暂无明细</Text>
              <Text style={styles.emptySub}>同步后的单据会在这里显示</Text>
            </View>
          ) : (
            records.map(renderRecord)
          )}
        </ScrollView>
      )}

      {/* 单据图片网格 + 单张原图查看：合并为同一个 Modal，避免 iOS 双 Modal 堆叠导致点击无响应 */}
      <Modal
        visible={!!selected}
        animationType="slide"
        transparent={false}
        onRequestClose={() => {
          if (viewerIndex !== null) {
            setViewerIndex(null);
          } else {
            setSelected(null);
            setImages([]);
            setLocalUriMap({});
            setViewerIndex(null);
          }
        }}
      >
        <SafeAreaView style={[styles.modalRoot, viewerIndex !== null && styles.modalRootDark]}>
          <View style={styles.modalHeader}>
            <TouchableOpacity
              onPress={() => {
                if (viewerIndex !== null) {
                  setViewerIndex(null);
                } else {
                  setSelected(null);
                  setImages([]);
                  setLocalUriMap({});
                  setViewerIndex(null);
                }
              }}
            >
              <Text style={styles.back}>{viewerIndex !== null ? '‹ 返回' : '‹ 返回列表'}</Text>
            </TouchableOpacity>
            <Text style={[styles.modalTitle, viewerIndex !== null && styles.modalTitleLight]} numberOfLines={1}>
              {viewerIndex !== null ? `${viewerIndex + 1} / ${images.length}` : selected?.supplierName}
            </Text>
            <Text style={[styles.modalCount, viewerIndex !== null && styles.modalCountLight]}>
              {viewerIndex !== null ? '' : `${images.length} 张`}
            </Text>
          </View>

          {viewerIndex !== null ? (
            <View style={styles.viewerContainer}>
              {images[viewerIndex] && localUriMap[images[viewerIndex].id] ? (
                <ZoomableImage
                  key={localUriMap[images[viewerIndex].id]}
                  uri={localUriMap[images[viewerIndex].id]}
                />
              ) : (
                <ActivityIndicator size="large" color="#fff" />
              )}
              {images.length > 1 && (
                <View style={styles.viewerPager}>
                  <TouchableOpacity
                    disabled={viewerIndex === 0}
                    onPress={() => setViewerIndex((i) => (i === null ? null : Math.max(0, i - 1)))}
                  >
                    <Text style={[styles.pagerBtn, viewerIndex === 0 && styles.pagerBtnDisabled]}>‹</Text>
                  </TouchableOpacity>
                  <Text style={styles.pagerCount}>{viewerIndex !== null ? viewerIndex + 1 : 0} / {images.length}</Text>
                  <TouchableOpacity
                    disabled={viewerIndex === images.length - 1}
                    onPress={() => setViewerIndex((i) => (i === null ? null : Math.min(images.length - 1, i + 1)))}
                  >
                    <Text style={[styles.pagerBtn, viewerIndex === images.length - 1 && styles.pagerBtnDisabled]}>›</Text>
                  </TouchableOpacity>
                </View>
              )}
            </View>
          ) : imgLoading ? (
            <View style={styles.center}>
              <ActivityIndicator size="large" color={theme.color.primary} />
            </View>
          ) : images.length === 0 ? (
            <View style={styles.center}>
              <Text style={styles.emptyText}>该单据没有图片</Text>
            </View>
          ) : (
            <ScrollView contentContainerStyle={styles.grid}>
              {notice && (
                <View style={styles.noticeBar}>
                  <Text style={styles.noticeText}>{notice}</Text>
                </View>
              )}
              {images.map((img, idx) => {
                const local = localUriMap[img.id];
                const downloading = downloadingSet.has(img.id);
                const fromPc = img.upload_terminal === 'pc';
                // 电脑端上传的图片：直接用网络缩略图展示，点击后才下载原图；加载失败则回退占位符
                const thumbUrl = !local && fromPc && !thumbErrorSet.has(img.id) ? getImageUrl(baseUrl, img) : '';
                const showNetworkThumb = !!thumbUrl && !thumbErrorSet.has(img.id);
                return (
                  <TouchableOpacity
                    key={img.id}
                    style={styles.thumbWrap}
                    onPress={() => (local ? setViewerIndex(idx) : downloadImage(img, idx))}
                    activeOpacity={0.8}
                  >
                    {local ? (
                      <Image source={{ uri: local }} style={styles.thumb} resizeMode="cover" />
                    ) : showNetworkThumb ? (
                      <View style={styles.thumb}>
                        <Image
                          source={{ uri: thumbUrl }}
                          style={styles.thumb}
                          resizeMode="cover"
                          onError={() => setThumbErrorSet((prev) => new Set(prev).add(img.id))}
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
                      <View style={[styles.thumb, styles.thumbPlaceholder]}>
                        <Text style={styles.thumbText}>原图</Text>
                        {downloading ? (
                          <ActivityIndicator size="small" color={theme.color.primary} style={{ marginTop: 4 }} />
                        ) : (
                          <Text style={styles.thumbHint}>点击下载</Text>
                        )}
                      </View>
                    )}
                    <Text style={[styles.thumbSize, fromPc && styles.thumbSrcPc]}>
                      {fromPc ? '💻 ' : '📱 '}{img.file_size ? `${(img.file_size / 1024 / 1024).toFixed(2)}MB` : ''}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          )}
        </SafeAreaView>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.color.bg },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: theme.space(2), paddingTop: theme.space(3), paddingBottom: theme.space(1.5),
    backgroundColor: theme.color.surface,
    borderBottomWidth: 1, borderBottomColor: theme.color.border,
  },
  back: { fontSize: theme.font.size.md, color: theme.color.primary, fontWeight: theme.font.weight.medium },
  title: { fontSize: theme.font.size.xl, fontWeight: theme.font.weight.bold, color: theme.color.text },
  refresh: { fontSize: theme.font.size.md, color: theme.color.primary, fontWeight: theme.font.weight.medium },
  disabledText: { opacity: 0.4 },
  searchBar: { padding: theme.space(2), backgroundColor: theme.color.surface },
  searchInput: {
    backgroundColor: theme.color.bg, borderRadius: theme.radius.md,
    paddingHorizontal: theme.space(1.5), paddingVertical: theme.space(1),
    fontSize: theme.font.size.md, color: theme.color.text,
    borderWidth: 1, borderColor: theme.color.border,
  },
  rangeRow: {
    flexDirection: 'row', paddingHorizontal: theme.space(2), paddingBottom: theme.space(1.5),
    backgroundColor: theme.color.surface, borderBottomWidth: 1, borderBottomColor: theme.color.border,
  },
  rangeBtn: {
    paddingHorizontal: theme.space(1.5), paddingVertical: theme.space(0.75),
    borderRadius: theme.radius.sm, marginRight: theme.space(1),
    backgroundColor: theme.color.bg, borderWidth: 1, borderColor: theme.color.border,
  },
  rangeBtnActive: { backgroundColor: theme.color.primarySoft, borderColor: theme.color.primary },
  rangeText: { fontSize: theme.font.size.sm, color: theme.color.textMuted },
  rangeTextActive: { color: theme.color.primary, fontWeight: theme.font.weight.medium },
  list: { flex: 1 },
  listContent: { padding: theme.space(2) },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  empty: { alignItems: 'center', marginTop: theme.space(8) },
  emptyText: { fontSize: theme.font.size.lg, color: theme.color.textMuted, fontWeight: theme.font.weight.medium },
  emptySub: { fontSize: theme.font.size.sm, color: theme.color.textMuted, marginTop: theme.space(0.5) },
  card: {
    backgroundColor: theme.color.surface, borderRadius: theme.radius.lg,
    padding: theme.space(2), marginBottom: theme.space(1.5),
    ...theme.shadow.card,
  },
  cardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: theme.space(1) },
  dateLabel: { fontSize: theme.font.size.md, fontWeight: theme.font.weight.bold, color: theme.color.text },
  orderNo: { fontSize: theme.font.size.xs, color: theme.color.textMuted },
  cardBody: { flexDirection: 'row', alignItems: 'center' },
  supplier: { fontSize: theme.font.size.md, color: theme.color.text, fontWeight: theme.font.weight.medium },
  items: { fontSize: theme.font.size.sm, color: theme.color.textMuted, marginTop: theme.space(0.25) },
  amountCol: { alignItems: 'flex-end', marginLeft: theme.space(1.5) },
  amount: { fontSize: theme.font.size.lg, fontWeight: theme.font.weight.bold, color: theme.color.primary },
  badge: {
    backgroundColor: theme.color.primarySoft, borderRadius: theme.radius.sm,
    paddingHorizontal: theme.space(0.75), paddingVertical: theme.space(0.25), marginTop: theme.space(0.5),
  },
  badgeText: { fontSize: theme.font.size.xs, color: theme.color.primary, fontWeight: theme.font.weight.medium },
  pcBadge: { backgroundColor: '#e8f0fe' },
  pcBadgeText: { color: '#1a56db' },
  modalRoot: { flex: 1, backgroundColor: theme.color.bg },
  modalRootDark: { backgroundColor: 'rgba(0,0,0,0.92)' },
  modalTitleLight: { color: '#fff' },
  modalCountLight: { color: '#fff' },
  viewerContainer: { flex: 1, alignItems: 'center', justifyContent: 'center', zIndex: 1 },
  // 手势区：flex:1 精确覆盖查看区域（在标题栏下方），不向外溢出到标题栏
  viewerGestureArea: { flex: 1, width: '100%', alignItems: 'center', justifyContent: 'center' },
  modalHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: theme.space(2), paddingTop: theme.space(2), paddingBottom: theme.space(1.5),
    backgroundColor: theme.color.surface, borderBottomWidth: 1, borderBottomColor: theme.color.border,
    zIndex: 20, elevation: 20,
  },
  modalTitle: { flex: 1, marginHorizontal: theme.space(1.5), fontSize: theme.font.size.md, fontWeight: theme.font.weight.bold, color: theme.color.text, textAlign: 'center' },
  modalCount: { fontSize: theme.font.size.sm, color: theme.color.textMuted, minWidth: 40, textAlign: 'right' },
  grid: {
    flexDirection: 'row', flexWrap: 'wrap',
    padding: theme.space(2), justifyContent: 'space-between',
  },
  thumbWrap: { width: (SCREEN_W - theme.space(6)) / 3, marginBottom: theme.space(1.5) },
  thumb: { width: '100%', aspectRatio: 1, borderRadius: theme.radius.md, backgroundColor: theme.color.surface },
  thumbPlaceholder: { alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: theme.color.border },
  thumbText: { fontSize: theme.font.size.sm, color: theme.color.textMuted },
  thumbHint: { fontSize: theme.font.size.xs, color: theme.color.primary, marginTop: 2 },
  thumbOverlay: {
    position: "absolute", top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.35)',
    alignItems: 'center', justifyContent: 'center',
    borderRadius: theme.radius.md,
  },
  thumbOverlayText: { fontSize: theme.font.size.xs, color: '#fff', fontWeight: theme.font.weight.medium },
  thumbSize: { fontSize: theme.font.size.xs, color: theme.color.textMuted, textAlign: 'center', marginTop: 2 },
  thumbSrcPc: { color: theme.color.primary, fontWeight: theme.font.weight.medium },
  noticeBar: {
    width: '100%', backgroundColor: theme.color.primarySoft,
    borderRadius: theme.radius.md, paddingHorizontal: theme.space(1.5), paddingVertical: theme.space(1),
    marginBottom: theme.space(1.5),
  },
  noticeText: { fontSize: theme.font.size.sm, color: theme.color.primary, fontWeight: theme.font.weight.medium },
  viewerPager: {
    position: 'absolute', bottom: theme.space(3), left: 0, right: 0,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
  },
  pagerBtn: { fontSize: 36, color: '#fff', paddingHorizontal: theme.space(3) },
  pagerBtnDisabled: { opacity: 0.3 },
  pagerCount: { fontSize: theme.font.size.md, color: '#fff', fontWeight: theme.font.weight.medium },
});
