import React, { useState } from 'react';
import {
  View, Text, ScrollView, StyleSheet, TouchableOpacity, RefreshControl,
} from 'react-native';
import { useTheme } from '../theme/ThemeProvider';
import { SafeAreaHeader } from '../components/SafeArea';
import { SyncBadge } from '../components/SyncUI';
import type { SyncState } from '../nav';
import SupplierExpenseScreen from './SupplierExpenseScreen';
import TobaccoProfitScreen from './TobaccoProfitScreen';
import TobaccoTrackingScreen from './TobaccoTrackingScreen';
import TobaccoPlanCreateScreen from './TobaccoPlanCreateScreen';

interface Props {
  sync: SyncState;
  baseUrl: string;
}

type ViewKey =
  | 'main'        // 供采首页：两个大卡片
  | 'supplierExpense'
  | 'tobacco'     // 烟草二级页：三个子入口
  | 'tobaccoProfit'
  | 'tobaccoTracking'
  | 'tobaccoPlanCreate';

const SUB_TITLES: Record<Exclude<ViewKey, 'main'>, string> = {
  supplierExpense: '陈列费用',
  tobacco: '烟草管理',
  tobaccoProfit: '烟草利润',
  tobaccoTracking: '到货跟踪',
  tobaccoPlanCreate: '新增烟草方案',
};

/**
 * 「供采」Tab（原「商品」Tab 改版而来）。
 *
 * 为什么把商品移走、换成供采：
 * 商品 Tab 点进来就是四个分支入口，再点「商品档案」会一次性加载上万条商品导致卡死；
 * 而真正高频的供应商侧业务（陈列费用、烟草）之前埋在「我的」子菜单深处。
 * 现在 Tab 直达供采，商品管理降级为「经营」页的一个快捷入口，并改成搜索前置。
 */
export default function SupplyChainScreen({ sync, baseUrl }: Props) {
  const { theme } = useTheme();
  const styles = makeStyles(theme);
  const [view, setView] = useState<ViewKey>('main');
  const [tick, setTick] = useState(0);
  const refresh = () => setTick((t) => t + 1);

  // —— 二级页：直接把已有业务屏整体挂进来，带自己的返回栏 ——
  if (view !== 'main') {
    const sub = SUB_TITLES[view];
    return (
      <ScrollView
        style={styles.root}
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={false} onRefresh={refresh} />}
      >
        <SafeAreaHeader style={styles.subHeader}>
          <TouchableOpacity
            style={styles.subBackBtn}
            onPress={() => setView('main')}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            accessibilityRole="button"
          >
            {/* 烟草三级页返回二级，其余返回供采首页 */}
            <Text style={styles.subBackText}>
              ‹ {['tobaccoProfit', 'tobaccoTracking', 'tobaccoPlanCreate'].includes(view) ? '烟草管理' : '供采'}
            </Text>
          </TouchableOpacity>
          <Text style={styles.subTitle}>{sub}</Text>
          <View style={styles.subSpacer} />
        </SafeAreaHeader>
        <View style={{ marginTop: theme.spaceScale[3] }}>
          {view === 'supplierExpense' && <SupplierExpenseScreen baseUrl={baseUrl} onBack={() => setView('main')} />}
          {view === 'tobacco' && <TobaccoMenu onPick={setView} />}
          {view === 'tobaccoProfit' && <TobaccoProfitScreen baseUrl={baseUrl} onBack={() => setView('tobacco')} />}
          {view === 'tobaccoTracking' && <TobaccoTrackingScreen baseUrl={baseUrl} onBack={() => setView('tobacco')} />}
          {view === 'tobaccoPlanCreate' && <TobaccoPlanCreateScreen baseUrl={baseUrl} onBack={() => setView('tobacco')} />}
        </View>
      </ScrollView>
    );
  }

  // —— 首页：两个大卡片入口 ——
  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={false} onRefresh={refresh} />}
    >
      <View style={styles.topRow}>
        <Text style={styles.title}>供采</Text>
        <SyncBadge state={sync} />
      </View>

      <BigEntryCard
        icon="🏷"
        title="陈列费用"
        note="供应商费用录入 · 结算 · 冲红"
        onPress={() => setView('supplierExpense')}
      />
      <BigEntryCard
        icon="🚬"
        title="烟草管理"
        note="烟草利润 · 到货跟踪 · 订烟方案"
        onPress={() => setView('tobacco')}
      />

      <Text style={styles.hint}>
        供应商相关业务集中在此。商品档案 / 分类 / 库存预警已移至「经营 → 商品管理」。
      </Text>
    </ScrollView>
  );
}

