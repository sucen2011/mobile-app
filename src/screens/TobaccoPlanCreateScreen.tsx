/**
 * 烟草方案新增（移动端）
 * 流程：拍照/相册 → 调后端 /api/ocr/scan → parseTobaccoPlan → 表单填好 → 调 /api/tobacco/plans 保存
 * 数据真相在后端（3001），本屏只做「拍照 + 解析 + 表单 + 提交」的薄壳。
 */
import React, { useEffect, useRef, useState } from 'react';
import {
  StyleSheet, View, Text, TextInput, TouchableOpacity, ScrollView, Alert,
  Modal, ActivityIndicator, Image, Platform,
} from 'react-native';
import { CameraView, useCameraPermissions, type CameraType } from 'expo-camera';
import * as ImagePicker from 'expo-image-picker';
import { useTheme } from '../theme/ThemeProvider';
import ScanFrame from '../components/ScanFrame';
import { apiFetch } from '../api/client';
import { parseTobaccoPlan, nextPlanNo, type ParsedTobaccoPlan } from '../utils/parseTobaccoPlan';

interface Props {
  baseUrl: string;
  onBack: () => void;
  onSaved?: (id: number) => void;
}

interface PlanItemDraft {
  cigarette_name: string;
  qty: string;
  unit_cost: string;
  item_type: 'order' | 'gift';
}

