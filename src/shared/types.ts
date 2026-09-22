export type SceneId = 'general' | 'coding' | 'image'
export type EnhanceMode = 'conservative' | 'creative'
export type DisplayMode = 'txt' | 'markdown'
export type ThemeMode = 'system' | 'light' | 'dark'
export type EditorBackground = 'auto' | 'blend' | 'white' | 'black' | 'eye-care' | 'paper' | 'kraft'
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
  /** 编辑器字体族；空字符串表示使用内置默认字体栈。 */
  editorFont: string
  /** 是否启用 Markdown 行内补全（灰字）；默认关闭，由用户主动开启。 */
  completionEnabled: boolean
  /** 补全专用模型；空字符串表示沿用「默认模型」。 */
  completionModelConfigId: string
  /** 补全触发按键。 */
  completionTriggerKey: CompletionTriggerKey
  /** 自动补全：停止输入一小段时间后自动请求补全（模仿 Copilot）。 */
  completionAutoEnabled: boolean
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
  tabs: WindowTab[]
  settings: AppSettings
  models: ModelConfigPublic[]
  window: WindowRecord
  appVersion: string
  encryptionAvailable: boolean
}

/** 窗口内标签页：标题由主进程根据文件名或首行摘要生成，未保存状态由渲染层维护 */
export interface WindowTab {
  draftId: string
  title: string
  displayMode: DisplayMode
  filePath: string | null
}

export interface WindowTabsResult {
  tabs: WindowTab[]
  draft: Draft
  /** 因当前窗口标签已满而改在新窗口新建 */
  openedInNewWindow?: boolean
}

export interface TabDropResult {
  moved: boolean
  tabs?: WindowTab[]
  draft?: Draft
}

export interface OpenDraftResult {
  activatedExistingWindow: boolean
  draft?: Draft
  tabs?: WindowTab[]
  /** 因当前窗口标签已满而改在新窗口打开 */
  openedInNewWindow?: boolean
}

