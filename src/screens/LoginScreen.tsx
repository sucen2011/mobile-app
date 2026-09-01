import React, { useState } from 'react';
import { StyleSheet, View, Text, TextInput, TouchableOpacity, ActivityIndicator } from 'react-native';
import { useTheme } from '../theme/ThemeProvider';
import { connectStore } from '../config';

// 「登录」= 首次连接店铺引导（设备激活）。后端无用户名/密码体系（静态 X-Api-Token，仅局域网内经 /api/bootstrap 下发），
// 故此处只做「填店铺服务器地址 → 测连通 → 拉令牌 → 标记已激活」。离线优先：也可「稍后设置，离线使用」。
interface Props {
  initialUrl: string;
  onConnect: (url: string) => void; // 连接成功，进入主界面
  onSkip: () => void; // 离线使用
}

export default function LoginScreen({ initialUrl, onConnect, onSkip }: Props) {
  const { theme } = useTheme();
  const styles = makeStyles(theme);
  const [url, setUrl] = useState(initialUrl || '');
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<{ type: 'idle' | 'ok' | 'err'; msg: string }>({ type: 'idle', msg: '' });

  const handleConnect = async () => {
    if (loading) return;
    setLoading(true);
    setStatus({ type: 'idle', msg: '' });
    const r = await connectStore(url);
    setLoading(false);
    if (r.ok) {
      setStatus({ type: 'ok', msg: r.msg });
      onConnect(url.trim());
    } else {
      setStatus({ type: 'err', msg: r.msg });
    }
  };

  return (
    <View style={styles.root}>
      <View style={styles.hero}>
        <Text style={styles.brand}>商超台账</Text>
        {/* brand 用 display(44) 大字号；sizeV4 无 h1 键，勿用 styles.brand 以外的字号 */}
        <Text style={styles.tagline}>离线可录 · 连店铺 WiFi 自动同步</Text>
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>连接店铺服务器</Text>
        <Text style={styles.hint}>
          填写电脑端【设置】页面显示的服务器地址（含 http://）。手机与店铺电脑在同一 WiFi 下可自动获取接口令牌。
        </Text>
        <TextInput
          style={styles.input}
          value={url}
          onChangeText={setUrl}
          placeholder="http://电脑局域网IP:3001"
          placeholderTextColor={theme.color.textAppTertiary}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
        />
        <TouchableOpacity
          style={[styles.primaryBtn, loading && { opacity: 0.7 }]}
          onPress={handleConnect}
          disabled={loading}
        >
          {loading ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.primaryBtnText}>连接店铺</Text>
          )}
        </TouchableOpacity>

        {status.type === 'ok' && <Text style={[styles.status, { color: theme.color.success }]}>{status.msg}</Text>}
        {status.type === 'err' && <Text style={[styles.status, { color: theme.color.danger }]}>{status.msg}</Text>}

        <TouchableOpacity style={styles.skipBtn} onPress={onSkip} disabled={loading}>
          <Text style={styles.skipText}>稍后设置，离线使用</Text>
        </TouchableOpacity>
      </View>

      <Text style={styles.foot}>手机端为快捷录入端：未连接时录入的数据先存本机，连上店铺 WiFi 后自动同步，同步成功即清理本地草稿。</Text>
    </View>
  );
}

function makeStyles(theme: any) {
  const S = theme.size;
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: theme.color.bgApp, padding: theme.spaceScale[5], justifyContent: 'center' },
    hero: { alignItems: 'center', marginBottom: theme.spaceScale[8] },
    brand: { fontSize: theme.font.sizeV4.display, fontWeight: theme.font.weight.bold, color: theme.color.textApp },
    tagline: { fontSize: theme.font.sizeV4.body, color: theme.color.textAppSecondary, marginTop: theme.spaceScale[2] },
    card: {
      backgroundColor: theme.color.surfaceApp,
      borderRadius: theme.radius.lg,
      padding: theme.spaceScale[5],
    },
    cardTitle: {
      fontSize: theme.font.sizeV4.h3,
      fontWeight: theme.font.weight.semibold,
      color: theme.color.textApp,
      marginBottom: theme.spaceScale[3],
    },
    hint: { fontSize: theme.font.sizeV4.caption, color: theme.color.textAppSecondary, lineHeight: 18, marginBottom: theme.spaceScale[4] },
    input: {
      backgroundColor: theme.color.surfaceSunken,
      borderWidth: 1,
      borderColor: theme.color.borderApp,
      borderRadius: theme.radius.md,
      height: S.controlLg,
      paddingHorizontal: theme.spaceScale[4],
      color: theme.color.textApp,
      fontSize: theme.font.sizeV4.body,
      fontFamily: theme.font.family.num,
    },
    primaryBtn: {
      marginTop: theme.spaceScale[4],
      backgroundColor: theme.color.primaryVivid,
      borderRadius: theme.radius.md,
      height: S.controlLg,
      alignItems: 'center',
      justifyContent: 'center',
    },
    primaryBtnText: { color: '#fff', fontSize: theme.font.sizeV4.body, fontWeight: theme.font.weight.medium },
    status: { fontSize: theme.font.sizeV4.caption, marginTop: theme.spaceScale[3], lineHeight: 18 },
    skipBtn: { marginTop: theme.spaceScale[5], alignItems: 'center' },
    skipText: { fontSize: theme.font.sizeV4.body, color: theme.color.textAppSecondary },
    foot: { fontSize: theme.font.sizeV4.caption, color: theme.color.textAppTertiary, lineHeight: 18, marginTop: theme.spaceScale[5], textAlign: 'center' },
  });
}
