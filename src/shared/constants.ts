import type { AppSettings, SceneId } from './types'

/**
 * 旧版默认主题色。饱和度偏高，与软件的暖中性配色不协调，
 * 仅用于把“从未改过主题色”的用户平滑迁移到新的默认值。
 */
export const LEGACY_DEFAULT_THEME_COLOR = '#6958cf'

/** 旧版默认背景纹理；仅用于把从未改过该选项的用户迁到新的默认值“无纹理”。 */
export const LEGACY_DEFAULT_EDITOR_PATTERN = 'grid-large'

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'system',
  // 比旧值降低约 13% 饱和度（同色相、同明度），更贴合当前界面的柔和质感
  themeColor: '#6958bb',
  fontSize: 17,
  autoLaunch: false,
  closeToTray: true,
  keepTaskbarButton: true,
  dockEnabled: true,
  hideTaskbarWhenDocked: false,
  hideAfterCopy: false,
  defaultScene: 'general',
  defaultModelConfigId: null,
  defaultDisplayMode: 'txt',
  editorBackground: 'auto',
  // 默认不铺纹理，保持干净底色；需要时可到设置里换成方格、横线等
  editorPattern: 'none',
  // 空字符串表示沿用内置字体栈，用户可在设置里换成自己电脑中的字体
  editorFont: ''
}

export const SCENE_LABELS: Record<SceneId, string> = {
  general: '通用',
  coding: '编程',
  image: '生图'
}

export const HISTORY_PAGE_SIZE = 30
export const SAVE_DEBOUNCE_MS = 500
// 单个窗口的标签上限，超出后新建与打开均改为开新窗口
export const MAX_WINDOW_TABS = 8
export const WINDOW_MIN_WIDTH = 520
export const WINDOW_MIN_HEIGHT = 460
export const WINDOW_DEFAULT_WIDTH = 860
export const WINDOW_DEFAULT_HEIGHT = 680
export const DOCK_THRESHOLD = 18
export const DOCK_VISIBLE_SIZE = 8
export const DOCK_EXPAND_DELAY = 120
export const DOCK_COLLAPSE_DELAY = 260
