import React, { useState } from 'react';
import {
  View, Text, ScrollView, StyleSheet, TouchableOpacity, RefreshControl,
} from 'react-native';
import { useTheme } from '../theme/ThemeProvider';
import { SafeAreaHeader } from '../components/SafeArea';
import { CategoryList, SupplierList, ProductList, WarningList } from './GoodsScreen';

interface Props {
  /** 关闭整个商品管理浮层（由「经营」页唤起） */
  onClose: () => void;
}

type ViewKey = 'main' | 'category' | 'supplier' | 'archive' | 'warning';

const VIEW_TITLES: Record<Exclude<ViewKey, 'main'>, string> = {
  category: '商品分类',
  supplier: '供应商管理',
  archive: '商品档案',
  warning: '库存预警',
};

/**
 * 「商品管理」分支入口页（由经营页唤起，浮层形态）。
 *
 * 与 GoodsScreen 的区别：GoodsScreen 是自带标题的 Tab 页，这里是带关闭按钮的浮层，
 * 且四个分支的子实现直接复用 GoodsScreen 导出的组件，避免两份雷同代码各自漂移。
 *
 * 崩溃防线：本页自身不读取任何商品数据，四个分支进去后才按需加载；
 * 「商品档案」「供应商管理」已改为搜索前置（进入时不查表，输入关键词才查，SQL 层 LIMIT）。
 */
export default function GoodsManageScreen({ onClose }: Props) {
  const { theme } = useTheme();
  const styles = makeStyles(theme);
  const [view, setView] = useState<ViewKey>('main');
  const [tick, setTick] = useState(0);
  const refresh = () => setTick((t) => t + 1);

  const isMain = view === 'main';

  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={false} onRefresh={refresh} />}
    >
      <SafeAreaHeader style={styles.header}>
        <TouchableOpacity
          style={styles.closeBtn}
          onPress={isMain ? onClose : () => { setView('main'); refresh(); }}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          accessibilityRole="button"
        >
          <Text style={styles.closeText}>{isMain ? '✕ 关闭' : '‹ 商品管理'}</Text>
        </TouchableOpacity>
        <Text style={styles.title}>{isMain ? '商品管理' : VIEW_TITLES[view]}</Text>
        <View style={styles.spacer} />
      </SafeAreaHeader>

      {isMain ? (
        <View style={styles.card}>
          <Entry icon="📂" title="商品分类" note="维护分类层级" onPress={() => setView('category')} />
          <Entry icon="📦" title="商品档案" note="商品主数据与价格 · 数据量大，建议在电脑端维护" onPress={() => setView('archive')} />
          <Entry icon="🏢" title="供应商管理" note="供应商主数据 · 建议在电脑端维护" onPress={() => setView('supplier')} />
          <Entry icon="⚠️" title="库存预警" note="低库存提醒" onPress={() => setView('warning')} last />
        </View>
      ) : (
        <View style={{ marginTop: theme.spaceScale[3] }}>
          {view === 'category' && <CategoryList tick={tick} onChanged={refresh} />}
          {view === 'supplier' && <SupplierList tick={tick} onChanged={refresh} />}
          {view === 'archive' && <ProductList tick={tick} onChanged={refresh} />}
          {view === 'warning' && <WarningList tick={tick} />}
        </View>
      )}

      {isMain && (
        <Text style={styles.hint}>
          商品 / 供应商主数据请优先在电脑端维护，手机端聚焦快捷录入与查询。所有数据落本地 SQLite，离线可用。
        </Text>
      )}
    </ScrollView>
  );
}

function Entry({ icon, title, note, onPress, last }: {
  icon: string; title: string; note: string; onPress: () => void; last?: boolean;
}) {
  const { theme } = useTheme();
  const styles = makeStyles(theme);
  return (
    <TouchableOpacity
      style={[styles.menuRow, !last && { borderBottomWidth: 1, borderBottomColor: theme.color.dividerApp }]}
      onPress={onPress}
    >
      <Text style={styles.entryIcon}>{icon}</Text>
      <View style={{ flex: 1 }}>
        <Text style={styles.menuLabel}>{title}</Text>
        <Text style={styles.menuSub}>{note}</Text>
      </View>
      <Text style={styles.arrow}>›</Text>
    </TouchableOpacity>
  );
}

function makeStyles(theme: any) {
  const S = theme.size;
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: theme.color.bgApp },
    content: { padding: theme.spaceScale[4], paddingBottom: 32 },
    header: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, backgroundColor: theme.color.bgApp },
    closeBtn: { paddingLeft: 4, paddingRight: 12, paddingVertical: 4, minWidth: 72 },
    closeText: { fontSize: 15, color: theme.color.primaryVivid },
    title: { fontSize: 17, fontWeight: '600', color: theme.color.textApp, flex: 1, textAlign: 'center' },
    spacer: { width: 72 },
    card: {
      backgroundColor: theme.color.surfaceApp, borderRadius: theme.radius.lg,
      paddingHorizontal: theme.spaceScale[4], marginBottom: theme.spaceScale[4], paddingVertical: 6,
    },
    menuRow: { flexDirection: 'row', alignItems: 'center', minHeight: S.listRowMinH, paddingVertical: 6 },
    entryIcon: { fontSize: 20, marginRight: theme.spaceScale[3] },
    menuLabel: { fontSize: theme.font.sizeV4.bodyLg, color: theme.color.textApp, fontWeight: '500' },
    menuSub: { fontSize: theme.font.sizeV4.caption, color: theme.color.textAppTertiary, marginTop: 2 },
    arrow: { color: theme.color.textAppTertiary, fontSize: 22 },
    hint: { fontSize: 12, color: theme.color.textAppTertiary, lineHeight: 18, marginTop: theme.spaceScale[2] },
  });
}
