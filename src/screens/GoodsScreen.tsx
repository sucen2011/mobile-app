import React, { useEffect, useMemo, useState } from 'react';
import {
  View, Text, ScrollView, StyleSheet, TouchableOpacity, Alert, TextInput, RefreshControl,
} from 'react-native';
import { useTheme } from '../theme/ThemeProvider';
import { SafeAreaHeader } from '../components/SafeArea';
import { SyncBadge } from '../components/SyncUI';
import type { SyncState } from '../nav';
import {
  listCategories, createCategory, deleteCategory,
  listSuppliers, createSupplier, deleteSupplier,
  listProducts, createProduct, deleteProduct,
  listLowStockProducts,
  type Category, type Supplier, type Product,
} from '../db/localDb';

interface Props { sync: SyncState; cacheVersion: number; }
type ViewKey = 'main' | 'category' | 'supplier' | 'archive' | 'warning';

const VIEW_TITLES: Record<Exclude<ViewKey, 'main'>, string> = {
  category: '商品分类',
  supplier: '供应商管理',
  archive: '商品档案',
  warning: '库存预警',
};

export default function GoodsScreen({ sync, cacheVersion }: Props) {
  const { theme } = useTheme();
  const styles = makeStyles(theme);
  const [view, setView] = useState<ViewKey>('main');
  const [tick, setTick] = useState(0);
  const refresh = () => setTick((t) => t + 1);
  // 下行同步（PC→手机）完成后自动刷新本屏，无需用户手动下拉：
  // 用 useEffect 监听 cacheVersion（不重挂载，避免此前"分区自动跳出"bug 复发）。
  useEffect(() => { refresh(); }, [cacheVersion]);

  if (view === 'main') {
    return (
      <ScrollView style={styles.root} contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={false} onRefresh={refresh} />}>
        <View style={styles.topRow}>
          <Text style={styles.title}>商品</Text>
          <SyncBadge state={sync} />
        </View>

        <View style={styles.card}>
          <MenuRow label="商品分类" note="维护分类层级" onPress={() => setView('category')} />
          <MenuRow label="供应商管理" note="建议在电脑端维护主数据" onPress={() => setView('supplier')} />
          <MenuRow label="商品档案" note="商品主数据与价格" onPress={() => setView('archive')} />
          <MenuRow label="库存预警" note="低库存提醒" onPress={() => setView('warning')} />
        </View>

        <Text style={styles.hint}>商品 / 供应商主数据请优先在电脑端维护，手机端聚焦快捷录入与查询。所有数据落本地 SQLite，离线可用。</Text>
      </ScrollView>
    );
  }

  const back = () => { setView('main'); refresh(); };
  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={false} onRefresh={refresh} />}>
      <SafeAreaHeader style={styles.subHeader}>
        <TouchableOpacity
          style={styles.subBackBtn}
          onPress={back}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          accessibilityRole="button"
        >
          <Text style={styles.subBackText}>‹ 商品</Text>
        </TouchableOpacity>
        <Text style={styles.subTitle}>{VIEW_TITLES[view]}</Text>
        <View style={styles.subSpacer} />
      </SafeAreaHeader>
      <View style={{ marginTop: theme.spaceScale[3] }}>
        {view === 'category' && <CategoryList tick={tick} onChanged={refresh} />}
        {view === 'supplier' && <SupplierList tick={tick} onChanged={refresh} />}
        {view === 'archive' && <ProductList tick={tick} onChanged={refresh} />}
        {view === 'warning' && <WarningList tick={tick} />}
      </View>
    </ScrollView>
  );
}

// ============ 菜单行 ============
function MenuRow({ label, note, onPress }: { label: string; note: string; onPress: () => void }) {
  const { theme } = useTheme();
  const styles = makeStyles(theme);
  return (
    <TouchableOpacity style={styles.menuRow} onPress={onPress}>
      <View style={{ flex: 1 }}>
        <Text style={styles.menuLabel}>{label}</Text>
        <Text style={styles.menuSub}>{note}</Text>
      </View>
      <Text style={styles.arrow}>›</Text>
    </TouchableOpacity>
  );
}

