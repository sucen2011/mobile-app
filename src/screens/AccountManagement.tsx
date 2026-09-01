import React, { useState, useEffect } from 'react';
import { StyleSheet, View, Text, TextInput, TouchableOpacity, Alert } from 'react-native';
import { useTheme } from '../theme/ThemeProvider';
import {
  DEVICE_ID,
  getApiToken,
  refreshApiToken,
  loadBaseUrl,
  DEFAULT_STORE_BASE_URL,
  loadAccountProfile,
  saveAccountProfile,
  type AccountProfile,
} from '../config';

// 「我的」→「账号管理」二级页主体（嵌入 Settings 子页 ScrollView 内，故只返回 body）。
// 手机端为设备绑定的录入端，无独立账号体系（角色/权限在电脑端，手机端已移除），
// 此处「账号」指本机操作员档案 + 设备/鉴权信息展示。纯本地，离线可用。
export default function AccountManagement() {
  const { theme } = useTheme();
  const styles = makeStyles(theme);

  const [operatorName, setOperatorName] = useState('');
  const [phone, setPhone] = useState('');
  const [storeName, setStoreName] = useState('');
  const [token, setToken] = useState('');
  const [baseUrl, setBaseUrl] = useState('');

  useEffect(() => {
    (async () => {
      const profile: AccountProfile = await loadAccountProfile();
      setOperatorName(profile.operatorName);
      setPhone(profile.phone);
      setStoreName(profile.storeName);
      setBaseUrl((await loadBaseUrl()) || DEFAULT_STORE_BASE_URL);
      setToken(await getApiToken());
    })();
  }, []);

  const onSave = async () => {
    if (!operatorName.trim()) {
      Alert.alert('请填写操作员姓名', '操作员姓名用于标识本机录单归属，建议填写。');
      return;
    }
    await saveAccountProfile({ operatorName: operatorName.trim(), phone: phone.trim(), storeName: storeName.trim() });
    Alert.alert('已保存', '操作员档案已保存到本机，重启 App 仍保留。');
  };

  const onRefreshToken = async () => {
    setToken(await refreshApiToken());
  };

  return (
    <View style={styles.wrap}>
      {/* 操作员信息 */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>操作员信息</Text>
        <View style={styles.field}>
          <Text style={styles.label}>操作员姓名<Text style={styles.required}> *</Text></Text>
          <TextInput
            style={styles.input}
            value={operatorName}
            onChangeText={setOperatorName}
            placeholder="本机录单的操作员姓名"
            placeholderTextColor={theme.color.textAppTertiary}
          />
        </View>
        <View style={styles.field}>
          <Text style={styles.label}>手机号</Text>
          <TextInput
            style={styles.input}
            value={phone}
            onChangeText={setPhone}
            placeholder="选填"
            placeholderTextColor={theme.color.textAppTertiary}
            keyboardType="phone-pad"
          />
        </View>
        <View style={styles.field}>
          <Text style={styles.label}>本店名称</Text>
          <TextInput
            style={styles.input}
            value={storeName}
            onChangeText={setStoreName}
            placeholder="选填，如「利民超市」"
            placeholderTextColor={theme.color.textAppTertiary}
          />
        </View>
        <TouchableOpacity style={styles.saveBtn} onPress={onSave}>
          <Text style={styles.saveBtnText}>保存</Text>
        </TouchableOpacity>
      </View>

      {/* 账号与安全 */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>账号与安全</Text>
        <View style={styles.kv}>
          <Text style={styles.kvLabel}>设备标识</Text>
          <Text style={[styles.kvValue, { fontFamily: theme.font.family.mono }]}>{DEVICE_ID.slice(0, 12)}…</Text>
        </View>
        <View style={styles.kv}>
          <View style={styles.kvText}>
            <Text style={styles.kvLabel}>接口 Token</Text>
            <Text style={styles.kvHint}>数据同步的鉴权凭据，由店铺服务器下发</Text>
          </View>
          <TouchableOpacity style={styles.linkBtn} onPress={onRefreshToken}>
            <Text style={styles.linkBtnText}>刷新</Text>
          </TouchableOpacity>
        </View>
        <Text style={[styles.kvValue, { fontFamily: theme.font.family.mono, marginTop: theme.spaceScale[2] }]}>
          {token ? token.slice(0, 12) + '…' : '未获取（离线或尚未连接服务器）'}
        </Text>
        <View style={[styles.kv, { marginTop: theme.spaceScale[3] }]}>
          <View style={styles.kvText}>
            <Text style={styles.kvLabel}>店铺服务器</Text>
            <Text style={styles.kvHint}>修改请在「系统设置 → 同步设置」中操作</Text>
          </View>
        </View>
        <Text style={[styles.kvValue, { fontFamily: theme.font.family.mono, marginTop: theme.spaceScale[2] }]}>{baseUrl}</Text>
      </View>

      <Text style={styles.hint}>
        手机端为快捷录入端：账号即本机操作员档案，离线可录、连店铺 WiFi 自动同步。
        角色权限、账号开通等请在电脑端【系统管理】操作。
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
    field: { marginBottom: theme.spaceScale[3] },
    label: {
      fontSize: theme.font.sizeV4.caption,
      color: theme.color.textAppSecondary,
      marginBottom: theme.spaceScale[2],
    },
    required: { color: theme.color.danger },
    input: {
      backgroundColor: theme.color.surfaceSunken,
      borderWidth: 1,
      borderColor: theme.color.borderApp,
      borderRadius: theme.radius.md,
      height: S.controlLg,
      paddingHorizontal: theme.spaceScale[4],
      color: theme.color.textApp,
      fontSize: theme.font.sizeV4.body,
    },
    saveBtn: {
      marginTop: theme.spaceScale[2],
      alignSelf: 'flex-start',
      backgroundColor: theme.color.primaryVivid,
      borderRadius: theme.radius.md,
      paddingVertical: theme.spaceScale[2],
      paddingHorizontal: theme.spaceScale[6],
    },
    saveBtnText: { color: '#fff', fontSize: theme.font.sizeV4.body, fontWeight: theme.font.weight.medium },
    kv: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      minHeight: S.listRowMinH,
    },
    kvText: { flex: 1, paddingRight: theme.spaceScale[4] },
    kvLabel: {
      fontSize: theme.font.sizeV4.body,
      color: theme.color.textApp,
      fontWeight: theme.font.weight.medium,
    },
    kvHint: {
      fontSize: theme.font.sizeV4.caption,
      color: theme.color.textAppTertiary,
      marginTop: theme.spaceScale[1],
      lineHeight: 18,
    },
    kvValue: {
      fontSize: theme.font.sizeV4.body,
      color: theme.color.textAppSecondary,
    },
    linkBtn: {
      backgroundColor: theme.color.primarySoft,
      borderRadius: theme.radius.md,
      paddingVertical: theme.spaceScale[2],
      paddingHorizontal: theme.spaceScale[4],
    },
    linkBtnText: { color: theme.color.primaryVivid, fontSize: theme.font.sizeV4.body, fontWeight: theme.font.weight.medium },
    hint: { fontSize: theme.font.sizeV4.caption, color: theme.color.textAppTertiary, lineHeight: 18 },
  });
}
