import React, { useState, useRef, useEffect } from 'react';
import {
  StyleSheet,
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  Alert,
  Modal,
  ActivityIndicator,
  Image,
} from 'react-native';
import { CameraView, useCameraPermissions, type CameraType } from 'expo-camera';
import { useTheme } from '../theme/ThemeProvider';
import ScanFrame from '../components/ScanFrame';
import { apiFetch } from '../api/client';
import { parseOcrText, type OcrResult, type NutritionItem } from '@sucen/ocr-core';
import { mockOcr } from '@sucen/ocr-core';
import { insertOcrCard, listOcrCards, deleteOcrCard, type OcrCard } from '../db/localDb';

type ViewName = 'main' | 'edit' | 'view';
type ExportFormat = 'nutrition' | 'ingredient' | 'both';
type BgType = 'white' | 'beige' | 'transparent';

interface Props {
  baseUrl: string;
}

export default function OcrImageScreen({ baseUrl }: Props) {
  const { theme } = useTheme();
  const styles = makeStyles(theme);
  const [view, setView] = useState<ViewName>('main');
  const [camOpen, setCamOpen] = useState(false);
  const [camType, setCamType] = useState<CameraType>('back');
  const [permission, requestPermission] = useCameraPermissions();
  const camRef = useRef<any>(null);

  const [result, setResult] = useState<OcrResult | null>(null);
  const [imageUri, setImageUri] = useState('');
  const [recognizing, setRecognizing] = useState(false);
  const [engine, setEngine] = useState('');

  const [cards, setCards] = useState<OcrCard[]>([]);
  const [editing, setEditing] = useState<OcrCard | null>(null);
  const [viewing, setViewing] = useState<OcrCard | null>(null);
  const [format, setFormat] = useState<ExportFormat>('both');
  const [bg, setBg] = useState<BgType>('white');

  const refreshCards = () => setCards(listOcrCards());
  useEffect(() => {
    if (view === 'main') {
      refreshCards();
    }
  }, [view]);

  // 相机拍照 → base64 → 真实 OCR
  const openCamera = async () => {
    if (!permission?.granted) {
      const r = await requestPermission();
      if (!r.granted) {
        Alert.alert('需要相机权限才能拍照识别');
        return;
      }
    }
    setCamOpen(true);
  };

  const snap = async () => {
    try {
      const photo = await camRef.current?.takePictureAsync({ base64: true, quality: 0.7, skipProcessing: false });
      setCamOpen(false);
      if (!photo?.base64) {
        Alert.alert('拍照失败', '未能获取照片数据');
        return;
      }
      await runRecognize(`data:image/jpeg;base64,${photo.base64}`, photo.uri || '');
    } catch (e: any) {
      setCamOpen(false);
      Alert.alert('拍照失败', e?.message || '');
    }
  };

  // 调后端 /api/ocr/scan（腾讯云或本地 tesseract 兜底）
  const runRecognize = async (dataUrl: string, uri: string) => {
    setRecognizing(true);
    try {
      const full = /^https?:\/\//.test(baseUrl) ? baseUrl.replace(/\/+$/, '') : `http://${baseUrl.replace(/\/+$/, '')}`;
      const res = await apiFetch(`${full}/api/ocr/scan`, {
        method: 'POST',
        body: JSON.stringify({ data: dataUrl }),
      });
      // 先判 HTTP 状态：鉴权失败/未连上服务器必须明确提示，不能再静默走示例数据
      if (!res.ok) {
        const reason =
          res.status === 401
            ? '未连接店铺服务器或鉴权失败：请在「设置」填入电脑端服务器地址，并确保手机连店铺 WiFi（仅局域网下发接口令牌）。'
            : res.status === 503
              ? '数据库启动中，请稍候重试。'
              : `识别请求被拒绝（HTTP ${res.status}），请确认已连接店铺服务器（含腾讯云密钥的 3001 后端）。`;
        Alert.alert('识别请求失败', reason);
        return;
      }
      const data = res.json?.data;
      // 后端业务错误（如腾讯云密钥缺失、识别异常）：HTTP 200 但 code!=0，
      // 不能再当成「没识别出字」静默走示例数据，必须明确提示。
      if (res.json && res.json.code && res.json.code !== 0) {
        Alert.alert('识别失败', res.json.msg || '服务端识别异常，请稍后重试');
        return;
      }
      const text = data?.text || '';
      const eng = data?.engine || 'unknown';
      setEngine(eng);
      if (!text) {
        const r = mockOcr();
        setResult(r);
        Alert.alert('云端未返回文字', '已用示例数据，你可手动填写后生成主图。');
      } else {
        const parsed = parseOcrText(text);
        if (!parsed.productName && !parsed.ingredients && parsed.nutrition.length === 0) {
          setResult(mockOcr());
          Alert.alert('未解析到商品信息', '版式可能较特殊，已用示例数据，你可手动填写。');
        } else {
          setResult(parsed);
        }
      }
      setImageUri(uri);
      setView('edit');
    } catch (e: any) {
      Alert.alert('识别请求失败', e?.message || '请确认已连接店铺服务器（含腾讯云密钥的 3001 后端）。');
    } finally {
      setRecognizing(false);
    }
  };

  // 使用示例数据（无拍摄时的演示/兜底）
  const useSample = async () => {
    setRecognizing(true);
    try {
      const r = mockOcr();
      setResult(r);
      setImageUri('');
      setEngine('sample');
      setView('edit');
    } finally {
      setRecognizing(false);
    }
  };

  const updateField = (patch: Partial<OcrResult>) => {
    if (!result) return;
    setResult({ ...result, ...patch });
  };
  const updateNutrition = (idx: number, patch: Partial<NutritionItem>) => {
    if (!result) return;
    const list = [...result.nutrition];
    list[idx] = { ...list[idx], ...patch };
    setResult({ ...result, nutrition: list });
  };

  // 保存编辑结果到本地 ocr_cards 库
  const save = () => {
    if (!result) return;
    const card = insertOcrCard({
      imageUri,
      barcode: result.barcode || '',
      productName: result.productName || result.name || '',
      brand: result.brand || '',
      ingredients: result.ingredients || '',
      nutritionJson: JSON.stringify(result.nutrition || []),
      viewFormat: format,
      bg,
      sizeJson: JSON.stringify({ w: 800, h: 800 }),
    });
    setEditing(card);
    refreshCards();
    Alert.alert('已保存主图', `条形码 ${card.barcode || '未填'}，可在主图库找回。`);
    setView('main');
    setResult(null);
    setImageUri('');
  };

  // ============ 主图卡预览（RN 视图，非图片导出）============
  const PreviewCard = ({ c }: { c: OcrCard }) => {
    const nutri: NutritionItem[] = (() => {
      try { return JSON.parse(c.nutritionJson || '[]'); } catch { return []; }
    })();
    const bgColor = c.bg === 'beige' ? '#FAF8F5' : c.bg === 'transparent' ? 'transparent' : '#FFFFFF';
    const showNutrition = c.viewFormat === 'nutrition' || c.viewFormat === 'both';
    const showIngredient = c.viewFormat === 'ingredient' || c.viewFormat === 'both';
    return (
      <View style={[styles.previewCard, { backgroundColor: bgColor }]}>
        {c.imageUri ? (
          <Image source={{ uri: c.imageUri }} style={styles.detailImg} resizeMode="cover" />
        ) : null}
        <Text style={styles.pcName}>{c.productName || '(未命名商品)'}</Text>
        {c.brand ? <Text style={styles.pcBrand}>{c.brand}</Text> : null}
        {showNutrition ? (
          <View style={styles.pcBlock}>
            <Text style={styles.pcBlockTitle}>营养成分表</Text>
            {nutri.map((n, i) => (
              <View key={i} style={styles.pcNutriRow}>
                <Text style={styles.pcNutriName}>{n.name}</Text>
                <Text style={styles.pcNutriVal}>{n.amount}{n.nrv ? `  NRV ${n.nrv}` : ''}</Text>
              </View>
            ))}
          </View>
        ) : null}
        {showIngredient ? (
          <View style={styles.pcBlock}>
            <Text style={styles.pcBlockTitle}>配料表</Text>
            <Text style={styles.pcText}>{c.ingredients}</Text>
          </View>
        ) : null}
        {c.barcode ? <Text style={styles.pcBarcode}>条码 {c.barcode}</Text> : null}
      </View>
    );
  };

  // ============ 主视图：拍照 / 示例 / 主图库列表 ============
  if (view === 'main') {
    return (
      <ScrollView style={styles.root} contentContainerStyle={styles.content}>
        <Text style={styles.hint}>拍照识别商品标签（配料表/营养成分表），自动生成主图并存到本机。</Text>

        <View style={styles.actionRow}>
          <TouchableOpacity style={styles.primaryBtn} onPress={openCamera} disabled={recognizing}>
            <Text style={styles.primaryBtnText}>拍照识别</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.ghostBtn} onPress={useSample} disabled={recognizing}>
            <Text style={styles.ghostBtnText}>使用示例数据</Text>
          </TouchableOpacity>
        </View>
        {recognizing ? (
          <View style={styles.loadingRow}>
            <ActivityIndicator />
            <Text style={styles.hint}>识别中…（走店铺服务器腾讯云 OCR）</Text>
          </View>
        ) : null}

        <Text style={styles.sectionTitle}>我的主图库（{cards.length}）</Text>
        {cards.length === 0 ? (
          <Text style={styles.hint}>还没有主图，拍照识别后会自动入库。</Text>
        ) : (
          cards.map((c) => (
            <View key={c.id} style={styles.cardRow}>
              <TouchableOpacity style={styles.cardRowMain} onPress={() => { setViewing(c); setView('view'); }}>
                <Text style={styles.cardRowTitle}>{c.productName || '(未命名)'}</Text>
                <Text style={styles.cardRowSub}>{c.brand ? c.brand + ' · ' : ''}{c.barcode || '无条码'}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.dangerBtn}
                onPress={() => {
                  deleteOcrCard(c.id);
                  refreshCards();
                }}
              >
                <Text style={styles.dangerBtnText}>删除</Text>
              </TouchableOpacity>
            </View>
          ))
        )}

        {/* 相机 Modal */}
        <Modal visible={camOpen} animationType="slide">
          <View style={[styles.camRoot, { paddingTop: 0 }]}>
            <CameraView ref={camRef} style={styles.camView} facing={camType} />
            <ScanFrame variant="label" title="将商品标签放入框内" subtitle="自动识别 配料表 / 营养成分" />
            <View style={styles.camBar}>
              <TouchableOpacity style={styles.camBtn} onPress={() => setCamOpen(false)}>
                <Text style={styles.camBtnText}>取消</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.camShutter} onPress={snap}>
                <Text style={styles.camShutterText}>拍</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.camBtn} onPress={() => setCamType((t) => (t === 'back' ? 'front' : 'back'))}>
                <Text style={styles.camBtnText}>翻转</Text>
              </TouchableOpacity>
            </View>
          </View>
        </Modal>
      </ScrollView>
    );
  }

  // ============ 编辑视图：可编辑字段 + 主图卡预览 + 保存 ============
  if (view === 'edit' && result) {
    return (
      <ScrollView style={styles.root} contentContainerStyle={styles.content}>
        <Text style={styles.hint}>
          {engine === 'tencent' ? '腾讯云识别完成，请核对并修正。' : engine === 'sample' ? '示例数据，可手动修改。' : '识别完成，请核对并修正。'}
        </Text>

        <Text style={styles.fieldLabel}>商品名称</Text>
        <TextInput style={styles.input} value={result.productName} onChangeText={(t) => updateField({ productName: t, name: t })} />

        <Text style={styles.fieldLabel}>条形码（入库命名）</Text>
        <TextInput style={styles.input} value={result.barcode || ''} onChangeText={(t) => updateField({ barcode: t })} placeholder="如 6921168509256" />

        <Text style={styles.fieldLabel}>品牌</Text>
        <TextInput style={styles.input} value={result.brand || ''} onChangeText={(t) => updateField({ brand: t })} />

        <Text style={styles.fieldLabel}>配料表全文</Text>
        <TextInput style={[styles.input, styles.textArea]} value={result.ingredients} onChangeText={(t) => updateField({ ingredients: t })} multiline numberOfLines={3} />

        <Text style={styles.fieldLabel}>营养成分表</Text>
        {result.nutrition.map((n, i) => (
          <View key={i} style={styles.nutriEditRow}>
            <TextInput style={styles.nutriNameInput} value={n.name} onChangeText={(t) => updateNutrition(i, { name: t })} placeholder="项目" />
            <TextInput style={styles.nutriValInput} value={n.amount} onChangeText={(t) => updateNutrition(i, { amount: t })} placeholder="含量" />
            <TextInput style={styles.nutriValInput} value={n.nrv || ''} onChangeText={(t) => updateNutrition(i, { nrv: t })} placeholder="NRV%" />
          </View>
        ))}
        <TouchableOpacity style={styles.addRowBtn} onPress={() => updateField({ nutrition: [...result.nutrition, { name: '', amount: '' }] })}>
          <Text style={styles.addRowBtnText}>+ 添加营养成分</Text>
        </TouchableOpacity>

        <Text style={styles.fieldLabel}>主图格式</Text>
        <View style={styles.segRow}>
          {(['nutrition', 'ingredient', 'both'] as ExportFormat[]).map((f) => (
            <TouchableOpacity key={f} style={[styles.segBtn, format === f && styles.segBtnActive]} onPress={() => setFormat(f)}>
              <Text style={[styles.segBtnText, format === f && styles.segBtnTextActive]}>
                {f === 'nutrition' ? '营养' : f === 'ingredient' ? '配料' : '双栏'}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        <Text style={styles.fieldLabel}>主图背景</Text>
        <View style={styles.segRow}>
          {(['white', 'beige', 'transparent'] as BgType[]).map((b) => (
            <TouchableOpacity key={b} style={[styles.segBtn, bg === b && styles.segBtnActive]} onPress={() => setBg(b)}>
              <Text style={[styles.segBtnText, bg === b && styles.segBtnTextActive]}>
                {b === 'white' ? '白底' : b === 'beige' ? '米色' : '透明'}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        <Text style={styles.sectionTitle}>主图预览</Text>
        <PreviewCard c={{
          id: -1, imageUri, barcode: result.barcode || '', productName: result.productName,
          brand: result.brand || '', ingredients: result.ingredients,
          nutritionJson: JSON.stringify(result.nutrition), viewFormat: format, bg, sizeJson: '{}', createdAt: 0,
        }} />

        <View style={styles.actionRow}>
          <TouchableOpacity style={styles.primaryBtn} onPress={save}>
            <Text style={styles.primaryBtnText}>保存到主图库</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.ghostBtn} onPress={() => { setView('main'); setResult(null); }}>
            <Text style={styles.ghostBtnText}>取消</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    );
  }

  // ============ 详情视图 ============
  if (view === 'view' && viewing) {
    return (
      <ScrollView style={styles.root} contentContainerStyle={styles.content}>
        <PreviewCard c={viewing} />
        <TouchableOpacity style={styles.ghostBtn} onPress={() => { setViewing(null); setView('main'); }}>
          <Text style={styles.ghostBtnText}>返回主图库</Text>
        </TouchableOpacity>
      </ScrollView>
    );
  }

  return null;
}

function makeStyles(theme: any) {
  const S = theme.size;
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: theme.color.bgApp },
    content: { padding: theme.spaceScale[4], paddingBottom: 32 },
    hint: { fontSize: theme.font.sizeV4.caption, color: theme.color.textAppTertiary, lineHeight: 18, marginBottom: theme.spaceScale[3] },
    sectionTitle: { fontSize: theme.font.sizeV4.h4, fontWeight: theme.font.weight.semibold, color: theme.color.textApp, marginTop: theme.spaceScale[4], marginBottom: theme.spaceScale[3] },
    fieldLabel: { fontSize: theme.font.sizeV4.caption, color: theme.color.textAppSecondary, marginBottom: theme.spaceScale[2], marginTop: theme.spaceScale[3] },
    input: {
      backgroundColor: theme.color.surfaceSunken, borderWidth: 1, borderColor: theme.color.borderApp,
      borderRadius: theme.radius.md, height: S.controlLg, paddingHorizontal: theme.spaceScale[4],
      color: theme.color.textApp, fontSize: theme.font.sizeV4.body,
    },
    textArea: { height: 72, paddingTop: theme.spaceScale[3], textAlignVertical: 'top' },
    actionRow: { flexDirection: 'row', gap: theme.spaceScale[3], marginTop: theme.spaceScale[2] },
    primaryBtn: { flex: 1, backgroundColor: theme.color.primaryVivid, borderRadius: theme.radius.md, height: S.controlLg, alignItems: 'center', justifyContent: 'center' },
    primaryBtnText: { color: '#fff', fontSize: theme.font.sizeV4.body, fontWeight: theme.font.weight.medium },
    ghostBtn: { flex: 1, borderWidth: 1, borderColor: theme.color.borderApp, borderRadius: theme.radius.md, height: S.controlLg, alignItems: 'center', justifyContent: 'center' },
    ghostBtnText: { color: theme.color.textAppSecondary, fontSize: theme.font.sizeV4.body },
    loadingRow: { flexDirection: 'row', alignItems: 'center', gap: theme.spaceScale[2], marginTop: theme.spaceScale[3] },
    cardRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: theme.color.surfaceApp, borderRadius: theme.radius.md, padding: theme.spaceScale[3], marginBottom: theme.spaceScale[2] },
    cardRowMain: { flex: 1 },
    cardRowTitle: { fontSize: theme.font.sizeV4.body, color: theme.color.textApp, fontWeight: theme.font.weight.medium },
    cardRowSub: { fontSize: theme.font.sizeV4.caption, color: theme.color.textAppTertiary, marginTop: 2 },
    dangerBtn: { paddingVertical: 6, paddingHorizontal: 12, borderRadius: theme.radius.md, backgroundColor: theme.color.dangerSoft },
    dangerBtnText: { color: theme.color.danger, fontSize: theme.font.sizeV4.caption },
    nutriEditRow: { flexDirection: 'row', gap: theme.spaceScale[2], marginBottom: theme.spaceScale[2] },
    nutriNameInput: { flex: 2, backgroundColor: theme.color.surfaceSunken, borderWidth: 1, borderColor: theme.color.borderApp, borderRadius: theme.radius.md, height: 40, paddingHorizontal: theme.spaceScale[3], color: theme.color.textApp, fontSize: theme.font.sizeV4.body },
    nutriValInput: { flex: 1, backgroundColor: theme.color.surfaceSunken, borderWidth: 1, borderColor: theme.color.borderApp, borderRadius: theme.radius.md, height: 40, paddingHorizontal: theme.spaceScale[2], color: theme.color.textApp, fontSize: theme.font.sizeV4.body },
    addRowBtn: { alignSelf: 'flex-start', marginTop: theme.spaceScale[2], paddingVertical: 6, paddingHorizontal: 12, borderRadius: theme.radius.md, borderWidth: 1, borderStyle: 'dashed', borderColor: theme.color.borderApp },
    addRowBtnText: { color: theme.color.primaryVivid, fontSize: theme.font.sizeV4.caption },
    segRow: { flexDirection: 'row', gap: theme.spaceScale[2], marginTop: theme.spaceScale[2] },
    segBtn: { flex: 1, borderWidth: 1, borderColor: theme.color.borderApp, borderRadius: theme.radius.md, height: 40, alignItems: 'center', justifyContent: 'center' },
    segBtnActive: { backgroundColor: theme.color.primarySoft, borderColor: theme.color.primaryVivid },
    segBtnText: { color: theme.color.textAppSecondary, fontSize: theme.font.sizeV4.body },
    segBtnTextActive: { color: theme.color.primaryVivid, fontWeight: theme.font.weight.medium },
    // 主图卡
    previewCard: { borderRadius: theme.radius.lg, padding: theme.spaceScale[4], borderWidth: 1, borderColor: theme.color.borderApp, marginTop: theme.spaceScale[2] },
    detailImg: { width: '100%', height: 160, borderRadius: theme.radius.md, marginBottom: theme.spaceScale[3] },
    pcName: { fontSize: theme.font.sizeV4.h3, fontWeight: theme.font.weight.bold, color: '#1a1a1a', textAlign: 'center' },
    pcBrand: { fontSize: theme.font.sizeV4.body, color: '#666', textAlign: 'center', marginTop: 4 },
    pcBlock: { marginTop: theme.spaceScale[3], borderTopWidth: 1, borderTopColor: '#000', paddingTop: theme.spaceScale[2] },
    pcBlockTitle: { fontSize: theme.font.sizeV4.bodySm, fontWeight: theme.font.weight.bold, color: '#1a1a1a', textAlign: 'center', marginBottom: 6 },
    pcText: { fontSize: theme.font.sizeV4.bodySm, color: '#333', lineHeight: 20 },
    pcNutriRow: { flexDirection: 'row', justifyContent: 'space-between', borderBottomWidth: 1, borderBottomColor: '#000', paddingVertical: 4 },
    pcNutriName: { fontSize: theme.font.sizeV4.bodySm, color: '#1a1a1a' },
    pcNutriVal: { fontSize: theme.font.sizeV4.bodySm, color: '#1a1a1a' },
    pcBarcode: { fontSize: theme.font.sizeV4.caption, color: '#666', textAlign: 'center', marginTop: theme.spaceScale[2] },
    // 相机
    camRoot: { flex: 1, backgroundColor: '#000' },
    camView: { flex: 1 },
    camBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: theme.spaceScale[4], paddingBottom: theme.spaceScale[6] },
    camBtn: { padding: theme.spaceScale[2] },
    camBtnText: { color: '#fff', fontSize: theme.font.sizeV4.body },
    camShutter: { width: 68, height: 68, borderRadius: 34, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center' },
    camShutterText: { color: '#000', fontSize: 18, fontWeight: theme.font.weight.bold },
  });
}
