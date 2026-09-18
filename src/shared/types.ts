export type SceneId = 'general' | 'coding' | 'image'
export type EnhanceMode = 'conservative' | 'creative'
export type DisplayMode = 'txt' | 'markdown'
export type ThemeMode = 'system' | 'light' | 'dark'
export type EditorBackground = 'auto' | 'white' | 'black' | 'eye-care' | 'paper' | 'kraft'
export type EditorPattern = 'none' | 'grid-large' | 'grid-small' | 'lines' | 'waves'
export type ProviderType = 'deepseek' | 'openai' | 'openai-compatible'
export type ApiProtocol = 'chat-completions' | 'responses'
export type ReasoningEffort = 'off' | 'low' | 'medium' | 'high'
export type DockSide = 'left' | 'right' | 'top' | 'bottom' | null
export type WindowAction = 'minimize' | 'toggle-maximize' | 'close' | 'hide' | 'reset-size' | 'expand-dock'

export interface Draft {
  id: string
  content: string
  createdAt: number
  updatedAt: number
  version: number
  scene: SceneId
  modelConfigId: string | null
  displayMode: DisplayMode
  /** 本地文件路径；null 表示普通文稿，非空表示文件文稿（内容以磁盘文件为准并双写数据库） */
  filePath: string | null
}

export interface DraftSaveInput {
  id: string
  content: string
  version: number
  scene: SceneId
  modelConfigId: string | null
  displayMode: DisplayMode
}

export interface DraftSummary {
  id: string
  summary: string
  updatedAt: number
  createdAt: number
  characterCount: number
  displayMode: DisplayMode
  isCurrent: boolean
  openWindowId: string | null
  filePath: string | null
}

export interface HistoryQuery {
  search: string
  cursor: { updatedAt: number; id: string } | null
  limit: number
  currentDraftId: string
}

export interface HistoryPage {
  items: DraftSummary[]
  nextCursor: { updatedAt: number; id: string } | null
  hasMore: boolean
}

export interface ModelConfigPublic {
  id: string
  name: string
  provider: ProviderType
  apiProtocol: ApiProtocol
  baseUrl: string
  modelId: string
  timeoutMs: number
  maxTokens: number
  temperature: number | null
  reasoningEffort: ReasoningEffort
  isDefault: boolean
  hasApiKey: boolean
  createdAt: number
  updatedAt: number
}

export interface ModelConfigInput extends Omit<ModelConfigPublic, 'hasApiKey' | 'createdAt' | 'updatedAt'> {
  apiKey?: string
}

export interface AppSettings {
  theme: ThemeMode
  themeColor: string
  fontSize: number
  autoLaunch: boolean
  closeToTray: boolean
  keepTaskbarButton: boolean
  dockEnabled: boolean
  hideTaskbarWhenDocked: boolean
  hideAfterCopy: boolean
  defaultScene: SceneId
  defaultModelConfigId: string | null
  defaultDisplayMode: DisplayMode
  editorBackground: EditorBackground
  editorPattern: EditorPattern
}

export interface WindowRecord {
  id: string
  draftId: string
  x: number | null
  y: number | null
  width: number
  height: number
  displayId: string | null
  dockSide: DockSide
  isDocked: boolean
  expandedX: number | null
  expandedY: number | null
  alwaysOnTop: boolean
  fixedExpanded: boolean
  isOpen: boolean
  lastActiveAt: number
}

export interface WindowBootstrap {
  windowId: string
  draft: Draft
  settings: AppSettings
  models: ModelConfigPublic[]
  window: WindowRecord
  appVersion: string
  encryptionAvailable: boolean
}

export interface OpenDraftResult {
  activatedExistingWindow: boolean
  draft?: Draft
}

export interface DeleteDraftResult {
  deletedId: string
  replacementDraft?: Draft
}

export interface AiRequest {
  requestId: string
  windowId: string
  draftId: string
  draftVersion: number
  text: string
  scene: SceneId
  mode: EnhanceMode
  modelConfigId: string
  isSelection: boolean
  range: {
    from: number
    to: number
  }
}

export interface AiResult {
  requestId: string
  text: string
  durationMs: number
  modelName: string
  usage?: {
    inputTokens?: number
    outputTokens?: number
  }
}

export interface ConnectionTestResult {
  ok: boolean
  message: string
  durationMs: number
  modelFound?: boolean
}