/** 供采首页的大卡片：比普通 MenuRow 更高，主入口地位明确 */
function BigEntryCard({ icon, title, note, onPress }: { icon: string; title: string; note: string; onPress: () => void }) {
  const { theme } = useTheme();
  const styles = makeStyles(theme);
  return (
    <TouchableOpacity style={styles.bigCard} onPress={onPress}>
      <View style={styles.bigIconBox}>
        <Text style={styles.bigIcon}>{icon}</Text>
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.bigTitle}>{title}</Text>
        <Text style={styles.bigNote}>{note}</Text>
      </View>
      <Text style={styles.arrow}>›</Text>
    </TouchableOpacity>
  );
}

/** 烟草二级菜单：三个子入口（含 OCR 新增方案） */
function TobaccoMenu({ onPick }: { onPick: (v: ViewKey) => void }) {
  const { theme } = useTheme();
  const styles = makeStyles(theme);
  return (
    <View style={styles.card}>
      <MenuRow label="烟草利润" note="按批次计算真实利润" onPress={() => onPick('tobaccoProfit')} />
      <MenuRow label="到货跟踪" note="进货计划 vs 实际到货" onPress={() => onPick('tobaccoTracking')} />
      <MenuRow label="📷 新增烟草方案（OCR）" note="拍照 / 相册识别方案表" onPress={() => onPick('tobaccoPlanCreate')} last />
    </View>
  );
}

function MenuRow({ label, note, onPress, last }: { label: string; note: string; onPress: () => void; last?: boolean }) {
  const { theme } = useTheme();
  const styles = makeStyles(theme);
  return (
    <TouchableOpacity
      style={[styles.menuRow, !last && { borderBottomWidth: 1, borderBottomColor: theme.color.dividerApp }]}
      onPress={onPress}
    >
      <View style={{ flex: 1 }}>
        <Text style={styles.menuLabel}>{label}</Text>
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
    topRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: theme.spaceScale[4] },
    title: { fontSize: theme.font.sizeV4.h2, fontWeight: theme.font.weight.bold, color: theme.color.textApp },
    card: {
      backgroundColor: theme.color.surfaceApp, borderRadius: theme.radius.lg,
      paddingHorizontal: theme.spaceScale[4], marginBottom: theme.spaceScale[4], paddingVertical: 6,
    },
    bigCard: {
      flexDirection: 'row', alignItems: 'center',
      backgroundColor: theme.color.surfaceApp, borderRadius: theme.radius.lg,
      paddingVertical: theme.spaceScale[4], paddingHorizontal: theme.spaceScale[4],
      marginBottom: theme.spaceScale[3],
    },
    bigIconBox: {
      width: 44, height: 44, borderRadius: 12,
      backgroundColor: theme.color.primarySoft, alignItems: 'center', justifyContent: 'center',
      marginRight: theme.spaceScale[3],
    },
    bigIcon: { fontSize: 22 },
    bigTitle: { fontSize: theme.font.sizeV4.bodyLg, fontWeight: theme.font.weight.semibold, color: theme.color.textApp },
    bigNote: { fontSize: theme.font.sizeV4.caption, color: theme.color.textAppTertiary, marginTop: 2 },
    menuRow: { flexDirection: 'row', alignItems: 'center', minHeight: S.listRowMinH, paddingVertical: 6 },
    menuLabel: { fontSize: theme.font.sizeV4.bodyLg, color: theme.color.textApp, fontWeight: '500' },
    menuSub: { fontSize: theme.font.sizeV4.caption, color: theme.color.textAppTertiary, marginTop: 2 },
    arrow: { color: theme.color.textAppTertiary, fontSize: 22 },
    hint: { fontSize: 12, color: theme.color.textAppTertiary, lineHeight: 18, marginTop: theme.spaceScale[2] },
    subHeader: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, backgroundColor: theme.color.bgApp },
    subBackBtn: { paddingLeft: 4, paddingRight: 12, paddingVertical: 4 },
    subBackText: { fontSize: 15, color: theme.color.primaryVivid },
    subTitle: { fontSize: 17, fontWeight: '600', color: theme.color.textApp, flex: 1, textAlign: 'center' },
    subSpacer: { width: 60 },
  });
}