export interface DeleteDraftResult {
  deletedId: string
  replacementDraft?: Draft
  tabs?: WindowTab[]
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

/** 补全触发键预设。 */
export type CompletionTriggerKey = 'alt-arrow-right' | 'ctrl-arrow-right' | 'alt-slash'

/** 文件夹面板里的一个同级文件。 */
export interface LocalFileEntry {
  name: string
  path: string
  /** 是否为当前文稿对应的那个文件 */
  isCurrent: boolean
}

/** 文件夹面板的目录列表结果。 */
export interface LocalFileListResult {
  /** 当前文件所在目录的绝对路径 */
  directory: string
  entries: LocalFileEntry[]
}

/** 行内补全请求；prefix / suffix 为光标前后的文本。 */
export interface AiCompletionRequest {
  requestId: string
  windowId: string
  modelConfigId: string
  prefix: string
  suffix: string
}

/** 行内补全结果；失败时 text 为空字符串（按需求静默失败，原因记入用量统计）。 */
export interface AiCompletionResult {
  requestId: string
  text: string
}

export interface AiResult {
  requestId: string
  text: string
  durationMs: number
  modelName: string
  usage?: {
    inputTokens?: number
    outputTokens?: number
    /** 命中的上下文缓存 tokens（DeepSeek 专有）。 */
    cacheHitTokens?: number
    /** 未命中的上下文缓存 tokens；部分服务不返回该字段。 */
    cacheMissTokens?: number
  }
}

/** 用量记录的类型：文本增强 / 行内补全。 */
export type TokenUsageKind = 'enhance' | 'completion'

/** ok=正常完成；error=失败（补全静默失败也靠这里排查）。 */
export type TokenUsageStatus = 'ok' | 'error'

/** 写入一条用量记录所需的字段。 */
export interface TokenUsageInput {
  kind: TokenUsageKind
  scene: SceneId | null
  modelConfigId: string | null
  modelName: string
  promptTokens?: number
  completionTokens?: number
  cacheHitTokens?: number
  cacheMissTokens?: number
  status: TokenUsageStatus
  durationMs?: number
  errorMessage?: string | null
}

/** 用量统计的筛选条件；字段为空表示不限制。 */
export interface TokenUsageQuery {
  fromDay: string | null
  toDay: string | null
  modelConfigId: string | null
  kind: TokenUsageKind | null
}

/** 一组用量的汇总指标。 */
export interface TokenUsageSummary {
  calls: number
  promptTokens: number
  completionTokens: number
  totalTokens: number
  cacheHitTokens: number
  cacheMissTokens: number
  /** 命中率（0~1）；无缓存数据时为 null，界面显示「—」。 */
  cacheHitRate: number | null
  errorCalls: number
}

/** 按天或按模型分组的一组指标。 */
export interface TokenUsageGroup extends TokenUsageSummary {
  /** 分组键：按天为 YYYY-MM-DD，按模型为 model_config_id。 */
  key: string
  /** 展示名：日期或模型名。 */
  label: string
}

/** 统计页一次查询的完整结果。 */
export interface TokenUsageResult {
  summary: TokenUsageSummary
  byDay: TokenUsageGroup[]
  byModel: TokenUsageGroup[]
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
  openLocalFile: (filePath: string) => Promise<{ opened: boolean; windowId: string; draft: Draft; snapshot?: { mtimeMs: number; size: number } | null; reused?: boolean; convertedFromGbk?: boolean; openedInNewWindow?: boolean }>
  /** 取拖入 File 对象的磁盘路径（Electron webUtils） */
  getPathForFile: (file: File) => string
  /** 检查文件文稿是否被外部修改（窗口重新聚焦时调用） */
  checkExternalChange: (draftId: string) => Promise<{ changed: boolean; missing?: boolean; path?: string }>
  /** 读取本地文件文稿所在目录的同级 txt/md 文件（文件夹面板用） */
  listDirectoryFiles: (draftId: string) => Promise<LocalFileListResult>
  /** 外部修改处理：reload=重新读磁盘，keep=内存版本覆盖磁盘 */
  resolveExternalChange: (draftId: string, action: 'reload' | 'keep', input: DraftSaveInput) => Promise<{ draft: Draft }>
  createDraft: (windowId: string) => Promise<Draft>
  openDraft: (windowId: string, draftId: string) => Promise<OpenDraftResult>
  /** 新建标签页（新建空白文稿并在当前窗口打开） */
  newTab: (windowId: string) => Promise<WindowTabsResult>
  /** 读取当前窗口的标签列表与活动文稿 */
  windowTabs: (windowId: string) => Promise<WindowTabsResult>
  // U08/U09：跨窗口拖动标签与拖出成新窗口
  beginTabDrag: (windowId: string, draftId: string) => Promise<void>
  endTabDrag: (windowId: string) => Promise<void>
  dropTab: (windowId: string, position: number | null) => Promise<TabDropResult>
  detachTab: (windowId: string) => Promise<{ detached: boolean }>
  /** 其他窗口移走/移入标签后，本窗口的标签列表变化通知 */
  onTabsChanged: (callback: (state: WindowTabsResult) => void) => () => void
  /** 关闭标签页；关闭最后一个时自动补一个空白文稿 */
  closeTab: (windowId: string, draftId: string) => Promise<WindowTabsResult>
  /** 切换当前标签页 */
  activateTab: (windowId: string, draftId: string) => Promise<WindowTabsResult>
  /** 拖动排序后保存标签顺序 */
  reorderTabs: (windowId: string, orderedDraftIds: string[]) => Promise<WindowTab[]>
  searchHistory: (query: HistoryQuery) => Promise<HistoryPage>
  deleteDraft: (windowId: string, draftId: string) => Promise<DeleteDraftResult>
  newWindow: () => Promise<void>
  listModels: () => Promise<ModelConfigPublic[]>
  saveModel: (input: ModelConfigInput) => Promise<ModelConfigPublic[]>
  deleteModel: (id: string) => Promise<ModelConfigPublic[]>
  testModel: (input: ModelConfigInput, kind: 'connection' | 'generation') => Promise<ConnectionTestResult>
  runEnhance: (request: AiRequest) => Promise<AiResult>
  cancelEnhance: (requestId: string) => Promise<void>
  runCompletion: (request: AiCompletionRequest) => Promise<AiCompletionResult>
  cancelCompletion: (requestId: string) => Promise<void>
  queryTokenUsage: (query: TokenUsageQuery) => Promise<TokenUsageResult>
  clearTokenUsage: () => Promise<void>
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



