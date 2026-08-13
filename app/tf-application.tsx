import Ionicons from '@expo/vector-icons/Ionicons';
import {Stack} from 'expo-router';
import React, {useCallback, useEffect, useState} from 'react';
import {
  ActivityIndicator,
  NativeModules,
  StyleSheet,
  TouchableOpacity,
  View,
  useColorScheme,
} from 'react-native';

import TestFlightApplicationWebView from '@/components/TestFlightApplicationWebView';
import Text from '@/components/ColorSchemeText';
import {Colors} from '@/constants/Colors';
import {
  buildTestFlightApplicationURL,
  isTestFlightAutomaticApplicationSupported,
} from '@/utils/testFlight';
import type {TestFlightCredentialDisplayInfo} from '@/utils/testFlight';

type PageState =
  | {kind: 'loading'}
  | {kind: 'web'; applicationURL: string}
  | {kind: 'unavailable'};

const eligibility = NativeModules.TestFlightEligibility as {
  getCredentialDisplayInfo?: () => Promise<TestFlightCredentialDisplayInfo>;
};

export default function TestFlightApplication() {
  const colorScheme = useColorScheme();
  const [state, setState] = useState<PageState>({kind: 'loading'});

  const loadCredential = useCallback(async () => {
    setState({kind: 'loading'});
    if (
      !isTestFlightAutomaticApplicationSupported() ||
      typeof eligibility?.getCredentialDisplayInfo !== 'function'
    ) {
      setState({kind: 'unavailable'});
      return;
    }

    try {
      // 凭证只在内存和 URL fragment 中短暂存在，不写入路由参数、日志或本地存储。
      const result = await eligibility.getCredentialDisplayInfo();
      const applicationURL = buildTestFlightApplicationURL(result?.credentialId);
      setState(applicationURL ? {kind: 'web', applicationURL} : {kind: 'unavailable'});
    } catch {
      setState({kind: 'unavailable'});
    }
  }, []);

  useEffect(() => {
    void loadCredential();
  }, [loadCredential]);

  if (state.kind === 'web') {
    return (
      <>
        <Stack.Screen
          options={{
            title: '申请 TestFlight',
            headerBackTitleVisible: false,
          }}
        />
        <TestFlightApplicationWebView
          applyURL={state.applicationURL}
          onRecoverableError={() => void loadCredential()}
        />
      </>
    );
  }

  const backgroundColor = Colors[colorScheme ?? 'light'].background;
  return (
    <View style={[styles.container, {backgroundColor}]}>
      <Stack.Screen
        options={{
          title: '申请 TestFlight',
          headerBackTitleVisible: false,
        }}
      />
      {state.kind === 'loading' ? (
        <View style={styles.centered}>
          <View style={styles.loadingIcon}>
            <ActivityIndicator color="#1677ff" size="large" />
          </View>
          <Text style={styles.loadingTitle}>正在获取凭证信息</Text>
          <Text style={styles.loadingDescription}>验证成功后将自动打开申请页面</Text>
        </View>
      ) : (
        <View style={styles.centered}>
          <View style={styles.iconHalo}>
            <View style={styles.iconCircle}>
              <Ionicons name="cloud-download-outline" color="#1677ff" size={54} />
            </View>
          </View>
          <Text style={styles.title}>未获取到凭证信息</Text>
          <Text style={styles.description}>请从商店下载最新版本</Text>
          <View style={styles.versionCard}>
            <Text style={styles.versionHeading}>且使用正确的系统版本：</Text>
            <View style={styles.versionRow}>
              <Ionicons name="phone-portrait-outline" color="#1677ff" size={21} />
              <Text style={styles.versionText}>iOS ≥ 16.0</Text>
            </View>
            <View style={styles.versionRow}>
              <Ionicons name="tv-outline" color="#1677ff" size={21} />
              <Text style={styles.versionText}>tvOS ≥ 16.0</Text>
            </View>
          </View>
          <TouchableOpacity
            accessibilityRole="button"
            onPress={loadCredential}
            style={styles.retryButton}>
            <Ionicons name="refresh-outline" color="#1677ff" size={18} />
            <Text style={styles.retryText}>重新获取</Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {flex: 1},
  centered: {
    alignItems: 'center',
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: 30,
    paddingBottom: 42,
  },
  loadingIcon: {
    alignItems: 'center',
    backgroundColor: 'rgba(22, 119, 255, 0.10)',
    borderRadius: 36,
    height: 72,
    justifyContent: 'center',
    marginBottom: 22,
    width: 72,
  },
  loadingTitle: {fontSize: 20, fontWeight: '600', marginBottom: 8},
  loadingDescription: {color: 'gray', fontSize: 14},
  iconHalo: {
    alignItems: 'center',
    backgroundColor: 'rgba(22, 119, 255, 0.07)',
    borderRadius: 64,
    height: 128,
    justifyContent: 'center',
    marginBottom: 26,
    width: 128,
  },
  iconCircle: {
    alignItems: 'center',
    backgroundColor: 'rgba(22, 119, 255, 0.12)',
    borderColor: 'rgba(22, 119, 255, 0.18)',
    borderRadius: 46,
    borderWidth: 1,
    height: 92,
    justifyContent: 'center',
    width: 92,
  },
  title: {fontSize: 23, fontWeight: '700', marginBottom: 9, textAlign: 'center'},
  description: {color: 'gray', fontSize: 16, lineHeight: 23, textAlign: 'center'},
  versionCard: {
    backgroundColor: 'rgba(128, 128, 128, 0.08)',
    borderColor: 'rgba(128, 128, 128, 0.18)',
    borderRadius: 16,
    borderWidth: 1,
    marginTop: 26,
    paddingHorizontal: 22,
    paddingVertical: 18,
    width: '100%',
  },
  versionHeading: {color: 'gray', fontSize: 14, marginBottom: 13, textAlign: 'center'},
  versionRow: {alignItems: 'center', flexDirection: 'row', justifyContent: 'center', marginVertical: 6},
  versionText: {fontSize: 16, fontWeight: '600', marginLeft: 10, minWidth: 105},
  retryButton: {
    alignItems: 'center',
    flexDirection: 'row',
    marginTop: 22,
    minHeight: 44,
    paddingHorizontal: 18,
  },
  retryText: {color: '#1677ff', fontSize: 15, fontWeight: '600', marginLeft: 6},
});
