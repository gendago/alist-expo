import {combineReducers, configureStore} from '@reduxjs/toolkit';
import log from './log';
import server from './server';
import {TypedUseSelectorHook, useDispatch, useSelector} from "react-redux";
import {
  persistReducer,
  FLUSH,
  REHYDRATE,
  PAUSE,
  PERSIST,
  PURGE,
  REGISTER,
  persistStore,
} from 'redux-persist';
import AsyncStorage from '@react-native-async-storage/async-storage';
import setting from "@/app/store/setting";

const persistConfig = {
  key: 'alist',
  storage: AsyncStorage,
  whitelist: ['setting'],
};

const reducers = combineReducers({
  log,
  server,
  setting,
});

const persistedReducer = persistReducer(persistConfig, reducers);

const store= configureStore({
  reducer: persistedReducer,
  middleware: getDefaultMiddleware =>
    getDefaultMiddleware({
      serializableCheck: {
        ignoredActions: [FLUSH, REHYDRATE, PAUSE, PERSIST, PURGE, REGISTER],
      },
    }),
});

export const persistor = persistStore(store);

export type RootState = ReturnType<typeof store.getState>
export type AppDispatch = typeof store.dispatch

export const useAppSelector: TypedUseSelectorHook<RootState> = useSelector
export const useAppDispatch = useDispatch.withTypes<AppDispatch>()

export default store