export interface WindowInteractionState {
  interacting: boolean
  composing: boolean
  drawerOpen: boolean
  menuOpen: boolean
  aiPreviewOpen: boolean
}

export interface ToastPayload {
  type: 'success' | 'info' | 'warning' | 'error'
  message: string
}

export interface StorageInfo {
  path: string
  bytes: number
  formattedSize: string
}

export interface ImportDraftResult {
  canceled: boolean
  filePath?: string
  draft?: Draft
  openedInNewWindow?: boolean
}

export interface PastedImageInput {
  mimeType: string
  bytes: Uint8Array
}

export interface PastedImageResult {
  url: string
  filePath: string
  markdown: string
}

export interface SheepTextApi {
  bootstrap: (windowId: string) => Promise<WindowBootstrap>
  saveDraft: (input: DraftSaveInput) => Promise<Draft>
  /** 打开本地文件为文件文稿（新窗口）；reused 表示该文件已在窗口中打开；convertedFromGbk 表示非 UTF-8 已转换 */
  openLocalFile: (filePath: string) => Promise<{ opened: boolean; windowId: string; draft: Draft; snapshot?: { mtimeMs: number; size: number } | null; reused?: boolean; convertedFromGbk?: boolean }>
  /** 取拖入 File 对象的磁盘路径（Electron webUtils） */
  getPathForFile: (file: File) => string
  /** 检查文件文稿是否被外部修改（窗口重新聚焦时调用） */
  checkExternalChange: (draftId: string) => Promise<{ changed: boolean; missing?: boolean; path?: string }>
  /** 外部修改处理：reload=重新读磁盘，keep=内存版本覆盖磁盘 */
  resolveExternalChange: (draftId: string, action: 'reload' | 'keep', input: DraftSaveInput) => Promise<{ draft: Draft }>
  createDraft: (windowId: string) => Promise<Draft>
  openDraft: (windowId: string, draftId: string) => Promise<OpenDraftResult>
  searchHistory: (query: HistoryQuery) => Promise<HistoryPage>
  deleteDraft: (windowId: string, draftId: string) => Promise<DeleteDraftResult>
  newWindow: () => Promise<void>
  listModels: () => Promise<ModelConfigPublic[]>
  saveModel: (input: ModelConfigInput) => Promise<ModelConfigPublic[]>
  deleteModel: (id: string) => Promise<ModelConfigPublic[]>
  testModel: (input: ModelConfigInput, kind: 'connection' | 'generation') => Promise<ConnectionTestResult>
  runEnhance: (request: AiRequest) => Promise<AiResult>
  cancelEnhance: (requestId: string) => Promise<void>
  getSettings: () => Promise<AppSettings>
  saveSettings: (settings: AppSettings) => Promise<AppSettings>
  saveAs: (draft: Draft) => Promise<{ canceled: boolean; filePath?: string }>
  importFile: () => Promise<ImportDraftResult>
  savePastedImage: (draftId: string, input: PastedImageInput) => Promise<PastedImageResult>
  getStorageInfo: () => Promise<StorageInfo>
  backupData: () => Promise<{ canceled: boolean; filePath?: string }>
  exportData: () => Promise<{ canceled: boolean; filePath?: string }>
  copyText: (text: string) => Promise<void>
  copyAndHide: (windowId: string, text: string) => Promise<void>
  setAlwaysOnTop: (windowId: string, value: boolean) => Promise<void>
  setInteractionState: (windowId: string, state: WindowInteractionState) => void
  windowAction: (windowId: string, action: WindowAction) => Promise<void>
  openExternal: (url: string) => Promise<void>
  /** 在资源管理器中显示该文件（仅限本地磁盘路径） */
  showItemInFolder: (filePath: string) => Promise<void>
  onModelsChanged: (callback: (models: ModelConfigPublic[]) => void) => () => void
  onSettingsChanged: (callback: (settings: AppSettings) => void) => () => void
  onDockStateChanged: (callback: (state: { isDocked: boolean; isCollapsed: boolean; dockSide: DockSide }) => void) => () => void
  onToast: (callback: (payload: ToastPayload) => void) => () => void
  onRequestClose: (callback: () => void) => () => void
  onBeforeQuit: (callback: () => void) => () => void
  notifyFlushComplete: (windowId: string, success: boolean) => void
}



