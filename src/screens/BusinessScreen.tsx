import React from 'react';
import { View, Text, ScrollView, StyleSheet } from 'react-native';
import { useTheme } from '../theme/ThemeProvider';
import EntryHub from './EntryHub';
import RecordsScreen from './RecordsScreen';
import type { SyncState, TabKey } from '../nav';

interface Props {
  sync: SyncState;
  onNavigate: (tab: TabKey) => void;
  onNewPurchase: () => void;
  onNewRevenue: () => void;
  onEditDraft: (id: string) => void;
  onEditRevenueDraft?: (id: string) => void;
  onOpenDetail: (rec: { kind: 'revenue' | 'purchase' | 'draft' | 'revenueDraft'; id: string }) => void;
  onSyncAll: () => void;
  onRefreshPending: () => void;
}

/**
 * 「经营」页 = 录单入口 + 明细列表 合一（Ardot 5 Tab 之一）。
 * 用一个外层 ScrollView 把 EntryHub（录单/草稿箱）与 RecordsScreen（明细）串起来，
 * 两者都以 embedded 模式渲染（各自去掉自己的 header 与 ScrollView，只留内容），
 * 避免嵌套滚动、也避免两个重复标题。
 */
export default function BusinessScreen({
  sync,
  onNavigate,
  onNewPurchase,
  onNewRevenue,
  onEditDraft,
  onEditRevenueDraft,
  onOpenDetail,
  onSyncAll,
  onRefreshPending,
}: Props) {
  const { theme } = useTheme();
  const styles = makeStyles(theme);

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.content}>
      <View style={styles.header}>
        <Text style={styles.title}>经营</Text>
      </View>

      <EntryHub
        embedded
        sync={sync}
        onNavigate={onNavigate}
        onNewPurchase={onNewPurchase}
        onNewRevenue={onNewRevenue}
        onEditDraft={onEditDraft}
        onEditRevenueDraft={onEditRevenueDraft}
        onSyncAll={onSyncAll}
        onRefreshPending={onRefreshPending}
      />

      <View style={styles.sectionHead}>
        <Text style={styles.sectionTitle}>明细</Text>
      </View>

      <RecordsScreen embedded sync={sync} onOpenDetail={onOpenDetail} />
    </ScrollView>
  );
}

function makeStyles(theme: any) {
  const S = theme.size;
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: theme.color.bgApp },
    content: { padding: theme.spaceScale[4], paddingBottom: 32 },
    header: { paddingTop: theme.spaceScale[4], paddingBottom: theme.spaceScale[2] },
    title: { fontSize: theme.font.sizeV4.h2, fontWeight: theme.font.weight.bold, color: theme.color.textApp },
    sectionHead: { marginTop: theme.spaceScale[6], marginBottom: theme.spaceScale[2] },
    sectionTitle: { fontSize: theme.font.sizeV4.h4, fontWeight: theme.font.weight.semibold, color: theme.color.textApp },
  });
}
