import React, {useCallback, useState} from 'react';
import {ActivityIndicator, Linking, StyleSheet, View, useColorScheme} from 'react-native';
import {WebView, WebViewProps} from 'react-native-webview';

import Text from '@/components/ColorSchemeText';
import {Colors} from '@/constants/Colors';
import {
  isAllowedTestFlightEmbeddedURL,
  isAllowedTestFlightTopLevelURL,
} from '@/utils/testFlight';

type Props = {
  applyURL: string;
  onRecoverableError: () => void;
};

type ShouldStartLoadRequest = Parameters<
  NonNullable<WebViewProps['onShouldStartLoadWithRequest']>
>[0];

export default function TestFlightApplicationWebView({applyURL, onRecoverableError}: Props) {
  const colorScheme = useColorScheme();
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  const shouldStartLoad = useCallback((request: ShouldStartLoadRequest) => {
    // Turnstile 在受控页面内使用 Cloudflare iframe；仅允许它和本站作为子 frame。
    if (request.isTopFrame === false) {
      return isAllowedTestFlightEmbeddedURL(request.url);
    }

    if (isAllowedTestFlightTopLevelURL(request.url)) {
      return true;
    }

    // 初始凭证和后续短期 claim 都只存在于受控申请页的 fragment；外链不转发 fragment。
    if (/^https:\/\//i.test(request.url)) {
      try {
        const externalURL = new URL(request.url);
        // 防止受控页跳转时浏览器继承 fragment，把一次性 claim 带到外部站点。
        externalURL.hash = '';
        if (externalURL.username === '' && externalURL.password === '') {
          void Linking.openURL(externalURL.toString()).catch(() => undefined);
        }
      } catch {
        // 非法 URL 直接拒绝。
      }
    }
    return false;
  }, []);

  if (failed) {
    return (
      <View style={styles.messageContainer}>
        <Text style={styles.title}>申请页面加载失败</Text>
        <Text style={styles.message}>请检查网络后重新开始申请。</Text>
        <Text style={styles.action} onPress={onRecoverableError}>重新开始</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <WebView
        source={{uri: applyURL}}
        // 所有导航都交给 onShouldStartLoadWithRequest 按 top frame/subframe 裁决，
        // 否则 WebView 会在回调前拦截 Turnstile iframe，并可能绕过外链 fragment 清理。
        originWhitelist={['*']}
        onShouldStartLoadWithRequest={shouldStartLoad}
        onLoadEnd={() => setLoading(false)}
        onError={() => {
          setLoading(false);
          setFailed(true);
        }}
        onHttpError={({nativeEvent}) => {
          if (nativeEvent.statusCode >= 400) {
            setLoading(false);
            setFailed(true);
          }
        }}
        cacheEnabled={false}
        incognito
        sharedCookiesEnabled={false}
        thirdPartyCookiesEnabled={false}
        setSupportMultipleWindows={false}
        allowsLinkPreview={false}
        style={{backgroundColor: Colors[colorScheme ?? 'light'].background}}
      />
      {loading ? (
        <View
          pointerEvents="none"
          style={[
            styles.loading,
            {backgroundColor: Colors[colorScheme ?? 'light'].background},
          ]}>
          <ActivityIndicator size="large" />
          <Text style={styles.loadingText}>正在打开安全申请页面…</Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  loading: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  loadingText: {
    color: 'gray',
    marginTop: 12,
  },
  messageContainer: {
    flex: 1,
    justifyContent: 'center',
    padding: 28,
  },
  title: {
    fontSize: 20,
    fontWeight: '600',
    marginBottom: 12,
    textAlign: 'center',
  },
  message: {
    color: 'gray',
    lineHeight: 21,
    textAlign: 'center',
  },
  action: {
    color: '#2f7dd1',
    fontSize: 16,
    marginTop: 24,
    textAlign: 'center',
  },
});