// ============ 分类管理 ============
function CategoryList({ tick, onChanged }: { tick: number; onChanged: () => void }) {
  const { theme } = useTheme();
  const styles = makeStyles(theme);
  const [list, setList] = useState<Category[]>(() => listCategories());
  const [name, setName] = useState('');
  React.useEffect(() => { setList(listCategories()); }, [tick]);

  const submit = () => {
    try {
      createCategory(name);
      setName('');
      setList(listCategories());
      onChanged();
    } catch (e: any) { Alert.alert('新增分类', e?.message || String(e)); }
  };
  const remove = (c: Category) => {
    Alert.alert('删除分类', `确认删除「${c.name}」？`, [
      { text: '取消', style: 'cancel' },
      { text: '删除', style: 'destructive', onPress: () => {
        try { deleteCategory(c.id); setList(listCategories()); onChanged(); }
        catch (e: any) { Alert.alert('删除失败', e?.message || String(e)); }
      } },
    ]);
  };

  return (
    <View>
      <View style={styles.card}>
        <Text style={styles.sectionTitle}>新增分类</Text>
        <View style={styles.inlineForm}>
          <TextInput style={[styles.input, { flex: 1 }]} value={name} onChangeText={setName} placeholder="如：水饮" placeholderTextColor={theme.color.textAppTertiary} />
          <TouchableOpacity style={styles.addBtn} onPress={submit}><Text style={styles.addBtnText}>添加</Text></TouchableOpacity>
        </View>
      </View>

      <Text style={styles.sectionTitle}>分类列表（{list.length}）</Text>
      {list.length === 0
        ? <View style={styles.empty}><Text style={styles.emptyText}>暂无分类</Text></View>
        : (
          <View style={styles.card}>
            {list.map((c, i) => (
              <View key={c.id} style={[styles.listRow, i > 0 && { borderTopWidth: 1, borderTopColor: theme.color.dividerApp }]}>
                <Text style={styles.listLabel}>{c.name}</Text>
                <TouchableOpacity onPress={() => remove(c)}><Text style={styles.delText}>删除</Text></TouchableOpacity>
              </View>
            ))}
          </View>
        )
      }
    </View>
  );
}

// ============ 供应商管理 ============
function SupplierList({ tick, onChanged }: { tick: number; onChanged: () => void }) {
  const { theme } = useTheme();
  const styles = makeStyles(theme);
  const [list, setList] = useState<Supplier[]>(() => listSuppliers());
  const [name, setName] = useState('');
  const [contact, setContact] = useState('');
  const [phone, setPhone] = useState('');
  React.useEffect(() => { setList(listSuppliers()); }, [tick]);

  const submit = () => {
    try {
      createSupplier({ name, contact, phone, address: '', note: '' });
      setName(''); setContact(''); setPhone('');
      setList(listSuppliers());
      onChanged();
    } catch (e: any) { Alert.alert('新增供应商', e?.message || String(e)); }
  };
  const remove = (s: Supplier) => {
    Alert.alert('删除供应商', `确认删除「${s.name}」？`, [
      { text: '取消', style: 'cancel' },
      { text: '删除', style: 'destructive', onPress: () => { deleteSupplier(s.id); setList(listSuppliers()); onChanged(); } },
    ]);
  };

  return (
    <View>
      <View style={styles.card}>
        <Text style={styles.sectionTitle}>新增供应商</Text>
        <FieldLabel>名称 *</FieldLabel>
        <TextInput style={styles.input} value={name} onChangeText={setName} placeholder="如：娃哈哈直营" placeholderTextColor={theme.color.textAppTertiary} />
        <FieldLabel>联系人</FieldLabel>
        <TextInput style={styles.input} value={contact} onChangeText={setContact} placeholder="选填" placeholderTextColor={theme.color.textAppTertiary} />
        <FieldLabel>联系电话</FieldLabel>
        <TextInput style={styles.input} value={phone} onChangeText={setPhone} placeholder="选填" placeholderTextColor={theme.color.textAppTertiary} keyboardType="phone-pad" />
        <TouchableOpacity style={styles.addBtn} onPress={submit}><Text style={styles.addBtnText}>添加供应商</Text></TouchableOpacity>
      </View>

      <Text style={styles.sectionTitle}>供应商列表（{list.length}）</Text>
      {list.length === 0
        ? <View style={styles.empty}><Text style={styles.emptyText}>暂无供应商</Text></View>
        : (
          <View style={styles.card}>
            {list.map((s, i) => (
              <View key={s.id} style={[styles.listRow, { alignItems: 'flex-start' }, i > 0 && { borderTopWidth: 1, borderTopColor: theme.color.dividerApp }]}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.listLabel}>{s.name}</Text>
                  <Text style={styles.listSub}>
                    {[s.contact, s.phone].filter(Boolean).join(' · ') || '无联系方式'}
                  </Text>
                </View>
                <TouchableOpacity onPress={() => remove(s)}><Text style={styles.delText}>删除</Text></TouchableOpacity>
              </View>
            ))}
          </View>
        )
      }
    </View>
  );
}

