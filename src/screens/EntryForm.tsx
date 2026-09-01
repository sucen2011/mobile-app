import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import {
  StyleSheet, View, Text, TextInput, TouchableOpacity, ScrollView, Modal, Alert,
  KeyboardAvoidingView, Platform, Switch,
} from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { BOTTOM_INSET, SafeAreaHeader } from '../components/SafeArea';
import ScanFrame from '../components/ScanFrame';
import { useTheme } from '../theme/ThemeProvider';
import { insertDraft, updateDraft, getDraftById, getCachedPurchases } from '../db/localDb';
import { DEVICE_ID } from '../config';
import { fetchSuppliers } from '../api/suppliers';
import { apiFetch } from '../api/client';
import { toLocalDateStr } from '../utils/dateLabel';
import { parsePurchaseBill } from '@sucen/ocr-core';
import DatePickerField from '../components/DatePickerField';
// ⚠️ 必须用 /legacy 子入口：SDK 54 主入口的 readAsStringAsync 是调用即抛的弃用桩
import * as FileSystem from 'expo-file-system/legacy';

interface ItemRow {
  barcode?: string;
  name: string;
  quantity: string;
  unit: string;
  price: string;
  imageUri?: string; // 标识该明细来自哪张照片；空/undefined 表示手动添加
}

