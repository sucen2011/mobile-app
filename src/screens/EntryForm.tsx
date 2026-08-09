import { useState, useRef, useCallback, useEffect } from 'react';
import {
  StyleSheet, View, Text, TextInput, TouchableOpacity, ScrollView, Modal, Alert,
  KeyboardAvoidingView, Platform,
} from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { BOTTOM_INSET, SafeAreaHeader } from '../components/SafeArea';
import { theme } from '../theme';
import { insertDraft, updateDraft, getDraftById, getCachedPurchases } from '../db/localDb';
import { DEVICE_ID } from '../config';
import { fetchSuppliers } from '../api/suppliers';
import { toLocalDateStr } from '../utils/dateLabel';
import DatePickerField from '../components/DatePickerField';

interface ItemRow {
  barcode?: string;
  name: string;
  quantity: string;
  unit: string;
  price: string;
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
  const today = toLocalDateStr(new Date());
  const draftId = useRef(uuid()).current; // 一次生成，保证 orderNo 默认值与保存 id 一致

  const [supplierName, setSupplierName] = useState('');
  const [orderNo, setOrderNo] = useState(() => 'DD-' + today.replace(/-/g, '') + '-' + draftId.slice(-4).toUpperCase());
  // 「下单日期」已删除：它和「进货日期」默认都是今天、语义重复，用户要填两遍。
  // 现在 purchaseDate 就是这张单唯一的业务日期，保存时同时写进草稿的 date 字段
  // （date 是全 App 通用的记录日期：明细/概览/报表排序、orderNo、上传归档都用它，不能去掉列）。
  const [purchaseDate, setPurchaseDate] = useState(today);
  const [entryMode, setEntryMode] = useState<'bill' | 'detail' | 'other'>('bill');
  const [items, setItems] = useState<ItemRow[]>([{ name: '', quantity: '', unit: '', price: '', barcode: '' }]);
  const [totalAmountInput, setTotalAmountInput] = useState('');
  const [arrivalDate, setArrivalDate] = useState('');
  const [paidAmount, setPaidAmount] = useState('');
  const [discount, setDiscount] = useState('');
  const [note, setNote] = useState('');
  const [images, setImages] = useState<string[]>([]);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [permission, requestPermission] = useCameraPermissions();
  const [pictureSize, setPictureSize] = useState<string | undefined>();
  const camRef = useRef<CameraView>(null);

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
      setItems(parsed.length ? parsed.map((it: any) => ({ barcode: it.barcode || '', name: it.name, quantity: String(it.quantity), unit: it.unit, price: String(it.price) })) : [{ name: '', quantity: '', unit: '', price: '', barcode: '' }]);
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

  const addItem = () => setItems([...items, { name: '', quantity: '', unit: '', price: '', barcode: '' }]);
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

  const onCapture = async () => {
    try {
      // skipProcessing:true + 最大 pictureSize：保留相机原生全分辨率，避免 iOS 被压到 ~1080p
      const photo = await camRef.current?.takePictureAsync({
        base64: false,
        quality: 1,
        skipProcessing: true,
      });
      console.log('[camera] photo', photo?.uri, 'size', photo?.width, 'x', photo?.height);
      // 去重：同一个 uri 绝不进两次，否则同步时会被当成两张照片各传一遍
      if (photo?.uri) setImages((prev) => (prev.includes(photo.uri) ? prev : [...prev, photo.uri]));
    } catch (e: any) {
      Alert.alert('拍照失败', e?.message || '');
    } finally {
      setCameraOpen(false);
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
            {items.map((it, i) => (
              <View key={i} style={styles.itemCard}>
                <View style={styles.itemRow}>
                  <View style={[styles.cellWrap, styles.cellBarcode]}>
                    <Text style={styles.cellLabel}>条码</Text>
                    <TextInput
                      style={styles.cell}
                      placeholder="条码"
                      value={it.barcode}
                      onChangeText={(v) => updateItem(i, 'barcode', v)}
                    />
                  </View>
                  <View style={[styles.cellWrap, styles.cellName]}>
                    <Text style={styles.cellLabel}>名称</Text>
                    <TextInput
                      style={styles.cell}
                      placeholder="名称"
                      value={it.name}
                      onChangeText={(v) => updateItem(i, 'name', v)}
                    />
                  </View>
                  {items.length > 1 && (
                    // M3：删除是破坏性操作，热区必须够大（原来仅约 26×26）
                    <TouchableOpacity
                      style={styles.delBtn}
                      onPress={() => removeItem(i)}
                      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                      accessibilityRole="button"
                      accessibilityLabel={`删除第 ${i + 1} 行商品`}
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
                      onChangeText={(v) => updateItem(i, 'quantity', v)}
                      keyboardType="numeric"
                    />
                  </View>
                  <View style={[styles.cellWrap, styles.cellUnit]}>
                    <Text style={styles.cellLabel}>单位</Text>
                    <TextInput
                      style={styles.cell}
                      placeholder="单位"
                      value={it.unit}
                      onChangeText={(v) => updateItem(i, 'unit', v)}
                    />
                  </View>
                  <View style={[styles.cellWrap, styles.cellPrice]}>
                    <Text style={styles.cellLabel}>单价</Text>
                    <TextInput
                      style={styles.cell}
                      placeholder="单价"
                      value={it.price}
                      onChangeText={(v) => updateItem(i, 'price', v)}
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
            <TouchableOpacity style={styles.addRow} onPress={addItem}>
              <Text style={styles.addText}>＋ 增加一行</Text>
            </TouchableOpacity>

            <Text style={styles.label}>总金额（明细自动合计）</Text>
            <Text style={styles.readonlyValue}>¥{detailTotal.toFixed(2)}</Text>
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
          <Text key={i} style={styles.imgPath} numberOfLines={1}>
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
      <Modal visible={cameraOpen} animationType="slide" onRequestClose={() => setCameraOpen(false)}>
        <View style={styles.camWrap}>
          <CameraView style={styles.cam} ref={camRef} pictureSize={pictureSize} onCameraReady={onCameraReady} />
          <View style={styles.camBar}>
            <TouchableOpacity onPress={() => setCameraOpen(false)}>
              <Text style={styles.camBtn}>关闭</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={onCapture}>
              <Text style={styles.camShoot}>● 拍摄</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
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
  addText: { color: theme.color.primaryVivid, fontSize: theme.font.size.sm },
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
  imgPath: { fontSize: theme.font.size.xs, color: theme.color.textMuted, marginTop: 2 },
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
});