// ============ 商品档案 ============
function ProductList({ tick, onChanged }: { tick: number; onChanged: () => void }) {
  const { theme } = useTheme();
  const styles = makeStyles(theme);
  const [list, setList] = useState<Product[]>(() => listProducts());
  const categories = useMemo(() => listCategories(), [tick]);
  const suppliers = useMemo(() => listSuppliers(), [tick]);

  const [name, setName] = useState('');
  const [spec, setSpec] = useState('');
  const [unit, setUnit] = useState('');
  const [categoryName, setCategoryName] = useState('');
  const [brand, setBrand] = useState('');
  const [supplierName, setSupplierName] = useState('');
  const [purchasePrice, setPurchasePrice] = useState(0);
  const [retailPrice, setRetailPrice] = useState(0);
  const [stockQty, setStockQty] = useState(0);
  const [safetyStock, setSafetyStock] = useState(0);
  const [shelfLifeDays, setShelfLifeDays] = useState(0);
  const [note, setNote] = useState('');
  const [adding, setAdding] = useState(false); // 商品档案默认展示列表，新增表单收起

  React.useEffect(() => { setList(listProducts()); }, [tick]);

  const pickCategory = () => {
    if (categories.length === 0) { Alert.alert('选择分类', '暂无分类，请先在「商品分类」中添加'); return; }
    Alert.alert('选择分类', undefined, [
      ...categories.map((c) => ({ text: c.name, onPress: () => setCategoryName(c.name) })),
      { text: '不选', onPress: () => setCategoryName('') },
      { text: '取消', onPress: () => undefined, style: 'cancel' as const },
    ]);
  };
  const pickSupplier = () => {
    if (suppliers.length === 0) { Alert.alert('选择供应商', '暂无供应商，请先在「供应商管理」中添加'); return; }
    Alert.alert('选择供应商', undefined, [
      ...suppliers.map((s) => ({ text: s.name, onPress: () => setSupplierName(s.name) })),
      { text: '不选', onPress: () => setSupplierName('') },
      { text: '取消', onPress: () => undefined, style: 'cancel' as const },
    ]);
  };

  const submit = () => {
    try {
      createProduct({
        name, spec, unit, categoryName, brand, supplierName,
        purchasePrice, retailPrice, stockQty, safetyStock, shelfLifeDays, note,
      });
      setName(''); setSpec(''); setUnit(''); setCategoryName(''); setBrand(''); setSupplierName('');
      setPurchasePrice(0); setRetailPrice(0); setStockQty(0); setSafetyStock(0); setShelfLifeDays(0); setNote('');
      setList(listProducts());
      onChanged();
    } catch (e: any) { Alert.alert('新增商品', e?.message || String(e)); }
  };
  const remove = (p: Product) => {
    Alert.alert('删除商品', `确认删除「${p.name}」？`, [
      { text: '取消', style: 'cancel' },
      { text: '删除', style: 'destructive', onPress: () => { deleteProduct(p.id); setList(listProducts()); onChanged(); } },
    ]);
  };

  return (
    <View>
      {/* 数据边界说明：手机端商品走本地 SQLite，syncEngine 不做 products 上行，
          PC 端看不到。明确写出来，避免用户以为已同步（审查报告 P1-6 / M1）。 */}
      <View style={styles.banner}>
        <Text style={styles.bannerText}>
          仅本机存储：手机端新增 / 修改的商品不会同步到电脑端。商品主数据请以电脑端为准，这里用于快捷查询与临时录入。
        </Text>
      </View>
      <View style={styles.card}>
        <View style={styles.listHeadRow}>
          <Text style={styles.sectionTitle}>商品列表（{list.length}）</Text>
          <TouchableOpacity style={styles.addMiniBtn} onPress={() => setAdding((v) => !v)}>
            <Text style={styles.addMiniBtnText}>{adding ? '收起' : '＋ 新增'}</Text>
          </TouchableOpacity>
        </View>
        {list.length === 0
          ? <View style={styles.empty}><Text style={styles.emptyText}>暂无商品，可在电脑端商品档案维护，或点「＋ 新增」在本机录入（不同步电脑端）</Text></View>
          : (
            <View>
              {list.map((p, i) => (
                <View key={p.id} style={[styles.listRow, { alignItems: 'flex-start' }, i > 0 && { borderTopWidth: 1, borderTopColor: theme.color.dividerApp }]}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.listLabel}>{p.name}</Text>
                    <Text style={styles.listSub}>
                      {[p.spec, p.unit, p.categoryName].filter(Boolean).join(' · ') || '—'}
                      {p.brand ? ` · ${p.brand}` : ''}
                      {p.supplierName ? ` · 供：${p.supplierName}` : ''}
                    </Text>
                    <Text style={styles.listMeta}>
                      库存 {p.stockQty} · 进 ¥{p.purchasePrice.toFixed(2)} / 售 ¥{p.retailPrice.toFixed(2)}
                      {p.safetyStock > 0 ? ` · 阈值 ${p.safetyStock}` : ''}
                    </Text>
                  </View>
                  <TouchableOpacity onPress={() => remove(p)}><Text style={styles.delText}>删除</Text></TouchableOpacity>
                </View>
              ))}
            </View>
          )
        }
      </View>

      {adding && (
      <View style={styles.card}>
        <Text style={styles.sectionTitle}>新增商品</Text>
        <FieldLabel>名称 *</FieldLabel>
        <TextInput style={styles.input} value={name} onChangeText={setName} placeholder="如：怡宝纯净水 555ml" placeholderTextColor={theme.color.textAppTertiary} />

        <View style={styles.dualRow}>
          <View style={{ flex: 1 }}>
            <FieldLabel>规格</FieldLabel>
            <TextInput style={styles.input} value={spec} onChangeText={setSpec} placeholder="如：555ml×24" placeholderTextColor={theme.color.textAppTertiary} />
          </View>
          <View style={{ width: 12 }} />
          <View style={{ flex: 1 }}>
            <FieldLabel>单位</FieldLabel>
            <TextInput style={styles.input} value={unit} onChangeText={setUnit} placeholder="如：箱" placeholderTextColor={theme.color.textAppTertiary} />
          </View>
        </View>

        <FieldLabel>分类</FieldLabel>
        <TouchableOpacity style={styles.field} onPress={pickCategory}>
          <Text style={[styles.fieldText, !categoryName && { color: theme.color.textAppTertiary }]}>
            {categoryName || '点击选择（选填）'}
          </Text>
          <Text style={styles.fieldArrow}>›</Text>
        </TouchableOpacity>

        <View style={styles.dualRow}>
          <View style={{ flex: 1 }}>
            <FieldLabel>品牌</FieldLabel>
            <TextInput style={styles.input} value={brand} onChangeText={setBrand} placeholder="选填" placeholderTextColor={theme.color.textAppTertiary} />
          </View>
          <View style={{ width: 12 }} />
          <View style={{ flex: 1 }}>
            <FieldLabel>供应商</FieldLabel>
            <TouchableOpacity style={styles.field} onPress={pickSupplier}>
              <Text style={[styles.fieldText, !supplierName && { color: theme.color.textAppTertiary }]}>
                {supplierName || '点击选择'}
              </Text>
              <Text style={styles.fieldArrow}>›</Text>
            </TouchableOpacity>
          </View>
        </View>

        <View style={styles.dualRow}>
          <View style={{ flex: 1 }}>
            <FieldLabel>进货价</FieldLabel>
            <TextInput style={styles.input} value={purchasePrice ? String(purchasePrice) : ''} onChangeText={(v) => setPurchasePrice(Number(v.replace(/[^0-9.]/g, '')) || 0)} placeholder="0" placeholderTextColor={theme.color.textAppTertiary} keyboardType="numeric" />
          </View>
          <View style={{ width: 12 }} />
          <View style={{ flex: 1 }}>
            <FieldLabel>零售价</FieldLabel>
            <TextInput style={styles.input} value={retailPrice ? String(retailPrice) : ''} onChangeText={(v) => setRetailPrice(Number(v.replace(/[^0-9.]/g, '')) || 0)} placeholder="0" placeholderTextColor={theme.color.textAppTertiary} keyboardType="numeric" />
          </View>
        </View>

        <View style={styles.dualRow}>
          <View style={{ flex: 1 }}>
            <FieldLabel>库存</FieldLabel>
            <TextInput style={styles.input} value={stockQty ? String(stockQty) : ''} onChangeText={(v) => setStockQty(Number(v.replace(/[^0-9]/g, '')) || 0)} placeholder="0" placeholderTextColor={theme.color.textAppTertiary} keyboardType="numeric" />
          </View>
          <View style={{ width: 12 }} />
          <View style={{ flex: 1 }}>
            <FieldLabel>安全库存</FieldLabel>
            <TextInput style={styles.input} value={safetyStock ? String(safetyStock) : ''} onChangeText={(v) => setSafetyStock(Number(v.replace(/[^0-9]/g, '')) || 0)} placeholder="0 = 不预警" placeholderTextColor={theme.color.textAppTertiary} keyboardType="numeric" />
          </View>
        </View>

        <FieldLabel>保质期（天）</FieldLabel>
        <TextInput style={styles.input} value={shelfLifeDays ? String(shelfLifeDays) : ''} onChangeText={(v) => setShelfLifeDays(Number(v.replace(/[^0-9]/g, '')) || 0)} placeholder="0 = 不限" placeholderTextColor={theme.color.textAppTertiary} keyboardType="numeric" />

        <FieldLabel>备注</FieldLabel>
        <TextInput style={styles.input} value={note} onChangeText={setNote} placeholder="选填" placeholderTextColor={theme.color.textAppTertiary} />

        <TouchableOpacity style={styles.addBtn} onPress={submit}><Text style={styles.addBtnText}>添加商品</Text></TouchableOpacity>
      </View>
      )}
    </View>
  );
}