function uuid() {
  return 'c_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// 录入方式三选一：录单据(记总额) / 商品明细(逐行) / 其他(只记金额+备注)
const ENTRY_MODE_OPTIONS = [
  { v: 'bill', label: '录单据' },
  { v: 'detail', label: '商品明细' },
  { v: 'other', label: '其他' },
] as const;

export default function EntryForm({ editId, baseUrl, onSaved, onCancel }: { editId?: string; baseUrl: string; onSaved: () => void; onCancel: () => void }) {
  const { theme } = useTheme();
  const styles = makeStyles(theme);
  const today = toLocalDateStr(new Date());
  const draftId = useRef(uuid()).current; // 一次生成，保证 orderNo 默认值与保存 id 一致

  const [supplierName, setSupplierName] = useState('');
  const [orderNo, setOrderNo] = useState(() => 'DD-' + today.replace(/-/g, '') + '-' + draftId.slice(-4).toUpperCase());
  // 「下单日期」已删除：它和「进货日期」默认都是今天、语义重复，用户要填两遍。
  // 现在 purchaseDate 就是这张单唯一的业务日期，保存时同时写进草稿的 date 字段
  // （date 是全 App 通用的记录日期：明细/概览/报表排序、orderNo、上传归档都用它，不能去掉列）。
  const [purchaseDate, setPurchaseDate] = useState(today);
  const [entryMode, setEntryMode] = useState<'bill' | 'detail' | 'other'>('bill');
  // 「保存为入库单」开关：仅商品明细方式可开启。默认关闭（与 PC 端一致），开启后
  // 该进货单成功同步到后端时会派生一条入库单（状态=已入库）。
  const [saveToStockIn, setSaveToStockIn] = useState(false);
  const [items, setItems] = useState<ItemRow[]>([{ name: '', quantity: '', unit: '', price: '', barcode: '', imageUri: '' }]);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [totalAmountInput, setTotalAmountInput] = useState('');
  const [arrivalDate, setArrivalDate] = useState('');
  const [paidAmount, setPaidAmount] = useState('');
  const [discount, setDiscount] = useState('');
  const [note, setNote] = useState('');
  const [images, setImages] = useState<string[]>([]);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [recognizing, setRecognizing] = useState(false);
  const [permission, requestPermission] = useCameraPermissions();
  const [pictureSize, setPictureSize] = useState<string | undefined>();
  const camRef = useRef<CameraView>(null);
  // 重拍替换：记录当前正在重拍的是哪张照片 URI；非空时 onCapture 走「替换而非追加」逻辑
  const [retakeUri, setRetakeUri] = useState<string | null>(null);

  // 供应商名称自动补全：列表在挂载/聚焦时拉取一次（API + 本地缓存名做回退），按键时本地过滤
  const [supplierList, setSupplierList] = useState<string[]>([]);
  const [showSuggest, setShowSuggest] = useState(false);
  const reqSeq = useRef(0); // 竞态保护：仅采用最近一次响应

  // 编辑态回填。
  //
  // 整段必须防抛：这是挂载期同步执行的 effect，里面两处 JSON.parse 读的是本机存量数据。
  // 只要某条历史草稿的 items / images 列是坏 JSON，就会在 effect 里同步抛出 ——
  // 全 App 没有 ErrorBoundary，React 会直接卸载整棵树，用户看到的就是**白屏**，
  // 而且这条坏草稿会让录单页每次点开都白屏，等于把录入端锁死。
  // 现在：解析失败退化成空列表，页面照常打开，用户可以重填或删掉这条草稿。
  useEffect(() => {
    if (!editId) return;
    try {
      const d = getDraftById(editId);
      if (!d) return;
      const safeArray = (s: string | null | undefined): any[] => {
        try {
          const v = JSON.parse(s || '[]');
          return Array.isArray(v) ? v : [];
        } catch {
          return [];
        }
      };
      setSupplierName(d.supplierName);
      setOrderNo(d.orderNo || ('DD-' + (d.date || today).replace(/-/g, '') + '-' + draftId.slice(-4).toUpperCase()));
      // 回填：老草稿可能只有 date（那时下单日期是独立字段），没有 purchaseDate。
      // 依次回退，保证编辑态永远有一个有效的进货日期，不会出现空白日期框。
      setPurchaseDate(d.purchaseDate || d.date || today);
      const parsed = safeArray(d.items);
      setItems(parsed.length ? parsed.map((it: any) => ({ barcode: it.barcode || '', name: it.name, quantity: String(it.quantity), unit: it.unit, price: String(it.price), imageUri: '' })) : [{ name: '', quantity: '', unit: '', price: '', barcode: '', imageUri: '' }]);
      setEntryMode(parsed.length ? 'detail' : 'bill');
      setTotalAmountInput(parsed.length ? '' : String(d.totalAmount || ''));
      setArrivalDate(d.arrivalDate);
      setPaidAmount(String(d.paidAmount || ''));
      setDiscount(String(d.discount || ''));
      setNote(d.note);
      setImages(safeArray(d.images).filter((u): u is string => typeof u === 'string'));
    } catch (e: any) {
      console.warn('[EntryForm] load draft failed, opening blank form:', e?.message || e);
    }
  }, [editId]);

  // 供应商候选：优先取后端 /api/suppliers，并合并本地缓存进货单里的供应商名（离线回退）。
  //
  // 离线契约：这是**纯锦上添花**的补全列表，永远不阻塞录入 ——
  // 后端不可达时 fetchSuppliers 自己就返回 []，这里退回本地缓存名；
  // 一个候选都没有也无所谓，供应商本来就是自由文本输入。
  // 整段包 try 的原因：getCachedPurchases() 是同步 SQLite 读，原来它在 try 之外，
  // 一旦读库失败就会让这个 async 函数 reject，而两个调用点都是浮空 promise（无 catch）。
  const loadSuppliers = useCallback(async () => {
    const seq = ++reqSeq.current;
    let cached: string[] = [];
    try {
      cached = Array.from(
        new Set((getCachedPurchases() || []).map((p) => (p.supplierName || '').trim()).filter(Boolean))
      );
    } catch {
      /* 本地缓存读失败：候选为空，不影响手输 */
    }
    try {
      const remote = await fetchSuppliers(baseUrl);
      if (seq !== reqSeq.current) return; // 丢弃过期响应，避免竞态
      setSupplierList(Array.from(new Set([...remote, ...cached])));
    } catch {
      if (seq !== reqSeq.current) return;
      setSupplierList(cached);
    }
  }, [baseUrl]);

  useEffect(() => {
    void loadSuppliers();
  }, [loadSuppliers]);

  const onSupplierChange = (v: string) => {
    setSupplierName(v);
    setShowSuggest(true);
  };

  const pickSupplier = (name: string) => {
    setSupplierName(name);
    setShowSuggest(false);
  };

  // 大小写不敏感的子串匹配，本地即时过滤（最多展示 20 条）
  const suggestions = (() => {
    const q = supplierName.trim().toLowerCase();
    if (!q) return [];
    return supplierList.filter((n) => n.toLowerCase().includes(q)).slice(0, 20);
  })();

  const addItem = () => setItems([...items, { name: '', quantity: '', unit: '', price: '', barcode: '', imageUri: '' }]);
  const addItemToGroup = (uri: string) => {
    let insertAt = items.length;
    for (let i = items.length - 1; i >= 0; i--) {
      if ((items[i].imageUri || '') === uri) {
        insertAt = i + 1;
        break;
      }
    }
    const next = [...items];
    next.splice(insertAt, 0, { name: '', quantity: '', unit: '', price: '', barcode: '', imageUri: uri });
    setItems(next);
  };
  const toggleGroup = (uri: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(uri)) next.delete(uri);
      else next.add(uri);
      return next;
    });
  };
  const updateItem = (i: number, key: keyof ItemRow, val: string) => {
    const next = [...items];
    next[i] = { ...next[i], [key]: val };
    setItems(next);
  };
  const removeItem = (i: number) => setItems(items.filter((_, idx) => idx !== i));

  const handleTake = async () => {
    if (!permission?.granted) {
      const r = await requestPermission();
      if (!r.granted) {
        Alert.alert('需要相机权限才能拍照');
        return;
      }
    }
    setRetakeUri(null); // 普通拍照是「追加」，清掉可能残留的重拍目标
    setCameraOpen(true);
  };

  // 某张照片识别不准 → 重新拍照识别：打开相机并标记要替换的目标 URI。
  // OCR 对同一张图确定性，重跑无效果；必须重拍新图替换原图再识别。
  const handleRetake = async (uri: string) => {
    if (!permission?.granted) {
      const r = await requestPermission();
      if (!r.granted) {
        Alert.alert('需要相机权限才能拍照');
        return;
      }
    }
    setRetakeUri(uri);
    setCameraOpen(true);
  };

  const onCameraReady = useCallback(async () => {
    try {
      // 显式选择设备支持的最大 pictureSize，避免 expo-camera 默认只给 ~1080p
      const available = await (camRef.current as any)?.getAvailablePictureSizesAsync?.();
      if (Array.isArray(available) && available.length > 0) {
        const sizes = available
          .map((s: string) => {
            const [w, h] = s.split('x').map((n) => parseInt(n, 10));
            return { s, area: (w || 0) * (h || 0) };
          })
          .filter((it) => it.area > 0)
          .sort((a, b) => b.area - a.area);
        const best = sizes[0]?.s;
        if (best) {
          console.log('[camera] choose pictureSize', best, 'from', available);
          setPictureSize(best);
        }
      }
    } catch (e: any) {
      console.log('[camera] getAvailablePictureSizesAsync failed', e?.message || e);
    }
  }, []);

  const onCapture = async (doRecognize = false) => {
    try {
      // skipProcessing:true + 最大 pictureSize：保留相机原生全分辨率，避免 iOS 被压到 ~1080p
      const photo = await camRef.current?.takePictureAsync({
        base64: false,
        quality: 1,
        skipProcessing: true,
      });
      console.log('[camera] photo', photo?.uri, 'size', photo?.width, 'x', photo?.height);
      // 去重：同一个 uri 绝不进两次，否则同步时会被当成两张照片各传一遍
      if (photo?.uri) {
        const renamed = await renameCapturedPhoto(photo.uri);
        const target = retakeUri; // 捕获当前重拍目标，后续 setRetakeUri(null) 不影响本函数逻辑
        if (target) {
          // 重拍替换模式：新照片直接替换旧照片 URI，images / items.imageUri / collapsedGroups 三处同步
          setImages((prev) => prev.map((u) => (u === target ? renamed : u)));
          setItems((prev) =>
            prev.map((it) => (it.imageUri === target ? { ...it, imageUri: renamed } : it)),
          );
          setCollapsedGroups((prev) => {
            if (!prev.has(target)) return prev;
            const next = new Set(prev);
            next.delete(target);
            next.add(renamed);
            return next;
          });
          setRetakeUri(null);
          // 重拍的目的就是用新照片重新识别，强制跑 OCR（无视用户按的是「拍摄」还是「识别」）
          await recognizeUri(renamed);
        } else {
          setImages((prev) => (prev.includes(renamed) ? prev : [...prev, renamed]));
          if (doRecognize) await recognizeUri(renamed);
        }
      }
    } catch (e: any) {
      Alert.alert('拍照失败', e?.message || '');
    } finally {
      setCameraOpen(false);
    }
  };

  // 把 expo-camera 的随机 UUID 缓存文件名改为「供应商_日期_序号.jpg」，
  // 这样 UI 列表和后续归档都直观；失败则回退原 uri 不影响功能。
  const renameCapturedPhoto = async (uri: string): Promise<string> => {
    try {
      // 过滤文件名非法/特殊字符（含微信里常见的【】[]），避免部分文件系统显示异常
      const safeSupplier = (supplierName || '单据').replace(/[\\/:*?"<>|\[\]【】\r\n\t]/g, '').trim().slice(0, 20) || '单据';
      // 文件名日期用「进货日期」(purchaseDate)，而非拍照当天：单据照片按业务日期归档，
      // OCR 回填的单据日期不应影响归档名。进货日期未填时回退拍照当天，避免文件名出现空段。
      const dateStr = (purchaseDate || today).replace(/-/g, '');
      const dir = (FileSystem.documentDirectory || '') + 'bill_images/';
      await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
      const existing = await FileSystem.readDirectoryAsync(dir).catch(() => [] as string[]);
      const prefix = `${safeSupplier}_${dateStr}_`;
      const seq = existing.filter((f) => f.startsWith(prefix) && f.endsWith('.jpg')).length + 1;
      const fileName = `${prefix}${seq}.jpg`;
      const dest = dir + fileName;
      await FileSystem.copyAsync({ from: uri, to: dest });
      console.log('[EntryForm] renamed photo', uri, '->', dest);
      return dest;
    } catch (e: any) {
      console.warn('[EntryForm] rename photo failed, use original', e?.message || e);
      return uri;
    }
  };

  // 拍照时供应商可能还没填（录单据模式常见），文件先以「单据」占位命名；
  // OCR 回填供应商/进货日期后，这里把文件重命名为规范的「供应商_进货日期_序号.jpg」，
  // 与商品明细模式保持一致。文件名已符合规范则不动，避免无谓的磁盘读写。
  const renameToCanonical = async (uri: string, supplier: string, date: string): Promise<string> => {
    try {
      const safeSupplier = (supplier || '单据').replace(/[\\/:*?"<>|\[\]【】\r\n\t]/g, '').trim().slice(0, 20) || '单据';
      const dateStr = (date || today).replace(/-/g, '');
      const dir = (FileSystem.documentDirectory || '') + 'bill_images/';
      const baseName = uri.split('/').pop() || '';
      const prefix = `${safeSupplier}_${dateStr}_`;
      if (baseName.startsWith(prefix) && baseName.endsWith('.jpg')) return uri; // 已规范，跳过
      const existing = await FileSystem.readDirectoryAsync(dir).catch(() => [] as string[]);
      // 找到该供应商+日期下的下一个序号，且确保不与已存在文件撞名
      let seq = existing.filter((f) => f.startsWith(prefix) && f.endsWith('.jpg')).length + 1;
      let fileName = `${prefix}${seq}.jpg`;
      while (existing.includes(fileName)) {
        seq += 1;
        fileName = `${prefix}${seq}.jpg`;
      }
      const dest = dir + fileName;
      await FileSystem.copyAsync({ from: uri, to: dest });
      await FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {});
      console.log('[EntryForm] canonical rename', uri, '->', dest);
      return dest;
    } catch (e: any) {
      console.warn('[EntryForm] canonical rename failed, keep original', e?.message || e);
      return uri;
    }
  };

  // 调后端 /api/ocr/scan 识别进货单照片，解析后回填表单字段（仅覆盖为空/默认值的字段，不覆盖用户已填内容）
  const recognizeUri = async (uri: string) => {
    setRecognizing(true);
    try {
      // 读本地图片为 base64 dataURL：用 Expo FileSystem 读文件 → base64
      const base64 = await readFileAsBase64(uri);
      const full = /^https?:\/\//.test(baseUrl) ? baseUrl.replace(/\/+$/, '') : `http://${baseUrl.replace(/\/+$/, '')}`;
      const res = await apiFetch(`${full}/api/ocr/scan`, {
        method: 'POST',
        body: JSON.stringify({ data: `data:image/jpeg;base64,${base64}` }),
      });
      // 先判 HTTP 状态：鉴权失败/未连上服务器必须明确提示，不能再和「真没识别出字」混为一谈
      if (!res.ok) {
        const reason =
          res.status === 401
            ? '未连接店铺服务器或鉴权失败：请在「设置」填入服务器地址，并确保手机连店铺 WiFi（仅局域网下发接口令牌）。'
            : res.status === 503
              ? '数据库启动中，请稍候重试。'
              : `识别请求被拒绝（HTTP ${res.status}），请确认已连接店铺服务器。`;
        Alert.alert('识别失败', reason);
        return;
      }
      const data = res.json?.data;
      // 后端业务错误（如腾讯云密钥缺失、识别异常）：HTTP 200 但 code!=0，明确提示而非静默空过。
      if (res.json && res.json.code && res.json.code !== 0) {
        Alert.alert('识别失败', res.json.msg || '服务端识别异常，请稍后重试');
        return;
      }
      const text = data?.text || '';
      if (!text) {
        Alert.alert('识别完成', '未从照片中识别出文字，请确认单据清晰后重试，或手动录入。');
        return;
      }
      const bill = parsePurchaseBill(text);
      // 单据号：仅当当前仍是默认生成的 DD- 占位时才覆盖
      if (bill.orderNo && /^DD-/.test(orderNo)) setOrderNo(bill.orderNo);
      if (bill.supplierName) {
        // 自动带出：用识别出的简称（如「金达」）去供应商列表模糊匹配，
        // 命中则填回全称（如「金达商贸有限公司」），没命中则保留简称，由用户手选/手动补全
        const s = bill.supplierName;
        setSupplierName(s);
        const match = supplierList.find((n) => n === s || n.includes(s) || s.includes(n));
        if (match) setSupplierName(match);
      }
      if (bill.date) setPurchaseDate(bill.date);
      if (bill.arrivalDate) setArrivalDate(bill.arrivalDate);
      if (bill.total != null && !totalAmountInput) setTotalAmountInput(String(bill.total));
      if (bill.paid != null && !paidAmount) setPaidAmount(String(bill.paid));
      if (bill.discount != null && !discount) setDiscount(String(bill.discount));
      if (bill.note) setNote(bill.note);
      // OCR 回填供应商/进货日期后，把照片重命名为规范「供应商_进货日期_序号.jpg」
      // （录单据模式拍照时供应商常为空，文件先以「单据」占位，这里纠正）。
      const finalSupplier = bill.supplierName || supplierName;
      // 文件名日期优先用 OCR 识别出的单据日期，单据日期才是业务归档日期；
      // React setState 异步，purchaseDate 这里可能还是拍照当天的旧值。
      const finalDate = bill.date || purchaseDate || today;
      const canonicalUri = await renameToCanonical(uri, finalSupplier, finalDate);
      if (canonicalUri !== uri) {
        setImages((prev) => prev.map((u) => (u === uri ? canonicalUri : u)));
      }
      // 「录单据 / 其他」模式下识别：只回填单头字段，绝不切到商品明细模式
      // （用户反馈：用录单据方式识别时不应跳转到商品明细录入）。
      // 仅当用户当前已选「商品明细」模式，才把识别出的明细行回填进去。
      // 每条明细绑定照片 URI：重新识别同一张照片时只替换该照片组，避免重复追加。
      if (bill.items.length > 0 && entryMode === 'detail') {
        const targetUri = canonicalUri || uri;
        const parsedRows = bill.items.map((it) => ({
          barcode: it.barcode || '',
          name: it.name,
          quantity: it.quantity != null ? String(it.quantity) : '',
          unit: it.unit || '',
          price: it.price != null ? String(it.price) : '',
          imageUri: targetUri,
        }));
        setItems((prev) => {
          const onlyBlankManual =
            prev.length === 1 &&
            !prev[0].imageUri &&
            !prev[0].name &&
            !prev[0].barcode &&
            !prev[0].quantity &&
            !prev[0].price;
          const kept = onlyBlankManual ? [] : prev.filter((it) => it.imageUri !== targetUri && it.imageUri !== uri);
          return [...kept, ...parsedRows];
        });
        // 自动展开当前照片组，方便用户立即核对
        setCollapsedGroups((prev) => {
          const next = new Set(prev);
          next.delete(targetUri);
          next.delete(uri);
          return next;
        });
      }
      const tips: string[] = [];
      if (bill.items.length === 0) tips.push('未解析出商品明细，请手动补充');
      // 明细缺数量/单价的行：拍照裁切或折行常导致这几列丢失
      const incomplete = bill.items.filter((it) => it.quantity == null || it.price == null).length;
      if (incomplete > 0) tips.push(`${incomplete} 条明细缺数量或单价，请补齐`);
      // 票面合计与明细求和对不上 → 大概率漏行，明确告知差额而不是静默通过
      if (bill.total != null && bill.itemsTotal != null && Math.abs(bill.total - bill.itemsTotal) > 0.01) {
        const diff = Math.abs(bill.total - bill.itemsTotal).toFixed(2);
        tips.push(`票面合计 ¥${bill.total.toFixed(2)} 与明细合计 ¥${bill.itemsTotal.toFixed(2)} 差 ¥${diff}，可能有漏行`);
      }
      Alert.alert('识别完成', '已自动回填，请核对修正。' + (tips.length ? '\n' + tips.join('；') : ''));
    } catch (e: any) {
      Alert.alert('识别失败', e?.message || '请确认已连接店铺服务器（含腾讯云密钥的 3001 后端）。');
    } finally {
      setRecognizing(false);
    }
  };

  // 读本地图片文件为 base64 字符串（不带头部的纯 base64）
  const readFileAsBase64 = async (uri: string): Promise<string> => {
    try {
      return await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 });
    } catch (e: any) {
      console.warn('[EntryForm] readFileAsBase64 failed', e?.message || e);
      throw new Error('读取照片失败');
    }
  };

  const save = () => {
    let itemsOut: Array<{ barcode: string; name: string; quantity: number; unit: string; price: number; amount: number }>;
    let totalAmount: number;
    let stockStatus = 1;
    if (entryMode === 'detail') {
      const filled = items.filter((it) => it.name || it.quantity || it.barcode || it.price);
      itemsOut = filled.map((it) => {
        const quantity = Number(it.quantity) || 0;
        const price = Number(it.price) || 0;
        const amount = quantity * price;
        return {
          barcode: it.barcode || '',
          name: it.name,
          quantity,
          unit: it.unit,
          price,
          amount,
        };
      });
      totalAmount = itemsOut.reduce((s, it) => s + it.amount, 0);
    } else if (entryMode === 'bill') {
      totalAmount = Number(totalAmountInput) || 0;
      itemsOut = [{ barcode: '', name: '进货(总额)', quantity: 1, unit: '单', price: totalAmount, amount: totalAmount }];
    } else {
      stockStatus = 2;
      totalAmount = Number(totalAmountInput) || 0;
      itemsOut = [{ barcode: '', name: note.trim() || '其他', quantity: 1, unit: '单', price: totalAmount, amount: totalAmount }];
    }
    // 「下单日期」字段已删，进货日期即这张单的业务日期：date === purchaseDate。
    // 保留 date 列是因为它是全 App 通用的记录日期（列表排序、报表分桶、
    // 上传归档 ymd、syncEngine 的 arrivalDate 兜底都读它）。
    const billDate = purchaseDate || today;
    const common = {
      orderNo,
      date: billDate,
      supplierName,
      items: JSON.stringify(itemsOut),
      totalAmount,
      paidAmount: Number(paidAmount) || 0,
      discount: Number(discount) || 0,
      arrivalDate,
      note,
      images: JSON.stringify(images),
      purchaseDate: billDate,
      stockStatus,
      saveToStockIn: saveToStockIn ? 1 : 0,
    };
    // 保存 = 只写本机 SQLite，全程同步、零 await、不碰网络。
    // 店里电脑关机、手机用 4G、完全飞行模式，这一步的行为都完全一样。
    // 推送交给 syncEngine 在探到后端可达时自己做。
    //
    // 唯一会失败的是本地写库。这种情况绝不能静默 —— 用户以为记下了、实际没落盘，
    // 对一个台账 App 是最严重的故障，所以这里明确弹错并**保持表单不关闭**，
    // 让用户还能截图/重试，而不是让异常冒到 onPress 外面去崩掉 App。
    try {
      if (editId) {
        updateDraft(editId, common);
      } else {
        insertDraft({
          id: draftId,
          paid: 0,
          deviceId: DEVICE_ID,
          category: '',
          ...common,
        });
      }
    } catch (e: any) {
      Alert.alert('保存失败', `本机存储写入失败，请重试。${e?.message || ''}`);
      return;
    }
    onSaved();
  };

  const detailTotal = items.reduce((s, it) => s + (Number(it.quantity) || 0) * (Number(it.price) || 0), 0);
  const totalForCalc = entryMode === 'detail' ? detailTotal : (Number(totalAmountInput) || 0);
  const unpaid = totalForCalc - (Number(paidAmount) || 0) - (Number(discount) || 0);

  // 商品明细按照片 URI 分组；imageUri 为空的归为「手动添加」组
  const groups = useMemo(() => {
    const map = new Map<string, { uri: string; entries: { item: ItemRow; globalIdx: number }[] }>();
    items.forEach((it, globalIdx) => {
      const uri = it.imageUri || '';
      if (!map.has(uri)) map.set(uri, { uri, entries: [] });
      map.get(uri)!.entries.push({ item: it, globalIdx });
    });
    return Array.from(map.values()).map((g) => {
      const isManual = !g.uri;
      const pageNo = isManual ? 0 : images.indexOf(g.uri) + 1;
      const fileName = isManual ? '' : (g.uri.split('/').pop() || '');
      return { ...g, isManual, pageNo, fileName };
    });
  }, [items, images]);

  return (
    <View style={styles.root}>
      {/* 顶部安全区：本页是 App.tsx 里的绝对定位 overlay，拿不到根 SafeAreaRoot 的 iOS inset，
          必须在 header 这层自己避开状态栏/灵动岛（SafeAreaHeader 在 iOS 上幂等，不会双重内缩） */}
      <SafeAreaHeader style={styles.header}>
        {/* 44pt 最小点击区 + hitSlop：原来只有文字本身可点，命中率很差 */}
        <TouchableOpacity
          style={styles.headerBtn}
          onPress={onCancel}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          accessibilityRole="button"
        >
          <Text style={styles.back}>‹ 取消</Text>
        </TouchableOpacity>
        <Text style={styles.title}>{editId ? '编辑进货单' : '新建进货单'}</Text>
        <TouchableOpacity
          style={styles.headerBtn}
          onPress={save}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          accessibilityRole="button"
        >
          <Text style={styles.save}>保存</Text>
        </TouchableOpacity>
      </SafeAreaHeader>

      {/* M1：键盘弹起时不再遮住底部字段 */}
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
      <ScrollView contentContainerStyle={styles.pad} keyboardShouldPersistTaps="handled">
        {/* 「下单日期」已移除：与下面的「进货日期」默认值相同、语义重复（详见 save() 注释） */}
        <Text style={styles.label}>供应商名称</Text>
        <View style={styles.suggestWrap}>
          <TextInput
            style={styles.input}
            value={supplierName}
            onChangeText={onSupplierChange}
            onFocus={() => {
              void loadSuppliers();
              setShowSuggest(true);
            }}
            onBlur={() => setTimeout(() => setShowSuggest(false), 180)}
            placeholder="如 王师傅蔬果"
            autoCapitalize="none"
            autoCorrect={false}
          />
          {showSuggest && suggestions.length > 0 && (
            <View style={styles.suggestList}>
              {suggestions.map((item) => (
                <TouchableOpacity key={item} style={styles.suggestItem} onPress={() => pickSupplier(item)}>
                  <Text style={styles.suggestText}>{item}</Text>
                </TouchableOpacity>
              ))}
            </View>
          )}
        </View>

        <Text style={styles.label}>单据号</Text>
        <TextInput style={styles.input} value={orderNo} editable={false} placeholder="DD-20260801-XXXX" />

        <View style={styles.row2}>
          <View style={styles.col}>
            <Text style={styles.label}>进货日期</Text>
            <DatePickerField value={purchaseDate} onChange={setPurchaseDate} title="进货日期" />
          </View>
          <View style={styles.col}>
            <Text style={styles.label}>送货日期</Text>
            {/* 可空字段：弹层里给「清除」入口 */}
            <DatePickerField
              value={arrivalDate}
              onChange={setArrivalDate}
              placeholder="可空"
              allowEmpty
              title="送货日期"
            />
          </View>
        </View>

        <Text style={styles.label}>录入方式</Text>
        <View style={styles.segRow}>
          {ENTRY_MODE_OPTIONS.map((opt) => {
            const active = entryMode === opt.v;
            return (
              <TouchableOpacity
                key={opt.v}
                style={[styles.segItem, active && { borderColor: theme.color.primaryVivid, borderWidth: 1.5 }]}
                onPress={() => setEntryMode(opt.v)}
              >
                <Text style={[styles.segText, active && { color: theme.color.primaryVivid, fontWeight: theme.font.weight.medium }]}>
                  {opt.label}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>

        {entryMode === 'detail' ? (
          <>
            <Text style={styles.label}>商品明细</Text>
            {groups.map((group) => {
              const collapsed = collapsedGroups.has(group.uri);
              const groupSubtotal = group.entries.reduce(
                (s, e) => s + (Number(e.item.quantity) || 0) * (Number(e.item.price) || 0),
                0
              );
              return (
                <View key={group.uri || 'manual'} style={styles.groupCard}>
                  <View style={styles.groupHeader}>
                    <View style={styles.groupTitleWrap}>
                      <Text style={styles.groupTitle}>
                        {group.isManual ? '手动添加' : group.pageNo > 0 ? `第 ${group.pageNo} 页` : '照片'}
                        {!group.isManual && group.fileName ? ` · ${group.fileName}` : ''}
                      </Text>
                      <Text style={styles.groupCount}>
                        {group.entries.length} 件商品 · 本页小计 ¥{groupSubtotal.toFixed(2)}
                      </Text>
                    </View>
                    <View style={styles.groupActions}>
                      {!group.isManual && (
                        <TouchableOpacity
                          onPress={() => handleRetake(group.uri)}
                          disabled={recognizing}
                          hitSlop={{ top: 4, bottom: 4, left: 8, right: 8 }}
                        >
                          <Text style={[styles.groupActionText, recognizing && { opacity: 0.5 }]}>重新拍照识别</Text>
                        </TouchableOpacity>
                      )}
                      <TouchableOpacity
                        onPress={() => toggleGroup(group.uri)}
                        hitSlop={{ top: 4, bottom: 4, left: 8, right: 8 }}
                      >
                        <Text style={styles.groupToggle}>{collapsed ? '展开' : '折叠'}</Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                  {!collapsed && (
                    <>
                      {group.entries.map(({ item: it, globalIdx }) => (
                        <View key={globalIdx} style={styles.itemCard}>
                          <View style={styles.itemRow}>
                            <View style={[styles.cellWrap, styles.cellBarcode]}>
                              <Text style={styles.cellLabel}>条码</Text>
                              <TextInput
                                style={styles.cell}
                                placeholder="条码"
                                value={it.barcode}
                                onChangeText={(v) => updateItem(globalIdx, 'barcode', v)}
                              />
                            </View>
                            <View style={[styles.cellWrap, styles.cellName]}>
                              <Text style={styles.cellLabel}>名称</Text>
                              <TextInput
                                style={styles.cell}
                                placeholder="名称"
                                value={it.name}
                                onChangeText={(v) => updateItem(globalIdx, 'name', v)}
                              />
                            </View>
                            {items.length > 1 && (
                              <TouchableOpacity
                                style={styles.delBtn}
                                onPress={() => removeItem(globalIdx)}
                                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                                accessibilityRole="button"
                                accessibilityLabel={`删除第 ${globalIdx + 1} 行商品`}
                              >
                                <Text style={styles.del}>×</Text>
                              </TouchableOpacity>
                            )}
                          </View>
                          <View style={styles.itemRow}>
                            <View style={[styles.cellWrap, styles.cellQty]}>
                              <Text style={styles.cellLabel}>数量</Text>
                              <TextInput
                                style={styles.cell}
                                placeholder="数量"
                                value={it.quantity}
                                onChangeText={(v) => updateItem(globalIdx, 'quantity', v)}
                                keyboardType="numeric"
                              />
                            </View>
                            <View style={[styles.cellWrap, styles.cellUnit]}>
                              <Text style={styles.cellLabel}>单位</Text>
                              <TextInput
                                style={styles.cell}
                                placeholder="单位"
                                value={it.unit}
                                onChangeText={(v) => updateItem(globalIdx, 'unit', v)}
                              />
                            </View>
                            <View style={[styles.cellWrap, styles.cellPrice]}>
                              <Text style={styles.cellLabel}>单价</Text>
                              <TextInput
                                style={styles.cell}
                                placeholder="单价"
                                value={it.price}
                                onChangeText={(v) => updateItem(globalIdx, 'price', v)}
                                keyboardType="numeric"
                              />
                            </View>
                            <View style={[styles.cellWrap, styles.cellAmount]}>
                              <Text style={styles.cellLabel}>金额</Text>
                              <Text style={styles.itemAmount}>
                                ¥{((Number(it.quantity) || 0) * (Number(it.price) || 0)).toFixed(2)}
                              </Text>
                            </View>
                          </View>
                        </View>
                      ))}
                      <TouchableOpacity style={styles.addRowGroup} onPress={() => addItemToGroup(group.uri)}>
                        <Text style={styles.addText}>＋ 在本组添加一行</Text>
                      </TouchableOpacity>
                      <View style={styles.groupFooter}>
                        <Text style={styles.groupFooterLabel}>本页小计</Text>
                        <Text style={styles.groupFooterValue}>¥{groupSubtotal.toFixed(2)}</Text>
                      </View>
                    </>
                  )}
                </View>
              );
            })}
            <TouchableOpacity style={styles.addRow} onPress={addItem}>
              <Text style={styles.addText}>＋ 增加一行</Text>
            </TouchableOpacity>

            <Text style={styles.label}>总金额（明细自动合计）</Text>
            <Text style={styles.readonlyValue}>¥{detailTotal.toFixed(2)}</Text>

            <View style={styles.switchRow}>
              <View style={styles.switchTextWrap}>
                <Text style={styles.switchLabel}>保存为入库单</Text>
                <Text style={styles.switchHint}>同步到后端时自动生成入库单（已入库）</Text>
              </View>
              <Switch
                value={saveToStockIn}
                onValueChange={setSaveToStockIn}
                trackColor={{ false: theme.color.border, true: theme.color.primaryVivid }}
                thumbColor="#fff"
                style={styles.switchCtrl}
              />
            </View>
          </>
        ) : (
          <>
            <Text style={styles.label}>进货总额</Text>
            <TextInput
              style={[styles.input, styles.numInput]}
              value={totalAmountInput}
              onChangeText={setTotalAmountInput}
              placeholder="0"
              keyboardType="numeric"
            />
            {entryMode === 'other' && (
              <>
                <Text style={styles.label}>备注（其他模式说明）</Text>
                <TextInput
                  style={styles.input}
                  value={note}
                  onChangeText={setNote}
                  placeholder="如：暂未入库，按金额暂记"
                  multiline
                />
              </>
            )}
          </>
        )}

        <Text style={styles.label}>打款金额（已付）</Text>
        <TextInput style={[styles.input, styles.numInput]} value={paidAmount} onChangeText={setPaidAmount} placeholder="0" keyboardType="numeric" />

        <Text style={styles.label}>优惠金额</Text>
        <TextInput style={[styles.input, styles.numInput]} value={discount} onChangeText={setDiscount} placeholder="0" keyboardType="numeric" />

        <Text style={styles.label}>未付金额（自动）</Text>
        <Text style={styles.readonlyValue}>¥{unpaid.toFixed(2)}</Text>

        {/*
          「其他」模式下上面已经有一个「备注（其他模式说明）」在编辑同一个 note state，
          这里再渲染一个通用备注框，两个输入框绑同一份数据 —— 在一个里打字另一个跟着变，
          用户会以为串行了。而且 save() 里「其他」模式是拿 note 当条目名的
          （name: note.trim() || '其他'），语义上它就是那条说明，不是附加备注。
          所以「其他」模式不再重复渲染通用备注。
        */}
        {entryMode !== 'other' && (
          <>
            <Text style={styles.label}>备注</Text>
            <TextInput style={[styles.input, styles.area]} value={note} onChangeText={setNote} placeholder="可空" multiline />
          </>
        )}

        <TouchableOpacity style={styles.cameraBtn} onPress={handleTake}>
          <Text style={styles.cameraText}>📷 拍照（{images.length} 张）</Text>
        </TouchableOpacity>
        {images.map((u, i) => (
          <Text key={u + i} style={styles.imgPath} numberOfLines={1}>
            · {u.split('/').pop()}
          </Text>
        ))}
      </ScrollView>
      </KeyboardAvoidingView>

      {/*
        相机 Modal 走独立 native window，App 根节点的 safe area padding 完全作用不到，
        camBar 原本只有 24pt 内边距，iOS 34pt Home Indicator 会压住「关闭 / 拍摄」，
        拍完退不出来 —— 功能性死锁。这里手动补 BOTTOM_INSET。
      */}
      <Modal visible={cameraOpen} animationType="slide" onRequestClose={() => { setRetakeUri(null); setCameraOpen(false); }}>
        <View style={styles.camWrap}>
          <CameraView style={styles.cam} ref={camRef} pictureSize={pictureSize} onCameraReady={onCameraReady} />
          <ScanFrame variant="sheet" title="将送货单放入框内，对齐边缘" subtitle="自动识别 供应商 / 单号 / 金额 / 日期" />
          <View style={styles.camBar}>
            <TouchableOpacity onPress={() => { setRetakeUri(null); setCameraOpen(false); }}>
              <Text style={styles.camBtn}>关闭</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => onCapture(false)} disabled={recognizing}>
              <Text style={styles.camShoot}>● 拍摄</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => onCapture(true)} disabled={recognizing}>
              <Text style={styles.camShoot}>识别</Text>
            </TouchableOpacity>
          </View>
          {recognizing ? (
            <View style={styles.camLoading}>
              <Text style={{ color: '#fff' }}>识别中…</Text>
            </View>
          ) : null}
        </View>
      </Modal>
    </View>
  );
}

function makeStyles(theme: any) {
  return StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.color.bg },
  flex: { flex: 1 },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    minHeight: theme.size.controlLg,
    paddingHorizontal: theme.spaceScale[4],
    borderBottomWidth: 1, borderBottomColor: theme.color.border,
  },
  // 顶部按钮统一 44pt 触控区（iOS HIG / Material 最小可点尺寸）
  headerBtn: { minHeight: theme.size.tapMin, minWidth: 56, justifyContent: 'center' },
  // 色值统一为 primaryVivid：primary(#C2470A) 在 #1E1813 暗底上对比不足
  back: { color: theme.color.primaryVivid, fontSize: theme.font.size.md },
  title: { fontSize: theme.font.size.lg, fontWeight: theme.font.weight.bold, color: theme.color.text },
  save: { color: theme.color.primaryVivid, fontSize: theme.font.size.md, fontWeight: theme.font.weight.medium, textAlign: 'right' },
  // M2：底部留白加大，最后一个字段不再贴边
  pad: { padding: theme.space(2), paddingBottom: theme.spaceScale[10] },
  label: { fontSize: theme.font.size.sm, color: theme.color.textMuted, marginTop: theme.space(1.5), marginBottom: theme.space(0.5) },
  input: {
    backgroundColor: theme.color.surfaceRaised, borderRadius: theme.radius.md, borderWidth: 1,
    borderColor: theme.color.border, paddingHorizontal: theme.space(1.5), paddingVertical: theme.space(1),
    fontSize: theme.font.size.md, color: theme.color.text,
  },
  // 供应商自动补全下拉：相对定位容器 + 绝对定位列表，覆盖在后续字段之上
  suggestWrap: { position: 'relative', zIndex: theme.z.sticky },
  suggestList: {
    position: 'absolute', top: '100%', left: 0, right: 0, marginTop: 4,
    backgroundColor: theme.color.surfaceRaised, borderRadius: theme.radius.md,
    borderWidth: 1, borderColor: theme.color.border,
    maxHeight: 220, zIndex: theme.z.sticky, overflow: 'hidden',
  },
  suggestItem: {
    paddingVertical: theme.space(1), paddingHorizontal: theme.space(1.5),
    borderBottomWidth: 1, borderBottomColor: theme.color.divider,
  },
  suggestText: { fontSize: theme.font.size.md, color: theme.color.text },
  area: { height: 72, textAlignVertical: 'top' },
  numInput: { textAlign: 'right', fontVariant: ['tabular-nums'] },
  row2: { flexDirection: 'row', gap: theme.space(1.5) },
  col: { flex: 1 },
  itemRow: { flexDirection: 'row', alignItems: 'center', marginBottom: theme.space(0.5) },
  cell: {
    flex: 1, backgroundColor: theme.color.surfaceRaised, borderRadius: theme.radius.sm, borderWidth: 1,
    borderColor: theme.color.border, paddingHorizontal: 6, paddingVertical: 8, fontSize: theme.font.size.sm,
    color: theme.color.text, marginRight: 4,
  },
  cellBarcode: { flex: 1.3 },
  cellName: { flex: 2 },
  cellQty: { flex: 1 },
  del: { color: theme.color.danger, fontSize: 22 },
  // M3：破坏性操作满足 44×44 最小热区
  delBtn: {
    minWidth: theme.size.tapMin, minHeight: theme.size.tapMin,
    alignItems: 'center', justifyContent: 'center',
  },
  // M4：「＋ 增加一行」原来约 30pt，抬到 44pt
  addRow: { minHeight: theme.size.tapMin, justifyContent: 'center', paddingVertical: theme.space(1) },
  addRowGroup: { minHeight: theme.size.tapMin, justifyContent: 'center', paddingVertical: theme.space(0.5) },
  addText: { color: theme.color.primaryVivid, fontSize: theme.font.size.sm },
  groupCard: {
    backgroundColor: theme.color.surfaceRaised, borderRadius: theme.radius.md, borderWidth: 1,
    borderColor: theme.color.border, padding: theme.space(1), marginBottom: theme.space(1),
  },
  groupHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingVertical: theme.space(0.75), paddingHorizontal: theme.space(0.5),
  },
  groupTitleWrap: { flex: 1, marginRight: theme.space(1) },
  groupTitle: { fontSize: theme.font.size.sm, color: theme.color.text, fontWeight: theme.font.weight.medium },
  groupCount: { fontSize: theme.font.size.xs, color: theme.color.textMuted, marginTop: 2 },
  groupActions: { flexDirection: 'row', alignItems: 'center', gap: theme.space(1.5) },
  groupActionText: { fontSize: theme.font.size.xs, color: theme.color.primaryVivid },
  groupToggle: { fontSize: theme.font.size.xs, color: theme.color.textSecondary },
  groupFooter: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    marginTop: theme.space(0.5), paddingTop: theme.space(1), paddingHorizontal: theme.space(0.5),
    borderTopWidth: 1, borderTopColor: theme.color.border,
  },
  groupFooterLabel: { fontSize: theme.font.size.sm, color: theme.color.textSecondary, fontWeight: theme.font.weight.medium },
  groupFooterValue: {
    fontSize: theme.font.size.md, color: theme.color.text, fontWeight: theme.font.weight.bold,
    fontVariant: ['tabular-nums'],
  },
  itemCard: {
    backgroundColor: theme.color.surfaceRaised, borderRadius: theme.radius.md, borderWidth: 1,
    borderColor: theme.color.border, padding: theme.space(1), marginBottom: theme.space(1),
  },
  cellUnit: { flex: 1, marginRight: 4 },
  cellPrice: { flex: 1.2, marginRight: 4 },
  // 字段名常驻容器：竖向堆叠 label + 输入/只读值，flex 由下方 cellXxx / cellAmount 提供
  cellWrap: { flexDirection: 'column', alignItems: 'stretch' },
  cellLabel: { fontSize: theme.font.sizeV4.caption, color: theme.color.textAppTertiary, marginBottom: 2, paddingLeft: 2 },
  cellAmount: { flex: 1.6 },
  itemAmount: { textAlign: 'right', fontSize: theme.font.size.sm, color: theme.color.text, paddingHorizontal: 6, paddingVertical: 8 },
  readonlyValue: {
    backgroundColor: theme.color.surfaceSunken, borderRadius: theme.radius.md, borderWidth: 1,
    borderColor: theme.color.border, paddingHorizontal: theme.space(1.5), paddingVertical: theme.space(1),
    fontSize: theme.font.size.md, color: theme.color.text, textAlign: 'right', fontVariant: ['tabular-nums'],
  },
  // 分段控件：轨道 = 暗色内陷，段 = 暗色抬高，激活 = 主题/语义描边+文字（不实心橙）
  segRow: { flexDirection: 'row', backgroundColor: theme.color.surfaceSunken, borderRadius: theme.radius.md, padding: 3 },
  segItem: {
    flex: 1, alignItems: 'center', paddingVertical: theme.space(1), marginHorizontal: 2,
    borderRadius: theme.radius.sm, backgroundColor: theme.color.surfaceRaised,
  },
  segText: { fontSize: theme.font.size.sm, color: theme.color.textSecondary },
  cameraBtn: {
    backgroundColor: theme.color.surfaceRaised, borderRadius: theme.radius.md,
    paddingVertical: theme.space(1.5), alignItems: 'center', marginTop: theme.space(2),
    borderWidth: 1, borderColor: theme.color.borderApp,
  },
  cameraText: { color: theme.color.primaryVivid, fontSize: theme.font.size.md, fontWeight: theme.font.weight.medium },
  imgPath: { fontSize: theme.font.size.xs, color: theme.color.textMuted, marginTop: 2, flex: 1, marginRight: theme.space(1) },
  imgRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    marginTop: theme.space(0.5),
  },
  reRecognizeBtn: {
    paddingHorizontal: theme.space(1), paddingVertical: theme.space(0.25),
    borderRadius: theme.radius.sm, backgroundColor: theme.color.surfaceSunken,
    borderWidth: 1, borderColor: theme.color.border,
  },
  reRecognizeText: { fontSize: theme.font.size.xs, color: theme.color.primaryVivid },
  // 「保存为入库单」开关行：左文案右开关，与录入方式分段控件同款底色
  switchRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: theme.color.surfaceSunken, borderRadius: theme.radius.md,
    paddingVertical: theme.space(1), paddingHorizontal: theme.space(1.5), marginTop: theme.space(1.5),
  },
  switchTextWrap: { flex: 1, marginRight: theme.space(1) },
  switchLabel: { fontSize: theme.font.size.md, color: theme.color.text, fontWeight: theme.font.weight.medium },
  switchHint: { fontSize: theme.font.size.xs, color: theme.color.textMuted, marginTop: 2 },
  switchCtrl: { transform: [{ scaleX: 0.9 }, { scaleY: 0.9 }] },
  camWrap: { flex: 1, backgroundColor: '#000' },
  cam: { flex: 1 },
  camBar: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    padding: theme.space(3),
    // Modal 拿不到父级 safe area，底部自己补 Home Indicator，否则按钮点不到
    paddingBottom: theme.space(3) + BOTTOM_INSET,
    backgroundColor: '#000',
  },
  camBtn: { color: '#fff', fontSize: theme.font.size.md, minHeight: theme.size.tapMin, textAlignVertical: 'center' },
  camShoot: { color: theme.color.primary, fontSize: theme.font.size.lg, fontWeight: theme.font.weight.bold },
  camLoading: {
    position: 'absolute', bottom: 0, left: 0, right: 0, alignItems: 'center',
    paddingBottom: BOTTOM_INSET + theme.spaceScale[10], backgroundColor: 'rgba(0,0,0,0.45)',
  },
});
}
