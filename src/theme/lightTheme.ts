// 浅色设计令牌（派生自 Ardot 移动端视觉稿 714672723655963 / 页面 11:707）
// 浅色暖米白基线：底 #F7F2EC / 卡白 / 深灰字 / 主橙 #FF8A5C。
// 结构与原 dark theme（src/theme.ts）完全一致，仅覆盖表面 / 文字 / 图表轴等颜色；
// 语义色（收入青绿 / 进货黄铜 / 利润红）两套通用，不随明度变化。
import { theme as dark } from '../theme';

export const light = {
  ...dark,
  color: {
    ...dark.color,

    // —— 主橙刻度（浅色用 Ardot 主橙 #FF8A5C）——
    primary: '#FF8A5C',
    primaryDark: '#E0763F',
    primaryHover: '#FF9F73',
    primary800: '#E0763F',
    primaryVivid: '#FF8A5C',
    primarySoft: '#FFF1E9',
    primary50: '#FFF7F1',
    primary100: '#FFE9DC',
    primary200: '#FFD2BC',
    primary300: '#FFB191',
    primary400: '#FF9A6E',
    primary500: '#FF8A5C',
    primary900: '#C2470A',

    // —— 浅色表面 / 导航 ——
    bg: '#F7F2EC',
    bgApp: '#F7F2EC',
    surface: '#FFFFFF',
    surfaceApp: '#FFFFFF',
    surfaceRaised: '#FFFFFF',
    surfaceSunken: '#F1EAE0',
    border: 'rgba(0,0,0,0.10)',
    borderApp: 'rgba(0,0,0,0.10)',
    divider: 'rgba(0,0,0,0.06)',
    dividerApp: 'rgba(0,0,0,0.06)',
    navHoverBg: 'rgba(0,0,0,0.04)',
    navActiveBg: 'rgba(0,0,0,0.06)',
    scrim: 'rgba(0,0,0,0.40)',

    // —— 文字（浅色三档）——
    text: '#212121',
    textApp: '#212121',
    textSecondary: 'rgba(0,0,0,0.72)',
    textAppSecondary: 'rgba(0,0,0,0.72)',
    textMuted: 'rgba(0,0,0,0.55)',
    textAppTertiary: 'rgba(0,0,0,0.55)',
    textOnNavActive: '#212121',
    textOnNav: 'rgba(0,0,0,0.72)',
    textOnNavMuted: 'rgba(0,0,0,0.55)',
    navIndicator: '#FF8A5C',

    // —— 语义色（两套通用，保持原值）——
    income: '#1A6B5E',
    expense: '#8F6410',
    positive: '#0C7B4D',
    negative: '#C4322B',
    success: '#0C7B4D',
    warning: '#8F6410',
    warn: '#8F6410',
    danger: '#C4322B',
    danger500: '#C4322B',
    info: '#2563A8',
    statusPending: '#8F6410',
    statusSyncing: '#2563A8',
    statusSynced: '#0C7B4D',
    statusConflict: '#FF8A5C',
    chartRevenue: '#1A6B5E',
    chartPurchase: '#8F6410',
    chartProfit: '#0C7B4D',
    chartCash: '#1A6B5E',
    chartWechat: '#45A08A',
    chartAlipay: '#2563A8',
    chartOther: '#A39B92',
    chartGridApp: 'rgba(0,0,0,0.08)',
    chartAxisTextApp: 'rgba(0,0,0,0.55)',

    // —— CTA / Accent（浅色用 Ardot 主橙）——
    cta: '#FF8A5C',
    ctaText: '#FFFFFF',
    ctaPress: '#E0763F',
  },
};

export type LightTheme = typeof light;