// ============ 库存预警 ============
function WarningList({ tick }: { tick: number }) {
  const { theme } = useTheme();
  const styles = makeStyles(theme);
  const [list, setList] = useState<Product[]>(() => listLowStockProducts());
  React.useEffect(() => { setList(listLowStockProducts()); }, [tick]);

  if (list.length === 0) {
    return (
      <View>
        <Text style={styles.hint}>在商品档案中为商品设置「安全库存」后，低于阈值的商品会在此出现。安全库存 = 0 的商品不参与预警。</Text>
        <View style={styles.empty}><Text style={styles.emptyText}>暂无低库存商品 ✓</Text></View>
      </View>
    );
  }
  return (
    <View>
      <Text style={styles.hint}>共 {list.length} 件商品低于安全库存，建议尽快补货。</Text>
      <View style={styles.card}>
        {list.map((p, i) => (
          <View key={p.id} style={[styles.listRow, { alignItems: 'flex-start' }, i > 0 && { borderTopWidth: 1, borderTopColor: theme.color.dividerApp }]}>
            <View style={{ flex: 1 }}>
              <Text style={[styles.listLabel, { color: theme.color.danger }]}>{p.name}</Text>
              <Text style={styles.listSub}>
                {[p.spec, p.unit, p.categoryName].filter(Boolean).join(' · ') || '—'}
              </Text>
            </View>
            <View style={{ alignItems: 'flex-end' }}>
              <Text style={[styles.stockBig, { color: theme.color.danger }]}>{p.stockQty}</Text>
              <Text style={styles.stockSmall}>阈值 {p.safetyStock}</Text>
            </View>
          </View>
        ))}
      </View>
    </View>
  );
}

