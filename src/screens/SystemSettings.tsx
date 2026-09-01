import React from 'react';
import { StyleSheet, View, Text, Switch } from 'react-native';
import { useTheme } from '../theme/ThemeProvider';

// 「我的」→「系统设置」二级页主体（嵌入 Settings 子页 ScrollView 内，故只返回 body）。
// 当前承载：外观 / 深色模式切换。切换经 ThemeProvider 持久化，重启 App 仍保持。
export default function SystemSettings() {
  const { theme, mode, toggleTheme } = useTheme();
  const styles = makeStyles(theme);
  const isDark = mode === 'dark';
  return (
    <View style={styles.wrap}>
      <View style={styles.card}>
        <Text style={styles.cardTitle}>外观</Text>
        <View style={styles.row}>
          <View style={styles.rowText}>
            <Text style={styles.rowLabel}>深色模式</Text>
            <Text style={styles.rowHint}>开启后整体切换为深色；设置会保存到本机，重启 App 仍保持。</Text>
          </View>
          <Switch
            value={isDark}
            onValueChange={toggleTheme}
            thumbColor={isDark ? theme.color.surfaceApp : '#FFFFFF'}
            trackColor={{ false: theme.color.borderApp, true: theme.color.primaryVivid }}
            style={styles.switch}
          />
        </View>
      </View>
      <Text style={styles.hint}>
        当前外观：{isDark ? '深色' : '浅色（默认）'}。浅色以 Ardot 移动端视觉稿（visual-base-v1）为基线，深色复用原暖色主题。
      </Text>
    </View>
  );
}

function makeStyles(theme: any) {
  const S = theme.size;
  return StyleSheet.create({
    wrap: { padding: theme.spaceScale[4] },
    card: {
      backgroundColor: theme.color.surfaceApp,
      borderRadius: theme.radius.lg,
      padding: theme.spaceScale[4],
      marginBottom: theme.spaceScale[4],
    },
    cardTitle: {
      fontSize: theme.font.sizeV4.h4,
      fontWeight: theme.font.weight.semibold,
      color: theme.color.textApp,
      marginBottom: theme.spaceScale[3],
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      minHeight: S.listRowMinH,
    },
    rowText: { flex: 1, paddingRight: theme.spaceScale[4] },
    rowLabel: {
      fontSize: theme.font.sizeV4.body,
      color: theme.color.textApp,
      fontWeight: theme.font.weight.medium,
    },
    rowHint: {
      fontSize: theme.font.sizeV4.caption,
      color: theme.color.textAppSecondary,
      marginTop: theme.spaceScale[2],
      lineHeight: 18,
    },
    switch: { transform: [{ scaleX: 0.9 }, { scaleY: 0.9 }] },
    hint: { fontSize: theme.font.sizeV4.caption, color: theme.color.textAppTertiary, lineHeight: 18 },
  });
}
