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
  createProduct, deleteProduct,
  listLowStockProducts,
  searchProducts, countProducts,
  searchSuppliers, countSuppliers,
  type Category, type Supplier, type Product,
} from '../db/localDb';

/**
 * 单次搜索返回上限。
 * 它是「响应速度」与「够不够看」的平衡点：50 条足够一屏翻找，
 * 再多就要用户细化关键词 —— 而不是替他把上万条塞进内存。
 */
const PRODUCT_SEARCH_LIMIT = 50;
const SUPPLIER_SEARCH_LIMIT = 50;
// Alert 选择器硬上限：分类/供应商量级可能上千，原生 Alert 按钮过多会溢出屏幕，
// 故只展示前 PICKER_MAX 项，其余请用「搜索」缩小范围。
const PICKER_MAX = 30;

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
export function CategoryList({ tick, onChanged }: { tick: number; onChanged: () => void }) {
  const { theme } = useTheme();
  const styles = makeStyles(theme);
  const [all, setAll] = useState<Category[]>(() => listCategories());
  const [name, setName] = useState('');
  // 分类量级远小于商品（几百条），本地过滤即可，不必上 SQL
  const [kw, setKw] = useState('');
  const list = useMemo(() => {
    const t = kw.trim();
    return t ? all.filter((c) => c.name.includes(t)) : all;
  }, [all, kw]);
  React.useEffect(() => { setAll(listCategories()); }, [tick]);

  const submit = () => {
    try {
      createCategory(name);
      setName('');
      setAll(listCategories());
      onChanged();
    } catch (e: any) { Alert.alert('新增分类', e?.message || String(e)); }
  };
  const remove = (c: Category) => {
    Alert.alert('删除分类', `确认删除「${c.name}」？`, [
      { text: '取消', style: 'cancel' },
      { text: '删除', style: 'destructive', onPress: () => {
        try { deleteCategory(c.id); setAll(listCategories()); onChanged(); }
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

      <View style={styles.card}>
        <Text style={styles.sectionTitle}>搜索分类</Text>
        <TextInput
          style={styles.input}
          value={kw}
          onChangeText={setKw}
          placeholder="输入分类名筛选"
          placeholderTextColor={theme.color.textAppTertiary}
          autoCorrect={false}
        />
        <Text style={styles.resultMeta}>
          共 {all.length} 个分类{list.length !== all.length ? ` · 匹配 ${list.length} 个` : ''}
        </Text>
      </View>

      <Text style={styles.sectionTitle}>分类列表</Text>
      {list.length === 0
        ? <View style={styles.empty}><Text style={styles.emptyText}>{kw.trim() ? '没有匹配的分类' : '暂无分类'}</Text></View>
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
export function SupplierList({ tick, onChanged }: { tick: number; onChanged: () => void }) {
  const { theme } = useTheme();
  const styles = makeStyles(theme);
  // 与商品档案同理：默认不加载，先给搜索框
  const [kw, setKw] = useState('');
  const [list, setList] = useState<Supplier[]>([]);
  const [total, setTotal] = useState(() => countSuppliers());
  const [name, setName] = useState('');
  const [contact, setContact] = useState('');
  const [phone, setPhone] = useState('');
  const runSearch = (v: string) => {
    const t = (v || '').trim();
    setList(t ? searchSuppliers(t, SUPPLIER_SEARCH_LIMIT) : []);
    setTotal(countSuppliers());
  };
  React.useEffect(() => { runSearch(kw); }, [tick]);
  const onChangeKw = (v: string) => { setKw(v); runSearch(v); };

  const submit = () => {
    try {
      createSupplier({ name, contact, phone, address: '', note: '' });
      setName(''); setContact(''); setPhone('');
      runSearch(kw);
      onChanged();
    } catch (e: any) { Alert.alert('新增供应商', e?.message || String(e)); }
  };
  const remove = (s: Supplier) => {
    Alert.alert('删除供应商', `确认删除「${s.name}」？`, [
      { text: '取消', style: 'cancel' },
      { text: '删除', style: 'destructive', onPress: () => { deleteSupplier(s.id); runSearch(kw); onChanged(); } },
    ]);
  };

  return (
    <View>
      <View style={styles.card}>
        <Text style={styles.sectionTitle}>搜索供应商</Text>
        <View style={styles.searchRow}>
          <TextInput
            style={[styles.input, { flex: 1 }]}
            value={kw}
            onChangeText={onChangeKw}
            placeholder="名称 / 联系人 / 电话"
            placeholderTextColor={theme.color.textAppTertiary}
            returnKeyType="search"
            autoCorrect={false}
          />
          {kw.length > 0 && (
            <TouchableOpacity style={styles.clearBtn} onPress={() => onChangeKw('')}>
              <Text style={styles.clearText}>清除</Text>
            </TouchableOpacity>
          )}
        </View>
        <Text style={styles.resultMeta}>
          {kw.trim() ? `匹配 ${list.length} 条 · 本机共 ${total} 条` : `本机共 ${total} 条供应商 · 输入关键词后显示`}
        </Text>
      </View>

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

      <Text style={styles.sectionTitle}>供应商列表</Text>
      {list.length === 0
        ? <View style={styles.empty}><Text style={styles.emptyText}>{kw.trim() ? '没有匹配的供应商，换个关键词试试' : '输入关键词开始搜索，或在上方新增供应商'}</Text></View>
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
export function ProductList({ tick, onChanged }: { tick: number; onChanged: () => void }) {
  const { theme } = useTheme();
  const styles = makeStyles(theme);
  // 关键：初始 **空列表**。
  // 老实现是 useState(() => listProducts())，一进页面就把整张 products 表实例化成对象数组，
  // 14534 条直接在渲染期把主线程打死 → 白屏。现在改成「先搜索框 + 空列表」，
  // 只有用户输入关键词后才走 SQL 的 LIKE + LIMIT 50，最多进内存 50 条。
  const [kw, setKw] = useState('');
  const [list, setList] = useState<Product[]>([]);
  const [total, setTotal] = useState(() => countProducts());
  // 分类/供应商只用于「新增商品」表单的下拉选择，量级远小于商品表，全量取没问题
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

  /**
   * 按关键词重搜。**空关键词 = 不加载任何行**（这是防崩溃的核心约定）。
   * SQL 层 LIMIT 保证单次最多进内存 PRODUCT_SEARCH_LIMIT 条。
   */
  const runSearch = (v: string) => {
    const t = (v || '').trim();
    setList(t ? searchProducts(t, PRODUCT_SEARCH_LIMIT) : []);
    setTotal(countProducts());
  };
  // tick 变化（下拉刷新 / 下行同步完成）时按当前关键词重搜 —— 不再全表重拉
  React.useEffect(() => { runSearch(kw); }, [tick]);
  const onChangeKw = (v: string) => { setKw(v); runSearch(v); };

  const pickCategory = () => {
    if (categories.length === 0) { Alert.alert('选择分类', '暂无分类，请先在「商品分类」中添加'); return; }
    const shown = categories.slice(0, PICKER_MAX);
    Alert.alert('选择分类', buildPickerHint(categories.length, PICKER_MAX), [
      ...shown.map((c) => ({ text: c.name, onPress: () => setCategoryName(c.name) })),
      { text: '不选', onPress: () => setCategoryName('') },
      { text: '取消', onPress: () => undefined, style: 'cancel' as const },
    ]);
  };
  const pickSupplier = () => {
    if (suppliers.length === 0) { Alert.alert('选择供应商', '暂无供应商，请先在「供应商管理」中添加'); return; }
    const shown = suppliers.slice(0, PICKER_MAX);
    Alert.alert('选择供应商', buildPickerHint(suppliers.length, PICKER_MAX), [
      ...shown.map((s) => ({ text: s.name, onPress: () => setSupplierName(s.name) })),
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
      runSearch(kw);
      onChanged();
    } catch (e: any) { Alert.alert('新增商品', e?.message || String(e)); }
  };
  const remove = (p: Product) => {
    Alert.alert('删除商品', `确认删除「${p.name}」？`, [
      { text: '取消', style: 'cancel' },
      { text: '删除', style: 'destructive', onPress: () => { deleteProduct(p.id); runSearch(kw); onChanged(); } },
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
      {/* 搜索前置：进入本页不加载任何商品行，输入关键词后才命中 SQL 的 LIKE + LIMIT */}
      <View style={styles.card}>
        <Text style={styles.sectionTitle}>搜索商品</Text>
        <View style={styles.searchRow}>
          <TextInput
            style={[styles.input, { flex: 1 }]}
            value={kw}
            onChangeText={onChangeKw}
            placeholder="商品名 / 规格 / 品牌 / 分类 / 供应商"
            placeholderTextColor={theme.color.textAppTertiary}
            returnKeyType="search"
            autoCorrect={false}
          />
          {kw.length > 0 && (
            <TouchableOpacity style={styles.clearBtn} onPress={() => onChangeKw('')}>
              <Text style={styles.clearText}>清除</Text>
            </TouchableOpacity>
          )}
        </View>
        <Text style={styles.resultMeta}>
          {kw.trim()
            ? `匹配 ${list.length} 条${list.length >= PRODUCT_SEARCH_LIMIT ? `（单次最多 ${PRODUCT_SEARCH_LIMIT} 条，请细化关键词）` : ''} · 本机共 ${total} 条`
            : `本机共 ${total} 条商品 · 输入关键词后显示（数据量较大，不做全量加载）`}
        </Text>
      </View>

      <View style={styles.card}>
        <View style={styles.listHeadRow}>
          <Text style={styles.sectionTitle}>商品列表</Text>
          <TouchableOpacity style={styles.addMiniBtn} onPress={() => setAdding((v) => !v)}>
            <Text style={styles.addMiniBtnText}>{adding ? '收起' : '＋ 新增'}</Text>
          </TouchableOpacity>
        </View>
        {list.length === 0
          ? <View style={styles.empty}><Text style={styles.emptyText}>{kw.trim() ? '没有匹配的商品，换个关键词试试' : '输入关键词开始搜索。也可点「＋ 新增」在本机录入（不同步电脑端）'}</Text></View>
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
export function WarningList({ tick }: { tick: number }) {
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
/** 选择器提示文案：总量 ≤ 上限时只报总数；超出则提醒「仅显示前 N 项」 */
function buildPickerHint(total: number, max: number): string {
  if (total <= max) return `共 ${total} 项`;
  return `共 ${total} 项，仅显示前 ${max} 项，请先搜索缩小范围`;
}

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
    // 搜索前置相关
    searchRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 4 },
    clearBtn: {
      backgroundColor: theme.color.surfaceApp, borderWidth: 1, borderColor: theme.color.borderApp,
      borderRadius: theme.radius.pill, paddingHorizontal: 12, paddingVertical: 8, minHeight: S.controlLg,
      alignItems: 'center', justifyContent: 'center',
    },
    clearText: { color: theme.color.textAppSecondary, fontSize: 13 },
    resultMeta: { fontSize: 12, color: theme.color.textAppTertiary, marginTop: 6, marginBottom: 4, lineHeight: 18 },
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