// ============ 通用小件 ============
function FieldLabel({ children }: { children: React.ReactNode }) {
  const { theme } = useTheme();
  return <Text style={{ fontSize: 12, color: theme.color.textAppTertiary, marginTop: 10, marginBottom: 4 }}>{children}</Text>;
}

function makeStyles(theme: any) {
  const S = theme.size;
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: theme.color.bgApp },
    content: { padding: theme.spaceScale[4], paddingBottom: 32 },
    topRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: theme.spaceScale[4] },
    title: { fontSize: theme.font.sizeV4.h2, fontWeight: theme.font.weight.bold, color: theme.color.textApp },
    card: { backgroundColor: theme.color.surfaceApp, borderRadius: theme.radius.lg, paddingHorizontal: theme.spaceScale[4], marginBottom: theme.spaceScale[4], paddingVertical: 6 },
    menuRow: { flexDirection: 'row', alignItems: 'center', minHeight: S.listRowMinH, paddingVertical: 6 },
    menuLabel: { fontSize: theme.font.sizeV4.bodyLg, color: theme.color.textApp, fontWeight: '500' },
    menuSub: { fontSize: theme.font.sizeV4.caption, color: theme.color.textAppTertiary, marginTop: 2 },
    arrow: { color: theme.color.textAppTertiary, fontSize: 22 },
    sectionTitle: { fontSize: theme.font.sizeV4.h4, fontWeight: theme.font.weight.semibold, color: theme.color.textApp, marginTop: 4, marginBottom: 8 },
    listHeadRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
    addMiniBtn: { backgroundColor: theme.color.primarySoft, borderRadius: theme.radius.md, paddingHorizontal: 12, paddingVertical: 6 },
    addMiniBtnText: { color: theme.color.primaryVivid, fontSize: 13, fontWeight: '600' },
    inlineForm: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 4 },
    input: { backgroundColor: theme.color.surfaceRaised, borderRadius: theme.radius.md, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15, color: theme.color.textApp, minHeight: S.controlLg },
    field: { flexDirection: 'row', alignItems: 'center', backgroundColor: theme.color.surfaceRaised, borderRadius: theme.radius.md, paddingHorizontal: 12, paddingVertical: 12, minHeight: S.controlLg },
    fieldText: { flex: 1, fontSize: 15, color: theme.color.textApp },
    fieldArrow: { color: theme.color.textAppTertiary, fontSize: 18 },
    dualRow: { flexDirection: 'row' },
    addBtn: { backgroundColor: theme.color.primaryVivid, borderRadius: theme.radius.md, minHeight: S.controlLg, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 18, marginTop: 4, marginBottom: 4 },
    addBtnText: { color: '#FFFFFF', fontSize: 15, fontWeight: '600' },
    listRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12 },
    listLabel: { fontSize: 15, color: theme.color.textApp, fontWeight: '500' },
    listSub: { fontSize: 12, color: theme.color.textAppTertiary, marginTop: 2 },
    listMeta: { fontSize: 12, color: theme.color.textAppSecondary, marginTop: 4, fontVariant: ['tabular-nums'] },
    delText: { fontSize: 14, color: theme.color.danger, paddingHorizontal: 4 },
    empty: { backgroundColor: theme.color.surfaceApp, borderRadius: theme.radius.lg, padding: theme.spaceScale[6], alignItems: 'center' },
    emptyText: { color: theme.color.textAppTertiary, fontSize: 14 },
    hint: { fontSize: 12, color: theme.color.textAppTertiary, lineHeight: 18, marginBottom: theme.spaceScale[3] },
    banner: {
      backgroundColor: theme.color.surfaceRaised,
      borderWidth: 1,
      borderColor: theme.color.primaryVivid,
      borderRadius: theme.radius.card,
      paddingHorizontal: 12,
      paddingVertical: 10,
      marginBottom: theme.spaceScale[3],
    },
    bannerText: { fontSize: 12, color: theme.color.textAppSecondary, lineHeight: 18 },
    stockBig: { fontSize: 20, fontWeight: '700', fontVariant: ['tabular-nums'] },
    stockSmall: { fontSize: 11, color: theme.color.textAppTertiary, marginTop: 2 },
    subHeader: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, backgroundColor: theme.color.bgApp },
    subBackBtn: { paddingLeft: 4, paddingRight: 12, paddingVertical: 4 },
    subBackText: { fontSize: 15, color: theme.color.primaryVivid },
    subTitle: { fontSize: 17, fontWeight: '600', color: theme.color.textApp, flex: 1, textAlign: 'center' },
    subSpacer: { width: 60 },
  });
}
