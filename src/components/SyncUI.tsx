import React from 'react';
import { View, Text, StyleSheet, ActivityIndicator } from 'react-native';
import { theme } from '../theme';
import type { SyncState } from '../nav';

export type SyncPhase = 'offline' | 'syncing' | 'pending' | 'synced' | 'conflict';

export function resolveSyncPhase(s: SyncState): SyncPhase {
  if (s.syncing) return 'syncing';
  if (!s.lanOn) return 'offline';
  if (s.pendingCount > 0) return 'pending';
  return 'synced';
}

const PHASE_COLOR: Record<SyncPhase, string> = {
  offline: theme.color.textAppTertiary,
  syncing: theme.color.info,
  pending: theme.color.statusPending,
  synced: theme.color.success,
  conflict: theme.color.primaryVivid,
};

const PHASE_TEXT: Record<SyncPhase, string> = {
  offline: '离线 · 可录入',
  syncing: '自动同步中…',
  pending: '待同步',
  synced: '已同步',
  conflict: '同步冲突 · 以云为准',
};

/** 顶部同步徽章四态（离线灰 / 同步中蓝 / 待同步黄铜 / 已同步绿） */
export function SyncBadge({ state }: { state: SyncState }) {
  const phase = resolveSyncPhase(state);
  const color = PHASE_COLOR[phase];
  const label =
    phase === 'pending' ? `待同步 ${state.pendingCount} 笔` : PHASE_TEXT[phase];
  return (
    <View style={styles.badge}>
      {phase === 'syncing' ? (
        <ActivityIndicator size="small" color={color} style={{ marginRight: 6 }} />
      ) : (
        <View style={[styles.dot, { backgroundColor: color }]} />
      )}
      <Text style={[styles.text, { color: theme.color.textApp }]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.color.surfaceApp,
    borderWidth: 1,
    borderColor: theme.color.borderApp,
    borderRadius: theme.radius.pill,
    paddingVertical: 6,
    paddingHorizontal: 12,
  },
  dot: { width: 8, height: 8, borderRadius: 4, marginRight: 6 },
  text: { fontSize: theme.font.sizeV4.caption, fontFamily: theme.font.family.num },
});
