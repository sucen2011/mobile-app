// 双主题上下文：浅色（默认，对齐 Ardot 视觉稿）/ 深色（复用原 theme.ts）。
// 屏幕通过 useTheme() 取当前主题令牌；壳层（App.tsx）已接入，
// 各业务屏在后续阶段逐个迁移到 useTheme（替换模块级 import { theme }）。
import React, { createContext, useContext, useState, useMemo, useEffect } from 'react';
import { theme as dark } from '../theme';
import { light } from './lightTheme';
import { loadThemeMode, saveThemeMode, type ThemeMode } from '../config';

export type { ThemeMode } from '../config';
export type AppTheme = typeof dark;

type ThemeContextValue = {
  mode: ThemeMode;
  theme: AppTheme;
  setMode: (m: ThemeMode) => void;
  toggleTheme: () => void;
};

const ThemeContext = createContext<ThemeContextValue>({
  mode: 'light',
  theme: light as AppTheme,
  setMode: () => {},
  toggleTheme: () => {},
});

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  // 默认浅色：以 Ardot 移动端视觉稿（visual-base-v1）为基线真相源
  const [mode, setMode] = useState<ThemeMode>('light');
  const [loaded, setLoaded] = useState(false);
  const theme = (mode === 'light' ? light : dark) as AppTheme;
  const toggleTheme = () => setMode((m) => (m === 'light' ? 'dark' : 'light'));

  // 持久化：启动读取已保存主题（避免每次重启回退浅色）
  useEffect(() => {
    let active = true;
    loadThemeMode().then((m) => {
      if (active) {
        setMode(m);
        setLoaded(true);
      }
    });
    return () => {
      active = false;
    };
  }, []);

  // 主题切换后落盘（loaded 后才写，避免首帧把浅色覆盖已保存的深色）
  useEffect(() => {
    if (loaded) saveThemeMode(mode);
  }, [mode, loaded]);

  const value = useMemo<ThemeContextValue>(
    () => ({ mode, theme, setMode, toggleTheme }),
    [mode, theme]
  );
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}