export default function TobaccoPlanCreateScreen({ baseUrl, onBack, onSaved }: Props) {
  const { theme } = useTheme();
  const styles = makeStyles(theme);

  // 表单字段
  const [planNo, setPlanNo] = useState('');
  const [name, setName] = useState('');
  const [period, setPeriod] = useState(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  });
  const [groupName, setGroupName] = useState('');
  const [rewardPolicy, setRewardPolicy] = useState('');
  const [rewardType, setRewardType] = useState<'none' | 'direct' | 'weekly'>('none');
  const [items, setItems] = useState<PlanItemDraft[]>([]);

  const [submitting, setSubmitting] = useState(false);

  // 相机/OCR
  const [camOpen, setCamOpen] = useState(false);
  const [camType, setCamType] = useState<CameraType>('back');
  const [permission, requestPermission] = useCameraPermissions();
  const camRef = useRef<any>(null);
  const [recognizing, setRecognizing] = useState(false);
  const [parsedHint, setParsedHint] = useState<string>('');

  useEffect(() => { if (!planNo) setPlanNo(nextPlanNo()); }, []);

  // ====== OCR 调用 ======
  const recognizeFromDataUrl = async (dataUrl: string) => {
    const full = /^https?:\/\//.test(baseUrl) ? baseUrl.replace(/\/+$/, '') : `http://${baseUrl.replace(/\/+$/, '')}`;
    setRecognizing(true);
    setParsedHint('识别中…');
    try {
      const res = await apiFetch(`${full}/api/ocr/scan`, {
        method: 'POST',
        body: JSON.stringify({ data: dataUrl }),
      });
      if (!res.ok) {
        const reason =
          res.status === 401 ? '未连接店铺服务器或鉴权失败：请在「系统设置」检查店铺地址与 API Token。'
          : res.status === 503 ? '数据库启动中，请稍候重试。'
          : `识别请求被拒绝（HTTP ${res.status}），请确认 3001 后端在线。`;
        Alert.alert('识别请求失败', reason);
        setParsedHint('');
        return;
      }
      if (res.json && res.json.code && res.json.code !== 0) {
        Alert.alert('识别失败', res.json.msg || '服务端识别异常');
        setParsedHint('');
        return;
      }
      const text = (res.json && res.json.data && res.json.data.text) || '';
      const eng = (res.json && res.json.data && res.json.data.engine) || 'unknown';
      if (!text) {
        Alert.alert('未识别到文字', '请重拍：保证对焦清晰、四边对齐、文字可读。');
        setParsedHint('');
        return;
      }
      const parsed = parseTobaccoPlan(text);
      applyParsed(parsed, eng);
    } catch (e: any) {
      Alert.alert('识别失败', e?.message || '网络异常，请确认 3001 后端在线');
      setParsedHint('');
    } finally {
      setRecognizing(false);
    }
  };

  const applyParsed = (p: ParsedTobaccoPlan, engine: string) => {
    setPlanNo((cur) => cur || p.plan_no);
    setName((cur) => cur || p.name);
    setPeriod((cur) => cur || p.period);
    setGroupName((cur) => cur || p.group_name);
    setRewardPolicy((cur) => cur || p.reward_policy);
    setRewardType((cur) => cur !== 'none' ? cur : p.tiers[0]?.reward_type || 'none');

    // 所有 tier 的 items 合并成单层（移动端只展示一个档位，避免 UI 复杂度）
    const flat = p.tiers.flatMap((t) => t.items.map((it) => ({
      cigarette_name: it.cigarette_name,
      qty: String(it.qty),
      unit_cost: it.unit_cost != null ? String(it.unit_cost) : '',
      item_type: it.item_type,
    })));
    if (flat.length > 0) setItems(flat);

    const totalItems = flat.length;
    const warns = p.warnings.length;
    setParsedHint(`✓ 识别完成（引擎 ${engine}，${totalItems} 条明细${warns ? `，${warns} 条警告` : ''}）。请核对后保存。`);
  };

  // ====== 拍照 ======
  const openCamera = async () => {
    if (!permission?.granted) {
      const r = await requestPermission();
      if (!r.granted) { Alert.alert('需要相机权限才能拍照识别'); return; }
    }
    setCamOpen(true);
  };
  const snap = async () => {
    try {
      const photo = await camRef.current?.takePictureAsync({ base64: true, quality: 0.8, skipProcessing: false });
      setCamOpen(false);
      if (!photo?.base64) { Alert.alert('拍照失败', '未能获取照片'); return; }
      await recognizeFromDataUrl(`data:image/jpeg;base64,${photo.base64}`);
    } catch (e: any) {
      setCamOpen(false);
      Alert.alert('拍照失败', e?.message || '');
    }
  };

  // ====== 相册 ======
  const pickFromAlbum = async () => {
    try {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) { Alert.alert('需要相册权限'); return; }
      const r = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ImagePicker.MediaTypeOptions.Images, base64: true, quality: 0.85 });
      if (r.canceled || !r.assets?.[0]?.base64) return;
      await recognizeFromDataUrl(`data:image/jpeg;base64,${r.assets[0].base64}`);
    } catch (e: any) {
      Alert.alert('选择图片失败', e?.message || '');
    }
  };

  // ====== 保存到后端 ======
  const save = async () => {
    if (!name.trim()) { Alert.alert('请填写方案名'); return; }
    if (!planNo.trim()) { Alert.alert('请填写方案编号'); return; }
    if (items.length === 0) { Alert.alert('请至少添加一条卷烟明细'); return; }
    const full = /^https?:\/\//.test(baseUrl) ? baseUrl.replace(/\/+$/, '') : `http://${baseUrl.replace(/\/+$/, '')}`;
    const body = {
      plan_no: planNo.trim(),
      name: name.trim(),
      period: period.trim(),
      group_name: groupName.trim() || undefined,
      reward_policy: rewardPolicy.trim() || undefined,
      tiers: [
        {
          tier_no: 'base',
          name: '基础档',
          threshold_qty: null,
          selection_type: 'fixed',
          reward_type: rewardType,
          items: items
            .filter((it) => it.cigarette_name.trim())
            .map((it) => ({
              cigarette_name: it.cigarette_name.trim(),  // 后端按名称自动匹配或创建卷烟档案
              item_type: it.item_type,
              qty: Number(it.qty) || 0,
              unit_cost: Number(it.unit_cost) || 0,
            })),
        },
      ],
    };
    setSubmitting(true);
    try {
      const res = await apiFetch(`${full}/api/tobacco/plans/import`, {
        method: 'POST',
        body: JSON.stringify({ plans: [body] }),
      });
      if (!res.ok) {
        Alert.alert('保存失败', `HTTP ${res.status}`);
        return;
      }
      const j = res.json || {};
      if (j.code !== 0) {
        Alert.alert('保存失败', j.msg || '服务端错误');
        return;
      }
      const ids = (j.data && j.data.ids) || [];
      const newId = ids[0];
      Alert.alert('已保存', `方案 id=${newId} 已新增到服务器。`, [
        { text: '好的', onPress: () => { onSaved?.(newId); onBack(); } },
      ]);
    } catch (e: any) {
      Alert.alert('保存失败', e?.message || '网络异常');
    } finally {
      setSubmitting(false);
    }
  };

  const updateItem = (idx: number, patch: Partial<PlanItemDraft>) => {
    setItems((arr) => arr.map((it, i) => (i === idx ? { ...it, ...patch } : it)));
  };
  const removeItem = (idx: number) => setItems((arr) => arr.filter((_, i) => i !== idx));
  const addBlankItem = () => setItems((arr) => [...arr, { cigarette_name: '', qty: '1', unit_cost: '', item_type: 'order' }]);

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <TouchableOpacity onPress={onBack} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <Text style={styles.back}>‹ 返回</Text>
        </TouchableOpacity>
        <Text style={styles.title}>新增烟草方案</Text>
        <View style={{ width: 50 }} />
      </View>

      <ScrollView style={styles.body} contentContainerStyle={styles.content}>
        <View style={styles.card}>
          <View style={styles.actionRow}>
            <TouchableOpacity style={styles.primaryBtn} onPress={openCamera} disabled={recognizing}>
              <Text style={styles.primaryBtnText}>📷 拍照识别</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.ghostBtn} onPress={pickFromAlbum} disabled={recognizing}>
              <Text style={styles.ghostBtnText}>🖼 相册选取</Text>
            </TouchableOpacity>
          </View>
          {recognizing ? (
            <View style={styles.loadingRow}>
              <ActivityIndicator />
              <Text style={styles.hint}>调用 3001 后端腾讯云 OCR…</Text>
            </View>
          ) : null}
          {parsedHint ? <Text style={styles.parseHint}>{parsedHint}</Text> : null}
        </View>

        <View style={styles.card}>
          <Text style={styles.fieldLabel}>方案编号</Text>
          <TextInput style={styles.input} value={planNo} onChangeText={setPlanNo} placeholder="如 P1" autoCapitalize="characters" />

          <Text style={styles.fieldLabel}>方案名</Text>
          <TextInput style={styles.input} value={name} onChangeText={setName} placeholder="如 9月订烟方案" />

          <View style={styles.row2}>
            <View style={styles.col}>
              <Text style={styles.fieldLabel}>期次</Text>
              <TextInput style={styles.input} value={period} onChangeText={setPeriod} placeholder="2026-09" />
            </View>
            <View style={styles.col}>
              <Text style={styles.fieldLabel}>方案组</Text>
              <TextInput style={styles.input} value={groupName} onChangeText={setGroupName} placeholder="选填" />
            </View>
          </View>

          <Text style={styles.fieldLabel}>奖励类型</Text>
          <View style={styles.segRow}>
            {(['none', 'direct', 'weekly'] as const).map((r) => (
              <TouchableOpacity key={r} style={[styles.segBtn, rewardType === r && styles.segBtnActive]} onPress={() => setRewardType(r)}>
                <Text style={[styles.segBtnText, rewardType === r && styles.segBtnTextActive]}>
                  {r === 'none' ? '无奖励' : r === 'direct' ? '直接奖励' : '分周兑现'}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          <Text style={styles.fieldLabel}>奖励策略（自由文本）</Text>
          <TextInput style={[styles.input, styles.area]} value={rewardPolicy} onChangeText={setRewardPolicy} placeholder="选填，如 达到60条奖10%" multiline />
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>卷烟明细（{items.length}）</Text>
          {items.length === 0 ? (
            <Text style={styles.hint}>还没有明细，点下面「+ 添加卷烟」手动补，或先拍照/相册识别。</Text>
          ) : items.map((it, i) => (
            <View key={i} style={styles.itemRow}>
              <TextInput style={[styles.input, styles.itemName]} value={it.cigarette_name} onChangeText={(t) => updateItem(i, { cigarette_name: t })} placeholder="卷烟名" />
              <TextInput style={[styles.input, styles.itemNum]} value={it.qty} onChangeText={(t) => updateItem(i, { qty: t })} placeholder="数量" keyboardType="numeric" />
              <TextInput style={[styles.input, styles.itemNum]} value={it.unit_cost} onChangeText={(t) => updateItem(i, { unit_cost: t })} placeholder="进价" keyboardType="numeric" />
              <TouchableOpacity onPress={() => updateItem(i, { item_type: it.item_type === 'order' ? 'gift' : 'order' })}>
                <View style={[styles.tag, it.item_type === 'gift' ? styles.tagGift : styles.tagOrder]}>
                  <Text style={styles.tagText}>{it.item_type === 'gift' ? '奖励' : '主订'}</Text>
                </View>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => removeItem(i)}>
                <Text style={styles.removeBtn}>×</Text>
              </TouchableOpacity>
            </View>
          ))}
          <TouchableOpacity onPress={addBlankItem} style={styles.addItemBtn}>
            <Text style={styles.addItemBtnText}>+ 添加卷烟</Text>
          </TouchableOpacity>
        </View>

        <TouchableOpacity style={[styles.saveBtn, submitting && { opacity: 0.6 }]} onPress={save} disabled={submitting}>
          <Text style={styles.saveBtnText}>{submitting ? '保存中…' : '保存到服务器'}</Text>
        </TouchableOpacity>
      </ScrollView>

      {/* 相机 Modal：竖幅取景框（自适应屏幕尺寸），单据对齐 */}
      <Modal visible={camOpen} animationType="slide" onRequestClose={() => setCamOpen(false)}>
        <View style={styles.camRoot}>
          <CameraView ref={camRef} style={styles.camView} facing={camType} />
          <ScanFrame variant="sheet" title="将方案表放入框内，对齐边缘" subtitle="自动识别 方案名/期次/卷烟与数量/奖励规则" />
          <View style={styles.camBar}>
            <TouchableOpacity onPress={() => setCamOpen(false)}>
              <Text style={styles.camBtnText}>关闭</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={snap} disabled={recognizing}>
              <Text style={styles.camShoot}>● 拍摄</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => setCamType((t) => (t === 'back' ? 'front' : 'back'))}>
              <Text style={styles.camBtnText}>翻转</Text>
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
  const S = theme.size;
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: theme.color.bgApp },
    header: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
      paddingHorizontal: theme.spaceScale?.[4] || 16, paddingTop: Platform.OS === 'ios' ? 50 : 12,
      paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: theme.color.border,
    },
    back: { color: theme.color.primaryVivid, fontSize: 16, minWidth: 50 },
    title: { fontSize: 17, fontWeight: '600', color: theme.color.textApp },
    body: { flex: 1 },
    content: { padding: 12, paddingBottom: 32 },
    card: {
      backgroundColor: theme.color.surfaceApp, borderRadius: 12, padding: 12, marginBottom: 12,
      borderWidth: 1, borderColor: theme.color.border,
    },
    cardTitle: { fontSize: 15, fontWeight: '600', color: theme.color.textApp, marginBottom: 8 },
    actionRow: { flexDirection: 'row', gap: 8 },
    primaryBtn: { flex: 1, backgroundColor: theme.color.primaryVivid, borderRadius: 8, height: S.controlLg, alignItems: 'center', justifyContent: 'center' },
    primaryBtnText: { color: '#fff', fontSize: 15, fontWeight: '600' },
    ghostBtn: { flex: 1, borderWidth: 1, borderColor: theme.color.border, borderRadius: 8, height: S.controlLg, alignItems: 'center', justifyContent: 'center' },
    ghostBtnText: { color: theme.color.textAppSecondary, fontSize: 15 },
    loadingRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8 },
    hint: { fontSize: 13, color: theme.color.textAppTertiary, lineHeight: 18 },
    parseHint: { fontSize: 13, color: theme.color.success, marginTop: 8, lineHeight: 18 },
    fieldLabel: { fontSize: 13, color: theme.color.textAppSecondary, marginTop: 8, marginBottom: 4 },
    input: {
      backgroundColor: theme.color.surfaceSunken, borderWidth: 1, borderColor: theme.color.border,
      borderRadius: 8, height: 40, paddingHorizontal: 10, color: theme.color.textApp, fontSize: 15,
    },
    area: { height: 64, paddingTop: 8, textAlignVertical: 'top' },
    row2: { flexDirection: 'row', gap: 8 },
    col: { flex: 1 },
    segRow: { flexDirection: 'row', gap: 8, marginTop: 4 },
    segBtn: { flex: 1, borderWidth: 1, borderColor: theme.color.border, borderRadius: 8, height: 36, alignItems: 'center', justifyContent: 'center' },
    segBtnActive: { backgroundColor: theme.color.primarySoft, borderColor: theme.color.primaryVivid },
    segBtnText: { color: theme.color.textAppSecondary, fontSize: 13 },
    segBtnTextActive: { color: theme.color.primaryVivid, fontWeight: '600' },
    itemRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 6 },
    itemName: { flex: 3 },
    itemNum: { flex: 1, textAlign: 'right' },
    tag: { paddingVertical: 6, paddingHorizontal: 8, borderRadius: 6 },
    tagOrder: { backgroundColor: '#e6f4ff' },
    tagGift: { backgroundColor: '#fff7e6' },
    tagText: { fontSize: 12, color: '#333' },
    removeBtn: { color: theme.color.danger, fontSize: 24, paddingHorizontal: 6 },
    addItemBtn: { marginTop: 8, paddingVertical: 8, borderRadius: 8, borderWidth: 1, borderStyle: 'dashed', borderColor: theme.color.border, alignItems: 'center' },
    addItemBtnText: { color: theme.color.primaryVivid, fontSize: 13 },
    saveBtn: { backgroundColor: theme.color.primaryVivid, borderRadius: 12, height: 48, alignItems: 'center', justifyContent: 'center', marginTop: 8 },
    saveBtnText: { color: '#fff', fontSize: 16, fontWeight: '600' },
    // 相机
    camRoot: { flex: 1, backgroundColor: '#000' },
    camView: { flex: 1 },
    camBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 16, paddingBottom: 36 },
    camBtnText: { color: '#fff', fontSize: 15 },
    camShoot: { color: '#fff', fontSize: 18, fontWeight: '700' },
    camLoading: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.4)' },
  });
}
