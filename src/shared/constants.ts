import type { AppSettings, SceneId } from './types'

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'system',
  themeColor: '#6958cf',
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
  defaultMarkdownView: 'split',
  editorBackground: 'auto',
  editorPattern: 'grid-large',
  showLineNumbers: false
}

export const SCENE_LABELS: Record<SceneId, string> = {
  general: '通用',
  coding: '编程',
  image: '生图'
}

export const HISTORY_PAGE_SIZE = 30
export const SAVE_DEBOUNCE_MS = 500
export const WINDOW_MIN_WIDTH = 520
export const WINDOW_MIN_HEIGHT = 460
export const WINDOW_DEFAULT_WIDTH = 860
export const WINDOW_DEFAULT_HEIGHT = 680
export const DOCK_THRESHOLD = 18
export const DOCK_VISIBLE_SIZE = 8
export const DOCK_EXPAND_DELAY = 120
export const DOCK_COLLAPSE_DELAY = 260
