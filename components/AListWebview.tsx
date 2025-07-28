import React, {
  ForwardedRef,
  forwardRef,
  useCallback,
  useEffect, useImperativeHandle, useLayoutEffect, useRef,
  useState
} from 'react'
import {WebView} from 'react-native-webview';
import {NativeModules, View, Linking, ActivityIndicator} from "react-native";
import {useFocusEffect, useNavigation} from "expo-router";
import {useAppSelector} from "@/app/store";
import axios from "axios";
import sha256 from 'sha256'
import Toast from "react-native-root-toast";
import Ionicons from "@expo/vector-icons/Ionicons";
import {Feather} from "@expo/vector-icons";
import NoData from "@/components/NoData";

const {Alist, AppInfo} = NativeModules

const hash_salt = "https://github.com/alist-org/alist"

export function hashPwd(pwd: string) {
  return sha256(`${pwd}-${hash_salt}`)
}

interface AListWebViewProps {
  path: string;
}

export interface AListWebviewRef {
  reload: WebView['reload'];
  getCurrentUrl: () => string;
}

const AListWebview = forwardRef((props: AListWebViewProps, forwardedRef: ForwardedRef<AListWebviewRef>) => {
  const { path } = props;
  const isRunning = useAppSelector(state => state.server.isRunning)
  const webviewRef = useRef<WebView>(null)
  const navigation = useNavigation()
  const url = `http://127.0.0.1:5244${path}`
  const [injectedJS, setInjectedJS] = useState('')
  const [schemes, setSchemes] = useState([])
  const currentUrlRef = useRef(url)

  useImperativeHandle(forwardedRef, () => ({
    reload: () => {
      if (webviewRef.current) {
        webviewRef.current.reload();
      }
    },
    getCurrentUrl: () => currentUrlRef.current,
  }));

  const refreshWebToken = useCallback(async () => {
    if (isRunning) {
      try {
        const token = await Alist.getAdminToken()
        const script = `
          localStorage.setItem("token", "${token}");
          true;
        `
        // console.log('injectJavaScript', script)
        if (webviewRef.current) {
          webviewRef.current.injectJavaScript(script)
        } else {
          setInjectedJS(script)
        }
      } catch (e) {
        console.error(e)
        setInjectedJS('true')
      }
    }
  }, [isRunning])

  useLayoutEffect(() => {
    navigation.setOptions({
      headerLeft: isRunning ? () => (
        <Ionicons
          name="refresh-outline"
          size={22}
          color="white"
          onPress={() => webviewRef.current?.reload()}
          style={{ marginLeft: 16 }}
        />
      ) : null,
      headerRight: isRunning ? () => (
        <Feather
          name="external-link"
          size={22}
          color="white"
          onPress={() => Linking.openURL(currentUrlRef.current)}
          style={{ marginRight: 16 }}
        />
      ) : null
    });
  }, [isRunning, injectedJS]);

  useFocusEffect(useCallback(() => {
    refreshWebToken()
  }, [refreshWebToken]));

  useEffect(() => {
    AppInfo.getApplicationQueriesSchemes().then(setSchemes)
  }, []);

  useEffect(() => {
    setInjectedJS('');
  }, [isRunning]);

  return isRunning ? injectedJS ? (
      <WebView
        source={{ uri: url }}
        style={{ flex: 1, backgroundColor: 'transparent' }}
        ref={webviewRef}
        injectedJavaScriptBeforeContentLoaded={injectedJS}
        webviewDebuggingEnabled={true}
        originWhitelist={['*']}
        onShouldStartLoadWithRequest={request => {
          if (schemes.some(item => request.url.startsWith(`${item}:`))) {
            Linking.openURL(request.url).catch(err => {
              Toast.show('无法打开，请确认是否安装该App', {
                position: Toast.positions.CENTER,
              })
            });
            return false;
          }
          return true;
        }}
        applicationNameForUserAgent={'AListServer'}
        allowsBackForwardNavigationGestures={true}
        onNavigationStateChange={({url}) => currentUrlRef.current = url}
        onOpenWindow={({nativeEvent: {targetUrl}}) => {
          Linking.openURL(targetUrl)
        }}
        onFileDownload={({ nativeEvent: { downloadUrl } }) => {
          Linking.openURL(downloadUrl)
        }}
        onContentProcessDidTerminate={() => webviewRef.current?.reload()}
        startInLoadingState={true}
        renderLoading={() => <View/>}
        setBuiltInZoomControls={false}
      />
    ) : (
      <View style={{alignItems: 'center', justifyContent: 'center', flex: 1,}}>
        <ActivityIndicator color={'#2196F3'} size={'large'}/>
      </View>
    ) : (
    <NoData text={'请先启动服务'}/>
  );
})

export default AListWebview
