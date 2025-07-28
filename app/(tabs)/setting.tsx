import {
  StyleSheet,
  View,
  Switch,
  TouchableOpacity,
  Modal,
  Linking, TouchableWithoutFeedback, NativeModules, useColorScheme, ActivityIndicator, ScrollView, Alert
} from 'react-native';
import Ionicons from "@expo/vector-icons/Ionicons";
import React, {useCallback, useEffect, useState} from "react";
import {FontAwesome} from "@expo/vector-icons";
import {useAppDispatch, useAppSelector} from "@/app/store";
import {LibType, setAutoRun, setAutoStopHours, setBackgroundMode, setICloudSync, setLibType} from "@/app/store/setting";
import ColorSchemeCard from "@/components/ColorSchemeCard";
import Text from '@/components/ColorSchemeText'
import {Colors} from "@/constants/Colors";
import Toast from "react-native-root-toast";

const { AppInfo, NotificationManager, Alist } = NativeModules;

export default function Setting() {
  const [modalVisible, setModalVisible] = useState(false);
  const [version, setVersion] = useState('1.0')
  const [alistVersion, setAlistVersion] = useState('dev')
  const [openListVersion, setOpenListVersion] = useState('dev')
  const backgroundMode = useAppSelector(state => state.setting.backgroundMode)
  const autoRun = useAppSelector(state => state.setting.autoRun)
  const iCloudSync = useAppSelector(state => state.setting.iCloudSync)
  const autoStopHours = useAppSelector(state => state.setting.autoStopHours) || 0
  const libType = useAppSelector(state => state.setting.libType) || LibType.AList
  const dispatch = useAppDispatch()
  const colorScheme = useColorScheme()
  const [iCloudBackupLoading, setCloudBackupLoading] = useState<boolean>(false)
  const [userRecordId, setUserRecordId] = useState(null)
  console.log('libType', libType)

  const showAbout = useCallback(() => {
    setModalVisible(true)
  }, [setModalVisible])

  const getAppVersion = useCallback(async () => {
    try {
      const version = await AppInfo.getAppVersion();
      setVersion(version)
    } catch (error) {
      console.error(error);
    }
  }, []);

  const getAListVersion = useCallback(async () => {
    try {
      const version = await Alist.getAListVersion();
      setAlistVersion(version)
    } catch (error) {
      console.error(error);
    }
  }, []);

  const getOpenListVersion = useCallback(async () => {
    try {
      const version = await Alist.getOpenListVersion();
      setOpenListVersion(version)
    } catch (error) {
      console.error(error);
    }
  }, []);

  const iCloudSwitchChange = useCallback(async (value: boolean) => {
    if (value) {
      setCloudBackupLoading(true)
      try {
        try {
          // 先尝试恢复
          await Alist.iCloudRestore()
          Toast.show("已将iCloud数据同步至本地", {
            position: Toast.positions.CENTER
          })
        } catch (e) {
          // 恢复失败再尝试备份
          console.error(e)
          await Alist.iCloudBackup()
          Toast.show("已将本地数据同步至iCloud", {
            position: Toast.positions.CENTER
          })
        }
        dispatch(setICloudSync(true))
      } catch (e: any) {
        Toast.show(e?.message ?? "iCloud同步开启失败", {
          position: Toast.positions.CENTER
        })
      }
      setCloudBackupLoading(false)
    } else {
      dispatch(setICloudSync(false))
    }
  }, [setCloudBackupLoading, dispatch])

  const switchLibType = useCallback(() => {
    const newLibType = libType === LibType.AList ? LibType.OpenList : LibType.AList
    const newLibTypeText = {[LibType.AList]: `AList`, [LibType.OpenList]: `OpenList`}[newLibType]
    Alert.alert(`切换至${newLibTypeText}`, `不同内核数据不互通\n切换后将自动退出App，请手动重启`, [
      {
        text: '取消',
        style: 'cancel',
      },
      {text: '确认切换', onPress: async () => {
        await Alist.setLibType(newLibType)
        dispatch(setLibType(newLibType))
        setTimeout(() => {
          Alist.exit()
        }, 250)
      }},
    ]);

  }, [libType, alistVersion, openListVersion, iCloudSync])

  useEffect(() => {
    getAppVersion()
  }, [getAppVersion]);

  useEffect(() => {
    getAListVersion()
  }, [getAListVersion]);

  useEffect(() => {
    getOpenListVersion()
  }, [getOpenListVersion]);

  useEffect(() => {
    NativeModules?.CloudKitManager?.getUserRecordID?.()
      .then(setUserRecordId)
  }, []);

  return (
    <View style={styles.container}>
      <ScrollView showsVerticalScrollIndicator={false}>
        <Text style={styles.cardTitle}>通用</Text>
        <ColorSchemeCard>
          <View style={[styles.cardItem, styles.cardItemLarge]}>
            <View>
              <Text style={styles.itemTitle}>后台运行</Text>
              <Text style={styles.itemDescription}>开启后服务常驻后台，息屏也可访问服务</Text>
            </View>
            <Switch
              trackColor={{false: '#767577', true: '#81b0ff'}}
              ios_backgroundColor="#3e3e3e"
              onValueChange={(value) => {
                dispatch(setBackgroundMode(value))
              }}
              value={backgroundMode}
            />
          </View>
          {backgroundMode && (
            <View style={[styles.cardItem, styles.cardItemLarge]}>
              <View>
                <Text style={styles.itemTitle}>自动停止</Text>
                <Text style={styles.itemDescription}>X小时未使用时自动停止服务</Text>
              </View>
              <TouchableOpacity onPress={() => {
                Alert.prompt(
                  '自动停止时间',
                  '建议设置为4\n因为单集影视通常不超过4小时\n如设置为0代表不自动停止',
                  (text) => {
                    if (/^\d+$/.test(text)) {
                      dispatch(setAutoStopHours(Number(text)))
                    } else {
                      Alert.alert('请输入数字', '代表X小时未使用时自动停止服务', [
                        {
                          text: '确定',
                          style: 'cancel',
                        },
                      ]);
                    }
                  },
                  'plain-text',
                  '4',
                  'number-pad'
                );
              }}>
                <View style={{flexDirection: 'row', alignItems: 'center'}}>
                  <Text style={{color: 'gray'}}>{autoStopHours === 0 ? '不停止' : `${autoStopHours}小时`}</Text>
                  <Ionicons
                    name={'chevron-forward-outline'}
                    color={'#D1D1D6'}
                    containerStyle={{ alignSelf: 'center' }}
                    size={16}
                  />
                </View>
              </TouchableOpacity>
            </View>
          )}
          <View style={[styles.cardItem, styles.cardItemLarge]}>
            <View>
              <Text style={styles.itemTitle}>自动运行</Text>
              <Text style={styles.itemDescription}>App冷启动时自动启动服务</Text>
            </View>
            <Switch
                trackColor={{false: '#767577', true: '#81b0ff'}}
                ios_backgroundColor="#3e3e3e"
                onValueChange={(value) => {
                  if (value) {
                    NotificationManager.requestAuthorization()
                  }
                  dispatch(setAutoRun(value))
                }}
                value={autoRun}
            />
          </View>
          {userRecordId ? (
              <View style={[styles.cardItem, styles.cardItemLarge]}>
                  <View>
                      <View style={{flexDirection: 'row'}}>
                        <Text style={styles.itemTitle}>iCloud同步</Text>
                        {iCloudSync && <Ionicons name={'sync'} size={16} style={{marginLeft: 4}} onPress={() => iCloudSwitchChange(true)} color={'#D1D1D6'}/>}
                      </View>
                      <Text style={styles.itemDescription}>{userRecordId}</Text>
                  </View>
                  {userRecordId ? iCloudBackupLoading ?  <ActivityIndicator style={{marginRight: 16}}/> : (
                      <Switch
                          trackColor={{false: '#767577', true: '#81b0ff'}}
                          ios_backgroundColor="#3e3e3e"
                          onValueChange={iCloudSwitchChange}
                          value={iCloudSync || iCloudBackupLoading}
                      />
                  ) : null}
              </View>
          ) : null}
        </ColorSchemeCard>
        <Text style={[styles.cardTitle, styles.cardMarginTop]}>版本信息</Text>
        <ColorSchemeCard>
          <View style={styles.cardItem}>
            <Text style={styles.itemTitle}>App版本</Text>
            <Text>{version}</Text>
          </View>
          <TouchableOpacity onPress={switchLibType}>
            <View style={[styles.cardItem, styles.cardItemLarge]}>
              <View>
                <Text style={styles.itemTitle}>内核版本</Text>
                <Text style={styles.itemDescription}>点击切换至{libType === LibType.AList ? `OpenList@${openListVersion}` : `AList@${alistVersion}`}</Text>
              </View>
              <Text>{libType === LibType.AList ? `AList@${alistVersion}` : `OpenList@${openListVersion}`}</Text>
            </View>
          </TouchableOpacity>
        </ColorSchemeCard>
        <Text style={[styles.cardTitle, styles.cardMarginTop]}>关于</Text>
        <ColorSchemeCard>
          <TouchableOpacity onPress={showAbout}>
            <View style={styles.cardItem}>
                <Text style={styles.itemTitle}>关于</Text>
                <Ionicons
                  name={'chevron-forward-outline'}
                  color={'#D1D1D6'}
                  containerStyle={{ alignSelf: 'center' }}
                  size={16}
                />
            </View>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => Linking.openURL('https://alist-server.notion.site/AListServer-3dc08df0909f45a3a54c3624119ffaed')}>
            <View style={styles.cardItem}>
              <Text style={styles.itemTitle}>常见问题</Text>
              <Ionicons
                name={'chevron-forward-outline'}
                color={'#D1D1D6'}
                containerStyle={{ alignSelf: 'center' }}
                size={16}
              />
            </View>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => Linking.openURL('https://t.me/+3BR_rxBF8LxmNGY1')}>
            <View style={styles.cardItem}>
              <Text style={styles.itemTitle}>加入交流群</Text>
              <FontAwesome name="telegram" size={24} color="#24a1de" />
            </View>
          </TouchableOpacity>
        </ColorSchemeCard>
      </ScrollView>
      <Modal
        animationType="fade"
        transparent={true}
        visible={modalVisible}
      >
        <TouchableWithoutFeedback onPress={() => setModalVisible(!modalVisible)}>
          <View style={styles.centeredView}>
            <View style={[styles.modalView, {backgroundColor: Colors[colorScheme ?? 'light'].background}]}>
              <Text style={styles.modalText}>本应用遵循AGPL3.0开源协议</Text>
              <TouchableOpacity onPress={() => Linking.openURL('https://github.com/gendago/alist-expo')}>
                <Text style={styles.modalText}>alist-expo</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => Linking.openURL('https://github.com/gendago/alist-ios')}>
                <Text style={styles.modalText}>alist-ios</Text>
              </TouchableOpacity>
            </View>
          </View>
        </TouchableWithoutFeedback>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  titleContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  stepContainer: {
    gap: 8,
    marginBottom: 8,
  },
  reactLogo: {
    height: 178,
    width: 290,
    bottom: 0,
    left: 0,
    position: 'absolute',
  },
  container: {
    paddingHorizontal: 16,
    paddingVertical: 16,
    flex: 1,
  },
  cardTitle: {
    color: 'gray',
    fontSize: 14,
    textAlign: 'left',
    marginBottom: 12,
    paddingLeft: 14,
  },
  cardItem: {
    display: 'flex',
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    height: 50,
  },
  cardItemLarge: {
    height: 65,
  },
  cardItemBorderBottom: {
    borderBottomWidth: 1,
    borderBottomColor: 'rgb(228, 228, 228)',
  },
  cardMarginTop: {
    marginTop: 24,
  },
  bold: {
    fontWeight: 'bold',
  },
  centeredView: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.8)'
  },
  modalView: {
    margin: 20,
    backgroundColor: 'white',
    borderRadius: 20,
    padding: 50,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: {
      width: 0,
      height: 2,
    },
    shadowOpacity: 0.25,
    shadowRadius: 4,
    elevation: 5,
  },
  button: {
    borderRadius: 20,
    padding: 10,
    elevation: 2,
  },
  buttonOpen: {
    backgroundColor: '#F194FF',
  },
  buttonClose: {
    backgroundColor: '#2196F3',
  },
  textStyle: {
    color: 'white',
    fontWeight: 'bold',
    textAlign: 'center',
  },
  modalText: {
    marginBottom: 15,
    textAlign: 'center',
  },
  itemTitle: {
    fontSize: 15,
  },
  itemDescription: {
    fontSize: 12,
    color: 'gray',
    marginTop: 4,
  }
});
