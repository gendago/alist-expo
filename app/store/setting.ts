import {createSlice} from '@reduxjs/toolkit';
import {NativeModules} from "react-native";

const {Alist} = NativeModules;

export enum LibType {
  AList = 0,
  OpenList = 1,
}
type SettingState = { backgroundMode: boolean; autoRun: boolean; iCloudSync: boolean; autoStopHours: number; libType: LibType;}

export const settingSlice = createSlice({
  name: 'setting',
  initialState: {
    backgroundMode: false,
    autoRun: false,
    iCloudSync: false,
    autoStopHours: 0,
    libType: LibType.AList,
  } satisfies SettingState as SettingState,
  reducers: {
    setBackgroundMode(state, {payload}) {
      state.backgroundMode = payload;
    },
    setAutoRun(state, {payload}) {
      state.autoRun = payload;
    },
    setICloudSync(state, {payload}) {
      state.iCloudSync = payload;
      Alist.iCloudSwitch(payload)
    },
    setAutoStopHours(state, {payload}) {
      state.autoStopHours = payload;
      Alist.setAutoStopHours(payload)
    },
    setLibType(state, {payload}) {
      state.libType = payload;
    },
  },
});

export const {
  setBackgroundMode,
  setAutoRun,
  setICloudSync,
  setAutoStopHours,
  setLibType,
} = settingSlice.actions;

export default settingSlice.reducer;
