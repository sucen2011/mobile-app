// v4「Ledger Bright Ember · Mobile v1.0」暗色设计令牌
// 派生自 Web 设计系统 Ledger Bright Ember v1.2（:root 令牌，🔒 冻结）
// 手机端默认深色（复用 Web 侧栏暖暗色 nav-bg / nav-bg-2 作画布与表面）
// 硬约束：R2 主橙实心按钮每屏 ≤1、R3 卡片/列表零阴影、R5 图表禁用主橙
//          金额三件套（收入青绿/进货黄铜/利润负红）、四重编码（图标+文字+色+状态）

export const theme = {
  color: {
    // —— 主橙刻度（复用 Web，冻结）——
    primary: '#C2470A', // ★ 主橙实心按钮底色（R2 配额，仅「录单·新建进货单」）
    primaryDark: '#8A3007', // = primary-800，向后兼容旧字段名
    primaryHover: '#A63C08',
    primary800: '#8A3007',
    primaryVivid: '#F2740F', // ★ 暗色鲜艳橙：Tab 激活 icon+文字 / 冲突状态（非实心，不占 R2）
    primarySoft: '#FFF4EB', // 向后兼容旧字段
    primary50: '#FFF7F1',
    primary100: '#FFEADB',
    primary200: '#FCCEAC',
    primary300: '#F8AC77',
    primary400: '#EC6218',
    primary500: '#DB5A0A',
    primary900: '#6B2606',

    // —— 暗色表面 / 导航（复用 Web nav 暖暗色）——
    bg: '#1E1813', // App 基础画布（= nav-bg）★ 向后兼容旧字段名
    bgApp: '#1E1813',
    surface: '#2B2219', // 卡片 / 区块表面（= nav-bg-2）★ 向后兼容
    surfaceApp: '#2B2219',
    surfaceRaised: '#36301F', // 新增：暗色抬高表面（输入/Segmented 轨道激活段）
    surfaceSunken: '#18120D', // 新增：暗色内陷表面（Segmented 未激活/输入内嵌底）
    border: 'rgba(255,255,255,0.12)', // 向后兼容旧字段：暗色描边
    borderApp: 'rgba(255,255,255,0.12)',
    divider: 'rgba(255,255,255,0.08)',
    dividerApp: 'rgba(255,255,255,0.08)',
    navHoverBg: 'rgba(255,255,255,0.06)', // 列表行 / Tab 按压底色
    navActiveBg: 'rgba(255,255,255,0.10)', // 选中区块底
    scrim: 'rgba(30,24,19,0.50)', // modal / drawer 遮罩

    // —— 文字（暗色三档）——
    text: '#FFFFFF', // 主文字 ★ 向后兼容
    textApp: '#FFFFFF',
    textSecondary: 'rgba(255,255,255,0.72)',
    textAppSecondary: 'rgba(255,255,255,0.72)',
    textMuted: 'rgba(255,255,255,0.55)', // 向后兼容旧字段
    textAppTertiary: 'rgba(255,255,255,0.55)',
    textOnNavActive: '#FFFFFF',
    textOnNav: 'rgba(255,255,255,0.72)',
    textOnNavMuted: 'rgba(255,255,255,0.55)',
    navIndicator: '#F2740F', // Tab 激活指示橙

    // —— 金额三件套 / 状态语义（复用 Web，冻结）——
    income: '#1A6B5E', // 营收 / 收入（青绿）
    expense: '#8F6410', // 进货 / 支出（黄铜）
    positive: '#0C7B4D', // 利润正 / ↑（绿）
    negative: '#C4322B', // 利润负 / ↓（红）
    success: '#0C7B4D', // 已同步绿
    warning: '#8F6410', // 黄铜警示
    warn: '#8F6410',
    danger: '#C4322B', // 删除 / 危险
    danger500: '#C4322B',
    info: '#2563A8', // 同步中蓝

    // 单据状态四重编码（向后兼容别名）
    statusPending: '#8F6410', // 待同步（黄铜）
    statusSyncing: '#2563A8', // 同步中（蓝）
    statusSynced: '#0C7B4D', // 已同步（绿）
    statusConflict: '#F2740F', // 冲突（橙）

    // —— 图表（禁橙 R5，复用 Web 非橙系列）——
    chartRevenue: '#1A6B5E',
    chartPurchase: '#8F6410',
    chartProfit: '#0C7B4D',
    chartCash: '#1A6B5E',
    chartWechat: '#45A08A',
    chartAlipay: '#2563A8',
    chartOther: '#A39B92',
    chartGridApp: 'rgba(255,255,255,0.08)',
    chartAxisTextApp: 'rgba(255,255,255,0.55)',

    // —— CTA / Accent（复用 Web）——
    cta: '#C2470A',
    ctaText: '#FFFFFF',
    ctaPress: '#8A3007',
  },

  radius: { xs: 4, sm: 6, md: 8, lg: 12, xl: 16, xxl: 24, pill: 999 },

  space: (n: number) => n * 8, // 8pt 基准（向后兼容）
  spaceScale: {
    1: 4, 2: 8, 3: 12, 4: 16, 5: 20, 6: 24, 8: 32, 10: 40,
    12: 48, 16: 64, 20: 80, 24: 96, 30: 120,
  },

  font: {
    size: { xs: 12, sm: 14, md: 15, lg: 18, xl: 22, xxl: 28 }, // 向后兼容
    sizeV4: {
      display: 44, metricXl: 34, h2: 26, h3: 20, h4: 17,
      bodyLg: 17, body: 15, bodySm: 14, caption: 13, micro: 12,
      metric: 24, amount: 15,
    },
    weight: { regular: '400', medium: '500', semibold: '600', bold: '700' } as const,
    family: {
      sans: '"PingFang SC","HarmonyOS Sans SC","Source Han Sans SC","Noto Sans SC","Microsoft YaHei",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif',
      num: '"Inter","SF Pro Display",-apple-system,"PingFang SC","Helvetica Neue",Arial,sans-serif',
      mono: '"SF Mono","JetBrains Mono","Roboto Mono",ui-monospace,Menlo,Consolas,"Courier New",monospace',
    },
  },

  size: {
    tapMin: 44,
    tabbarH: 56,
    controlSm: 32,
    controlH: 40,
    controlLg: 48,
    rowH: 56, // 列表行最小高（覆盖 Web 48）
    listRowMinH: 56,
    segmentedH: 44,
    tabIcon: 24,
    photoThumb: 88,
  },

  // 阴影（R3：卡片/列表零阴影；仅 modal/toast/图片查看器浮层可用 lg）
  shadow: {
    none: { shadowColor: 'transparent', shadowOpacity: 0, shadowRadius: 0, shadowOffset: { width: 0, height: 0 }, elevation: 0 },
    card: { shadowColor: 'transparent', shadowOpacity: 0, shadowRadius: 0, shadowOffset: { width: 0, height: 0 }, elevation: 0 }, // 向后兼容：v4 零阴影
    focus: { shadowColor: '#C2470A', shadowOpacity: 0.30, shadowRadius: 4, shadowOffset: { width: 0, height: 0 }, elevation: 0 },
    lg: { shadowColor: '#000', shadowOpacity: 0.35, shadowRadius: 16, shadowOffset: { width: 0, height: 8 }, elevation: 8 },
  },

  motion: {
    easeStandard: 'cubic-bezier(0.4,0,0.2,1)',
    easeOut: 'cubic-bezier(0,0,0.2,1)',
    durFast: 120,
    durBase: 180,
    durSlow: 240,
  },

  // 安全区（RN 用 SafeAreaView；常量备查）
  safe: { top: 0, bottom: 0, left: 0, right: 0 },

  z: { sticky: 100, modal: 400, toast: 500 },
};

export type Theme = typeof theme;
