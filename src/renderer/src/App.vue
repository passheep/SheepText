<script setup lang="ts">
import {
  ChevronDown, ClipboardPaste, Code2, Copy, FileDown, FilePlus2, FolderOpen,
  History, Image, Maximize2, MessageSquareText, Minus, PanelTop, Pin, Plus,
  RefreshCw, Save, Settings as SettingsIcon, Sparkles, Text, WandSparkles, X
} from '@lucide/vue'
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { HISTORY_PAGE_SIZE, SAVE_DEBOUNCE_MS, SCENE_LABELS } from '../../shared/constants'
import type {
  AiRequest, AiResult, AppSettings, Draft, DraftSaveInput, DraftSummary, EnhanceMode, ModelConfigPublic,
  DockSide, SceneId, TabDropResult, ToastPayload, WindowBootstrap, WindowInteractionState, WindowTab, WindowTabsResult
} from '../../shared/types'
import AiResultPanel from './components/AiResultPanel.vue'
import type { SelectOption } from './components/BaseSelect.vue'
import BaseButton from './components/BaseButton.vue'
import FolderPanel from './components/FolderPanel.vue'
import HistoryDrawer from './components/HistoryDrawer.vue'
import IconButton from './components/IconButton.vue'
import MilkdownEditor from './components/MilkdownEditor.vue'
import { draftTabTitle } from '../../shared/draft-title'
import SettingsPanel from './components/SettingsPanel.vue'
import TabBar from './components/TabBar.vue'
import TextEditor from './components/TextEditor.vue'
import appIcon from './assets/app-icon.png'

type EditorExpose = {
  focus: () => void
  replaceRange: (from: number, to: number, text: string, replaceWholeDocument?: boolean) => void
  undoOnce: () => boolean
  redoOnce: () => boolean
  setScrollRatio: (ratio: number) => void
  openSearch: () => void
  clearPasteFormat: (from: number, to: number) => boolean
  clearCompletion: () => boolean
  acceptCompletion: () => boolean
}

// 粘贴格式临时操作区状态：记录本次粘贴范围，超时或新编辑后失效
type PasteNotice = {
  draftId: string
  displayMode: 'txt' | 'markdown'
  range: { from: number; to: number }
  cleared: boolean
}

// F17 外部修改对话框状态
const externalConflict = ref<{ draftId: string; path: string; missing: boolean } | null>(null)
const externalResolving = ref(false)
let externalChecking = false

// 窗口重新聚焦时检查文件是否被外部修改（仅文件文稿）
/** 窗口失焦时丢弃灰字与在途补全请求。 */
function clearEditorCompletion(): void {
  editor.value?.clearCompletion()
}

async function checkExternalOnFocus(): Promise<void> {
  if (externalChecking || !draft.value?.filePath || externalConflict.value) return
  const target = draft.value
  externalChecking = true
  try {
    const result = await window.sheepText.checkExternalChange(target.id)
    if (result.changed && draft.value?.id === target.id) {
      if (saveTimer) { clearTimeout(saveTimer); saveTimer = null }
      externalConflict.value = { draftId: target.id, path: result.path ?? target.filePath!, missing: Boolean(result.missing) }
      saveState.value = 'error'
      saveError.value = '本地文件发生变化，等待确认后继续保存'
    }
  } catch (error) {
    showToast({ type: 'error', message: '文件状态检查失败：' + cleanError(error) })
  } finally {
    externalChecking = false
  }
}

// 外部修改处理：重新加载磁盘内容或用内存版本覆盖
async function resolveExternal(action: 'reload' | 'keep'): Promise<void> {
  const conflict = externalConflict.value
  if (!conflict || externalResolving.value || draft.value?.id !== conflict.draftId) return
  externalResolving.value = true
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null }
  try {
    // 等待已发出的保存返回，再传递当前内存正文，不能用数据库旧正文覆盖文件。
    if (saveInFlight) await saveInFlight
    const input = draftSaveSnapshot(draft.value!)
    const result = await window.sheepText.resolveExternalChange(conflict.draftId, action, input)
    if (draft.value?.id !== conflict.draftId) return
    const editedDuringRequest = draft.value.version !== input.version
    externalConflict.value = null
    if (editedDuringRequest) {
      // 保留请求期间的新编辑，使用新版本再次保存，避免异步回填覆盖输入。
      draft.value.version = Math.max(draft.value.version, result.draft.version + 1)
      lastSavedVersion.value = result.draft.version
      externalResolving.value = false
      scheduleSave()
    } else {
      setCurrentDraft(result.draft)
    }
    closeAiPanel()
    showToast({ type: 'success', message: action === 'reload' ? '已重新加载磁盘内容' : '已保存当前窗口内容' })
  } catch (error) {
    showToast({ type: 'error', message: cleanError(error) })
  } finally {
    externalResolving.value = false
  }
}

// 普通对象快照避免 Vue 响应式代理跨 IPC，同时保留未保存的正文与版本。
function draftSaveSnapshot(value: Draft): DraftSaveInput {
  return { id: value.id, content: value.content, version: value.version, scene: value.scene, modelConfigId: value.modelConfigId, displayMode: value.displayMode }
}
const pasteNotice = ref<PasteNotice | null>(null)
let pasteNoticeTimer: ReturnType<typeof setTimeout> | null = null
const PASTE_NOTICE_MS = 5000

function clearPasteNoticeTimer(): void {
  if (pasteNoticeTimer) { clearTimeout(pasteNoticeTimer); pasteNoticeTimer = null }
}

function hidePasteNotice(): void {
  clearPasteNoticeTimer()
  pasteNotice.value = null
}

// 补全提示条：灰字出现时在底部提示「按 → 采用」，也可以直接点按钮
const completionNotice = ref<{ preview: string } | null>(null)

function onCompletionChange(state: { active: boolean; preview: string }): void {
  completionNotice.value = state.active ? { preview: state.preview } : null
}

function acceptCompletion(): void {
  if (editor.value?.acceptCompletion()) completionNotice.value = null
}

function dismissCompletion(): void {
  editor.value?.clearCompletion()
  completionNotice.value = null
}

function onPasted(range: { from: number; to: number }, text: string): void {
  if (!draft.value || !text.trim() || range.to <= range.from) {
    hidePasteNotice()
    return
  }
  pasteNotice.value = {
    draftId: draft.value.id,
    displayMode: draft.value.displayMode,
    range,
    cleared: false
  }
  clearPasteNoticeTimer()
  pasteNoticeTimer = setTimeout(hidePasteNotice, PASTE_NOTICE_MS)
}

// 清除本次粘贴内容的 Markdown 格式标记（方案 B：转为可读正文）
function clearPastedFormat(): void {
  const notice = pasteNotice.value
  if (!notice || !draft.value || notice.cleared) return
  if (notice.draftId !== draft.value.id || notice.displayMode !== draft.value.displayMode) {
    hidePasteNotice()
    return
  }
  if (editor.value?.clearPasteFormat(notice.range.from, notice.range.to)) {
    pasteNotice.value = { ...notice, cleared: true }
    clearPasteNoticeTimer()
    pasteNoticeTimer = setTimeout(hidePasteNotice, PASTE_NOTICE_MS)
  } else {
    hidePasteNotice()
  }
}

function keepPastedFormat(): void {
  hidePasteNotice()
}

// “更多新建方式”弹层：延迟关闭兜底，给鼠标穿过按钮与菜单间隙的时间
let newMenuCloseTimer: ReturnType<typeof setTimeout> | null = null
function openNewMenu(): void {
  if (newMenuCloseTimer) { clearTimeout(newMenuCloseTimer); newMenuCloseTimer = null }
  newMenuOpen.value = true
}
function scheduleNewMenuClose(): void {
  if (newMenuCloseTimer) clearTimeout(newMenuCloseTimer)
  newMenuCloseTimer = setTimeout(() => { newMenuOpen.value = false }, 180)
}

// 鼠标悬停后离开，重新计时自动隐藏
function startPasteNoticeTimer(): void {
  clearPasteNoticeTimer()
  pasteNoticeTimer = setTimeout(hidePasteNotice, PASTE_NOTICE_MS)
}

type RequestSnapshot = {
  draftId: string
  version: number
  content: string
  range: { from: number; to: number }
  text: string
  scene: SceneId
  mode: EnhanceMode
  modelConfigId: string
  isSelection: boolean
  editorKind: 'text' | 'milkdown'
}

type AiPanelState = {
  open: boolean
  loading: boolean
  requestId: string
  result: string
  error: string
  conflict: boolean
  modelName: string
  durationMs: number
  snapshot: RequestSnapshot | null
}

const windowId = new URLSearchParams(location.search).get('windowId') ?? ''
const booting = ref(true)
const draft = ref<Draft | null>(null)
const settings = ref<AppSettings | null>(null)
const models = ref<ModelConfigPublic[]>([])
const appVersion = ref('0.5.2')
const encryptionAvailable = ref(true)
const editor = ref<EditorExpose | null>(null)
const tabBar = ref<{ revealActive: () => Promise<void> } | null>(null)
// 当前窗口的标签页；主进程只同步列表与活动文稿，未保存内容由渲染层负责
const tabs = ref<WindowTab[]>([])
const editorFocused = ref(false)
const outlineHeld = ref(false)
const isComposing = ref(false)
const selection = reactive({ from: 0, to: 0, text: '' })
const saveState = ref<'saved' | 'saving' | 'error'>('saved')
const saveError = ref('')
const lastSavedVersion = ref(0)
const alwaysOnTop = ref(false)
const isDocked = ref(false)
const dockSide = ref<DockSide>(null)
const isCollapsed = ref(false)
const folderOpen = ref(false)
// 点击后常驻；未常驻时鼠标移开自动收起（与右上角大纲按钮同一套交互）
const folderPinned = ref(false)
const folderPanelRef = ref<InstanceType<typeof FolderPanel> | null>(null)
let folderCloseTimer: ReturnType<typeof setTimeout> | null = null
const historyOpen = ref(false)
const historyPinned = ref(false)
const historyHeld = ref(false)
const historySearch = ref('')
const historyItems = ref<DraftSummary[]>([])
const historyLoading = ref(false)
const historyHasMore = ref(true)
const historyCursor = ref<{ updatedAt: number; id: string } | null>(null)
const settingsOpen = ref(false)
const settingsTab = ref<'general' | 'models' | 'shortcuts' | 'storage' | 'about'>('general')
const newMenuOpen = ref(false)
const sceneMenuOpen = ref(false)
const openSelectCount = ref(0)
let settingsSaveTimer: ReturnType<typeof setTimeout> | null = null
const toast = ref<(ToastPayload & { id: number }) | null>(null)
const closing = ref(false)
const ai = reactive<AiPanelState>({
  open: false,
  loading: false,
  requestId: '',
  result: '',
  error: '',
  conflict: false,
  modelName: '',
  durationMs: 0,
  snapshot: null
})

let saveTimer: ReturnType<typeof setTimeout> | null = null
let saveInFlight: Promise<boolean> | null = null
let historyOpenTimer: ReturnType<typeof setTimeout> | null = null
let historyCloseTimer: ReturnType<typeof setTimeout> | null = null
let historyRequestSequence = 0
let toastTimer: ReturnType<typeof setTimeout> | null = null
const unsubscribers: Array<() => void> = []

const sceneOptions: SelectOption[] = [
  { value: 'general', label: '通用', description: '说明、计划与日常表达' },
  { value: 'coding', label: '编程', description: '需求、错误与代码任务' },
  { value: 'image', label: '生图', description: '主体、构图、光线与风格' }
]

const hasSelection = computed(() => selection.to > selection.from)
const validSelectionLength = computed(() => hasSelection.value ? selection.text.trim().length : 0)
const characterCount = computed(() => draft.value?.content.length ?? 0)
const currentEditorKind = computed<'text' | 'milkdown'>(() =>
  draft.value?.displayMode === 'markdown' ? 'milkdown' : 'text'
)
const themeAttribute = computed(() => settings.value?.theme ?? 'system')
const themeStyle = computed(() => {
  const color = settings.value?.themeColor ?? '#6958bb'
  return {
    '--primary': color,
    '--primary-strong': color,
    '--primary-soft': `color-mix(in srgb, ${color} 14%, transparent)`,
    '--selection': `color-mix(in srgb, ${color} 22%, transparent)`
  }
})
const editorSurfaceClass = computed(() => [
  `editor-bg-${settings.value?.editorBackground ?? 'auto'}`,
  `editor-pattern-${settings.value?.editorPattern ?? 'none'}`
])
const hasDefaultModel = computed(() => Boolean(settings.value?.defaultModelConfigId))
const aiRangeLabel = computed(() => {
  const snapshot = ai.snapshot
  if (!snapshot) return '全文'
  return snapshot.isSelection ? `选区 ${snapshot.text.length} 字` : '全文'
})
// 文件拖入期间保持窗口展开，避免停靠窗口在操作中收起。
const dragFileActive = ref(false)
let dragFileDepth = 0
const interactionState = computed<WindowInteractionState>(() => ({
  interacting: editorFocused.value,
  composing: isComposing.value,
  drawerOpen: historyOpen.value,
  menuOpen: newMenuOpen.value || sceneMenuOpen.value || openSelectCount.value > 0 || settingsOpen.value || Boolean(pasteNotice.value) || dragFileActive.value || Boolean(externalConflict.value) || outlineHeld.value || folderOpen.value,
  aiPreviewOpen: ai.open
}))

// F15 拖拽文件到窗口打开：仅接管文件，不影响编辑器文本和块拖动。

function isFileDrag(event: DragEvent): boolean {
  return [...(event.dataTransfer?.types ?? [])].includes('Files')
}

function handleDragEnter(event: DragEvent): void {
  if (!isFileDrag(event)) return
  event.preventDefault()
  dragFileDepth += 1
  dragFileActive.value = true
}

function handleDragOver(event: DragEvent): void {
  if (!isFileDrag(event)) return
  event.preventDefault()
  // 文件由窗口统一打开，避免编辑器先接管拖放。
  event.stopPropagation()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
}

function handleDragLeave(event: DragEvent): void {
  if (!isFileDrag(event)) return
  dragFileDepth = Math.max(0, dragFileDepth - 1)
  if (dragFileDepth === 0) dragFileActive.value = false
}

/**
 * 在当前窗口打开本地文件作为新标签（拖入、文件夹面板共用）。
 * 标签已满时主进程会开新窗口；文件已在其他窗口打开时主进程会激活那个窗口。
 */
async function openLocalFileInWindow(path: string): Promise<void> {
  try {
    const result = await window.sheepText.openLocalFile(path)
    if (result.convertedFromGbk) showToast({ type: 'info', message: '文件原为 GBK 编码，已按 UTF-8 打开，保存时将转换' })
    if (result.openedInNewWindow === false) {
      const state = await window.sheepText.windowTabs(windowId)
      tabs.value = state.tabs
      setCurrentDraft(state.draft)
      await nextTick()
      await tabBar.value?.revealActive()
      return
    }
    // reused：文件已在其他窗口打开，主进程已把那个窗口激活，这里不提示
    if (result.reused) return
    showToast({ type: 'info', message: '当前窗口标签已满，已在新窗口打开文件' })
  } catch (error) {
    showToast({ type: 'error', message: cleanError(error) })
  }
}

// 文件夹面板：悬停临时展开，点击固定，再次点击取消并收起（与右上角大纲一致）
function handleFolderEnter(): void {
  if (folderCloseTimer) { clearTimeout(folderCloseTimer); folderCloseTimer = null }
  const wasOpen = folderOpen.value
  folderOpen.value = true
  // 已经展开时再次悬停（例如刚在资源管理器里新建了文件）也重读一次目录；
  // 首次展开由组件的 onMounted 自己加载。
  if (wasOpen) void folderPanelRef.value?.refresh()
}

function handleFolderLeave(): void {
  if (folderCloseTimer) clearTimeout(folderCloseTimer)
  if (folderPinned.value) return
  folderCloseTimer = setTimeout(() => { folderOpen.value = false }, 220)
}

function toggleFolderPinned(): void {
  if (folderPinned.value) closeFolder()
  else { folderPinned.value = true; handleFolderEnter() }
}

function closeFolder(): void {
  if (folderCloseTimer) clearTimeout(folderCloseTimer)
  folderPinned.value = false
  folderOpen.value = false
}

async function handleFileDrop(event: DragEvent): Promise<void> {
  if (!isFileDrag(event)) return
  event.preventDefault()
  event.stopPropagation()
  dragFileDepth = 0
  dragFileActive.value = false
  // 在事件有效期内读取全部路径，后续逐个异步打开。
  const paths: string[] = []
  for (const file of [...(event.dataTransfer?.files ?? [])]) {
    try {
      const path = window.sheepText.getPathForFile(file)
      if (!path) throw new Error('无法获取拖入文件的路径')
      if (!paths.includes(path)) paths.push(path)
    } catch (error) {
      showToast({ type: 'error', message: cleanError(error) })
    }
  }
  for (const path of paths) await openLocalFileInWindow(path)
}

onMounted(async () => {
  try {
    const bootstrap = await window.sheepText.bootstrap(windowId)
    applyBootstrap(bootstrap)
    registerEvents()
    // 订阅完成后再对齐一次标签：主进程可能在 bootstrap 快照与订阅之间打开新标签
    // （例如右键一次打开多个文件），错过那一次通知也不会漏掉状态。
    await window.sheepText.windowTabs(windowId).then((state) => {
      tabs.value = state.tabs
      if (draft.value?.id !== state.draft.id) setCurrentDraft(state.draft)
    }).catch(() => undefined)
    await checkExternalOnFocus()
    await nextTick()
    window.addEventListener('focus', checkExternalOnFocus)
    window.addEventListener('blur', clearEditorCompletion)
    window.addEventListener('keydown', handleGlobalShortcut, true)
    document.addEventListener('pointerdown', handleOutsidePointerDown, true)
    // F15 拖拽文件打开：窗口级监听，阻止浏览器默认行为
    window.addEventListener('dragenter', handleDragEnter, true)
    window.addEventListener('dragover', handleDragOver, true)
    window.addEventListener('dragleave', handleDragLeave, true)
    window.addEventListener('drop', handleFileDrop, true)
    editor.value?.focus()
  } catch (error) {
    showToast({ type: 'error', message: cleanError(error) })
  } finally {
    booting.value = false
  }
})

onBeforeUnmount(() => {
  hidePasteNotice()
  if (saveTimer) clearTimeout(saveTimer)
  if (toastTimer) clearTimeout(toastTimer)
  if (settingsSaveTimer) clearTimeout(settingsSaveTimer)
  window.removeEventListener('focus', checkExternalOnFocus)
  if (newMenuCloseTimer) clearTimeout(newMenuCloseTimer)
  window.removeEventListener('keydown', handleGlobalShortcut, true)
  document.removeEventListener('pointerdown', handleOutsidePointerDown, true)
  window.removeEventListener('dragenter', handleDragEnter, true)
  window.removeEventListener('dragover', handleDragOver, true)
  window.removeEventListener('dragleave', handleDragLeave, true)
  window.removeEventListener('drop', handleFileDrop, true)
  unsubscribers.forEach((unsubscribe) => unsubscribe())
})

watch(() => [draft.value?.id, draft.value?.displayMode], hidePasteNotice)
// 切到非本地文件文稿时收起文件夹面板，避免下次打开本地文件时莫名弹开
watch(() => draft.value?.filePath, (path) => { if (!path) closeFolder() })
watch(interactionState, (state) => window.sheepText.setInteractionState(windowId, state), { deep: true })
// 普通文稿的标签标题取正文首行，编辑时同步刷新，避免标签长期停在“空白文稿”。
// 标题规则与主进程共用 draftTabTitle，保证下次标签操作时两边结果一致。
watch(() => draft.value?.content, (content) => {
  const current = draft.value
  if (!current || current.filePath) return
  const index = tabs.value.findIndex((tab) => tab.draftId === current.id)
  if (index < 0) return
  const title = draftTabTitle({ filePath: null, content: content ?? '' })
  if (tabs.value[index].title !== title) {
    tabs.value = tabs.value.map((tab, i) => (i === index ? { ...tab, title } : tab))
  }
})

watch(historyOpen, (open) => {
  if (open) void loadHistory(true)
})
watch(historySearch, () => {
  if (historyOpen.value) void loadHistory(true)
})

function applyBootstrap(bootstrap: WindowBootstrap): void {
  draft.value = bootstrap.draft
  tabs.value = bootstrap.tabs ?? []
  settings.value = bootstrap.settings
  models.value = bootstrap.models
  appVersion.value = bootstrap.appVersion
  encryptionAvailable.value = bootstrap.encryptionAvailable
  lastSavedVersion.value = bootstrap.draft.version
  alwaysOnTop.value = bootstrap.window.alwaysOnTop
  isDocked.value = bootstrap.window.isDocked
  dockSide.value = bootstrap.window.dockSide
  applyTheme()
}

function registerEvents(): void {
  unsubscribers.push(
    window.sheepText.onModelsChanged((value) => {
      models.value = value
      if (draft.value?.modelConfigId && !value.some((model) => model.id === draft.value?.modelConfigId)) {
        draft.value.modelConfigId = null
        bumpVersionAndSave()
      }
    }),
    window.sheepText.onSettingsChanged((value) => {
      settings.value = value
      applyTheme()
    }),
    window.sheepText.onDockStateChanged((value) => {
      isDocked.value = value.isDocked
      dockSide.value = value.dockSide
      isCollapsed.value = value.isCollapsed
    }),
    window.sheepText.onToast(showToast),
    // U08：其他窗口移走/移入标签后同步本窗口标签栏
    window.sheepText.onTabsChanged((state) => {
      tabs.value = state.tabs
      if (draft.value?.id !== state.draft.id) setCurrentDraft(state.draft)
    }),
    window.sheepText.onRequestClose(() => void requestClose()),
    window.sheepText.onBeforeQuit(() => void flushBeforeQuit())
  )
}

function applyTheme(): void {
  const color = settings.value?.themeColor ?? '#6958bb'
  document.documentElement.dataset.theme = settings.value?.theme ?? 'system'
  // 编辑器字体：留空则沿用内置字体栈，否则把用户选的字体放在最前面
  const family = (settings.value?.editorFont ?? '').trim().replace(/['"\\]/g, '')
  const editorFont = family ? `'${family}', var(--font-editor-default)` : 'var(--font-editor-default)'
  document.documentElement.style.setProperty('--font-editor', editorFont)
  document.documentElement.style.setProperty('--primary', color)
  document.documentElement.style.setProperty('--primary-strong', color)
  document.documentElement.style.setProperty('--primary-soft', 'color-mix(in srgb, ' + color + ' 14%, transparent)')
  document.documentElement.style.setProperty('--selection', 'color-mix(in srgb, ' + color + ' 22%, transparent)')
  const root = document.querySelector<HTMLElement>('.app-root')
  root?.style.setProperty('--font-editor', editorFont)
  root?.style.setProperty('--primary', color)
  root?.style.setProperty('--primary-strong', color)
  root?.style.setProperty('--primary-soft', 'color-mix(in srgb, ' + color + ' 14%, transparent)')
  root?.style.setProperty('--selection', 'color-mix(in srgb, ' + color + ' 22%, transparent)')
}

function onFontSizeChange(size: number): void {
  if (!settings.value || settings.value.fontSize === size) return
  settings.value = { ...settings.value, fontSize: size }
  if (settingsSaveTimer) clearTimeout(settingsSaveTimer)
  settingsSaveTimer = setTimeout(async () => {
    if (!settings.value) return
    try {
      settings.value = await window.sheepText.saveSettings(createSettingsSnapshot(settings.value))
    } catch (error) {
      showToast({ type: 'error', message: '字号保存失败：' + cleanError(error) })
    }
  }, 450)
}

function createSettingsSnapshot(source: AppSettings): AppSettings {
  return {
    theme: source.theme,
    themeColor: String(source.themeColor),
    fontSize: Number(source.fontSize),
    autoLaunch: Boolean(source.autoLaunch),
    closeToTray: Boolean(source.closeToTray),
    keepTaskbarButton: Boolean(source.keepTaskbarButton),
    dockEnabled: Boolean(source.dockEnabled),
    hideTaskbarWhenDocked: Boolean(source.hideTaskbarWhenDocked),
    hideAfterCopy: false,
    defaultScene: source.defaultScene,
    defaultModelConfigId: source.defaultModelConfigId ? String(source.defaultModelConfigId) : null,
    defaultDisplayMode: source.defaultDisplayMode,
    editorBackground: source.editorBackground,
    editorPattern: source.editorPattern,
    editorFont: String(source.editorFont ?? ''),
    completionEnabled: Boolean(source.completionEnabled),
    completionModelConfigId: String(source.completionModelConfigId ?? ''),
    completionTriggerKey: source.completionTriggerKey,
    completionAutoEnabled: Boolean(source.completionAutoEnabled)
  }
}

/** 补全模型：未单独指定时回退到「默认模型」；两者都为空时返回空串（上层据此提示）。 */
const completionModelId = computed(() => {
  const current = settings.value
  if (!current?.completionEnabled) return ''
  return String(current.completionModelConfigId || current.defaultModelConfigId || '')
})

function onContentChanged(content: string): void {
  if (!draft.value || draft.value.content === content) return
  hidePasteNotice()
  draft.value.content = content
  draft.value.version += 1
  scheduleSave()
  if (historyOpen.value) scheduleHistoryRefresh()
}

function onSelectionChanged(value: { from: number; to: number; text: string }): void {
  Object.assign(selection, value)
}

function bumpVersionAndSave(): void {
  if (!draft.value) return
  draft.value.version += 1
  scheduleSave()
}

function scheduleSave(delay = SAVE_DEBOUNCE_MS): void {
  if (externalConflict.value || externalResolving.value) return
  saveState.value = 'saving'
  saveError.value = ''
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => void flushSave(), delay)
}

async function flushSave(): Promise<boolean> {
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  if (saveInFlight) await saveInFlight
  if (externalConflict.value || externalResolving.value) return false
  if (!draft.value || draft.value.version <= lastSavedVersion.value) {
    saveState.value = 'saved'
    return true
  }

  const target = { ...draft.value }
  saveState.value = 'saving'
  const operation = window.sheepText.saveDraft({
    id: target.id,
    content: target.content,
    version: target.version,
    scene: target.scene,
    modelConfigId: target.modelConfigId,
    displayMode: target.displayMode
  }).then((saved) => {
    if (draft.value?.id === saved.id) {
      lastSavedVersion.value = Math.max(lastSavedVersion.value, saved.version)
      draft.value.updatedAt = saved.updatedAt
      if (draft.value.version === saved.version) saveState.value = 'saved'
      else scheduleSave(40)
    }
    return true
  }).catch((error) => {
    saveState.value = 'error'
    saveError.value = cleanError(error)
    showToast({ type: 'error', message: `自动保存失败：${saveError.value}` })
    if (draft.value?.filePath) void checkExternalOnFocus()
    return false
  }).finally(() => {
    if (saveInFlight === operation) saveInFlight = null
  })
  saveInFlight = operation
  return operation
}

async function createDraft(): Promise<void> {
  newMenuOpen.value = false
  if (!await flushSave()) return
  try {
    const result = await window.sheepText.newTab(windowId)
    // U05：标签已达上限时主进程改为开新窗口，当前窗口保持原样
    if (result.openedInNewWindow) {
      showToast({ type: 'info', message: '当前窗口已有 8 个标签，已在新窗口新建文稿' })
      return
    }
    tabs.value = result.tabs
    setCurrentDraft(result.draft)
    closeHistory()
    closeAiPanel()
    await nextTick()
    await tabBar.value?.revealActive()
    editor.value?.focus()
    showToast({ type: 'success', message: '已新建标签页，原文稿保留在历史中' })
  } catch (error) {
    showToast({ type: 'error', message: cleanError(error) })
  }
}

// 主进程只同步标签列表与活动文稿；当前文稿的未保存内容仍由渲染层掌握
function applyTabs(result: WindowTabsResult): void {
  tabs.value = result.tabs
  if (draft.value?.id !== result.draft.id) setCurrentDraft(result.draft)
}

async function switchTab(draftId: string): Promise<void> {
  if (!draft.value || draftId === draft.value.id) return
  if (!await flushSave()) return
  try {
    applyTabs(await window.sheepText.activateTab(windowId, draftId))
    closeAiPanel()
    await nextTick()
    await tabBar.value?.revealActive()
    editor.value?.focus()
  } catch (error) {
    showToast({ type: 'error', message: cleanError(error) })
  }
}

async function closeTab(draftId: string): Promise<void> {
  // 关闭当前标签前先保存，避免未落库内容丢失
  if (draft.value?.id === draftId && !await flushSave()) return
  try {
    applyTabs(await window.sheepText.closeTab(windowId, draftId))
    closeAiPanel()
    await nextTick()
    await tabBar.value?.revealActive()
    editor.value?.focus()
  } catch (error) {
    showToast({ type: 'error', message: cleanError(error) })
  }
}

async function reorderTabs(orderedDraftIds: string[]): Promise<void> {
  try {
    tabs.value = await window.sheepText.reorderTabs(windowId, orderedDraftIds)
  } catch (error) {
    showToast({ type: 'error', message: cleanError(error) })
  }
}

// ---------- U08/U09：跨窗口拖动标签与拖出成新窗口 ----------
const TAB_DRAG_TYPE = 'application/x-sheeptext-tab'

function isTabDrag(event: DragEvent): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes(TAB_DRAG_TYPE)
}

function beginTabDrag(draftId: string): void {
  void window.sheepText.beginTabDrag(windowId, draftId)
}

/** 落点结果同步：移入的标签会成为本窗口活动标签。 */
function applyTabDrop(result: TabDropResult): void {
  if (!result.moved) {
    showToast({ type: 'info', message: '目标窗口已有 8 个标签，无法移入该标签' })
    return
  }
  if (result.tabs && result.draft) {
    tabs.value = result.tabs
    if (draft.value?.id !== result.draft.id) setCurrentDraft(result.draft)
  }
}

async function handleTabDragEnd(dropped: boolean, screenX: number, screenY: number): Promise<void> {
  // 落在其他窗口时由对方 drop 处理；落在本窗口内则是普通排序。
  if (dropped) return
  // 指针仍在窗口矩形内：视为取消拖动（例如按 Esc），只清理登记。
  const insideWindow = screenX >= window.screenX && screenX <= window.screenX + window.outerWidth
    && screenY >= window.screenY && screenY <= window.screenY + window.outerHeight
  if (insideWindow) {
    void window.sheepText.endTabDrag(windowId)
    return
  }
  try {
    const result = await window.sheepText.detachTab(windowId)
    if (result.detached) showToast({ type: 'success', message: '已把该标签拖出为新窗口' })
  } catch (error) {
    showToast({ type: 'error', message: cleanError(error) })
  }
}

/** 拖到窗口正文区域（非标签栏）：追加到标签末尾。 */
function onWorkspaceDragOver(event: DragEvent): void {
  if (!isTabDrag(event)) return
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
}

async function onWorkspaceDrop(event: DragEvent): Promise<void> {
  if (!isTabDrag(event)) return
  event.preventDefault()
  try {
    applyTabDrop(await window.sheepText.dropTab(windowId, null))
  } catch (error) {
    showToast({ type: 'error', message: cleanError(error) })
  }
}

/** 拖到标签栏：按落点位置插入。 */
async function onTabCrossDrop(position: number | null): Promise<void> {
  try {
    applyTabDrop(await window.sheepText.dropTab(windowId, position))
  } catch (error) {
    showToast({ type: 'error', message: cleanError(error) })
  }
}

async function cycleTab(direction: number): Promise<void> {
  if (!draft.value || tabs.value.length < 2) return
  const index = tabs.value.findIndex((tab) => tab.draftId === draft.value?.id)
  if (index < 0) return
  await switchTab(tabs.value[(index + direction + tabs.value.length) % tabs.value.length].draftId)
}

async function createWindow(): Promise<void> {
  newMenuOpen.value = false
  if (!await flushSave()) return
  try {
    await window.sheepText.newWindow()
  } catch (error) {
    showToast({ type: 'error', message: cleanError(error) })
  }
}


async function importFile(): Promise<void> {
  newMenuOpen.value = false
  if (!await flushSave()) return
  try {
    const result = await window.sheepText.importFile()
    if (result.canceled || !result.draft) return
    closeHistory()
    if (result.openedInNewWindow) {
      showToast({ type: 'success', message: '已在新窗口打开本地文件，编辑后自动同步保存' })
      return
    }
    // U07：菜单打开的文件同样优先作为当前窗口的新标签
    const state = await window.sheepText.windowTabs(windowId)
    tabs.value = state.tabs
    setCurrentDraft(state.draft)
    closeAiPanel()
    await nextTick()
    await tabBar.value?.revealActive()
    editor.value?.focus()
    showToast({ type: 'success', message: '已作为新标签打开本地文件，编辑后自动同步保存' })
  } catch (error) {
    showToast({ type: 'error', message: '打开文件失败：' + cleanError(error) })
  }
}

function handleOutsidePointerDown(event: PointerEvent): void {
  const target = event.target as HTMLElement
  if (newMenuOpen.value && !target.closest('.new-draft-group')) newMenuOpen.value = false
  if (sceneMenuOpen.value && !target.closest('.scene-control')) sceneMenuOpen.value = false
}

function handleGlobalShortcut(event: KeyboardEvent): void {
  if (externalConflict.value || externalResolving.value) return
  if (!event.ctrlKey || event.altKey) return
  const key = event.key.toLowerCase()
  if (key === 'n') {
    event.preventDefault()
    if (event.shiftKey) void createWindow()
    else void createDraft()
    return
  }
  // 标签页快捷键：新建、关闭、循环切换
  if (key === 't' && !event.shiftKey) {
    event.preventDefault()
    void createDraft()
    return
  }
  if (key === 'w' && !event.shiftKey) {
    event.preventDefault()
    if (draft.value) void closeTab(draft.value.id)
    return
  }
  if (key === 'tab') {
    event.preventDefault()
    void cycleTab(event.shiftKey ? -1 : 1)
    return
  }
  if (key === 'f' && !event.shiftKey) {
    event.preventDefault()
    if (settingsOpen.value) return
    editor.value?.clearCompletion()
    void nextTick(() => editor.value?.openSearch())
  }
}

function expandDockRail(): void {
  void window.sheepText.windowAction(windowId, 'expand-dock')
}

async function selectHistory(id: string): Promise<void> {
  if (id === draft.value?.id) {
    closeHistory()
    editor.value?.focus()
    return
  }
  // 已在当前窗口标签中则直接切换，不再请求打开
  if (tabs.value.some((tab) => tab.draftId === id)) {
    closeHistory()
    await switchTab(id)
    return
  }
  if (!await flushSave()) return
  try {
    const result = await window.sheepText.openDraft(windowId, id)
    if (result.activatedExistingWindow) {
      showToast({ type: 'info', message: '该文稿已在另一个窗口中打开' })
      return
    }
    if (result.tabs) tabs.value = result.tabs
    if (result.openedInNewWindow) {
      showToast({ type: 'info', message: '当前窗口标签已满，已在新窗口打开该文稿' })
      return
    }
    if (result.draft) {
      setCurrentDraft(result.draft)
      closeHistory()
      closeAiPanel()
      await nextTick()
      await tabBar.value?.revealActive()
      editor.value?.focus()
    }
  } catch (error) {
    showToast({ type: 'error', message: cleanError(error) })
  }
}

function setCurrentDraft(value: Draft): void {
  draft.value = value
  lastSavedVersion.value = value.version
  saveState.value = 'saved'
  saveError.value = ''
  externalConflict.value = null
  Object.assign(selection, { from: 0, to: 0, text: '' })
}

async function loadHistory(reset: boolean): Promise<void> {
  if (!draft.value || historyLoading.value && !reset) return
  const sequence = ++historyRequestSequence
  if (reset) {
    historyItems.value = []
    historyCursor.value = null
    historyHasMore.value = true
  }
  historyLoading.value = true
  try {
    const page = await window.sheepText.searchHistory({
      search: historySearch.value,
      cursor: historyCursor.value,
      limit: HISTORY_PAGE_SIZE,
      currentDraftId: draft.value.id
    })
    if (sequence !== historyRequestSequence) return
    const merged = reset ? page.items : [...historyItems.value, ...page.items]
    historyItems.value = [...new Map(merged.map((item) => [item.id, item])).values()]
    historyCursor.value = page.nextCursor
    historyHasMore.value = page.hasMore
  } catch (error) {
    if (sequence === historyRequestSequence) showToast({ type: 'error', message: `历史加载失败：${cleanError(error)}` })
  } finally {
    if (sequence === historyRequestSequence) historyLoading.value = false
  }
}

function scheduleHistoryRefresh(): void {
  setTimeout(() => {
    if (historyOpen.value && !historyLoading.value) void loadHistory(true)
  }, 700)
}

function onHistoryTriggerEnter(): void {
  if (historyCloseTimer) clearTimeout(historyCloseTimer)
  historyOpenTimer = setTimeout(() => { historyOpen.value = true }, 250)
}

function onHistoryTriggerLeave(): void {
  if (historyOpenTimer) clearTimeout(historyOpenTimer)
  scheduleHistoryClose()
}

function toggleHistoryByClick(): void {
  if (historyOpen.value && historyPinned.value) {
    historyPinned.value = false
    historyOpen.value = false
    return
  }
  historyPinned.value = true
  historyOpen.value = true
}

function closeHistory(): void {
  historyPinned.value = false
  historyOpen.value = false
}

function setHistoryHold(value: boolean): void {
  historyHeld.value = value
  if (value && historyCloseTimer) clearTimeout(historyCloseTimer)
  if (!value) scheduleHistoryClose()
}

function scheduleHistoryClose(): void {
  if (historyHeld.value || historyPinned.value) return
  if (historyCloseTimer) clearTimeout(historyCloseTimer)
  historyCloseTimer = setTimeout(() => {
    if (!historyHeld.value) historyOpen.value = false
  }, 340)
}

async function deleteHistory(id: string): Promise<void> {
  try {
    const result = await window.sheepText.deleteDraft(windowId, id)
    historyItems.value = historyItems.value.filter((item) => item.id !== id)
    // 被删文稿可能正占着一个标签，用主进程返回的最新标签列表同步
    if (result.tabs) tabs.value = result.tabs
    else tabs.value = tabs.value.filter((tab) => tab.draftId !== id)
    if (result.replacementDraft) {
      setCurrentDraft(result.replacementDraft)
      closeAiPanel()
      await nextTick()
      await tabBar.value?.revealActive()
      editor.value?.focus()
    }
    showToast({ type: 'success', message: '文稿已删除' })
    if (historyOpen.value) void loadHistory(true)
  } catch (error) {
    showToast({ type: 'error', message: '删除失败：' + cleanError(error) })
  }
}

function setScene(value: string): void {
  sceneMenuOpen.value = false
  if (!draft.value || draft.value.scene === value) return
  draft.value.scene = value as SceneId
  bumpVersionAndSave()
}

function setDisplayMode(value: 'txt' | 'markdown'): void {
  if (!draft.value || draft.value.displayMode === value) return
  draft.value.displayMode = value
  bumpVersionAndSave()
  nextTick(() => editor.value?.focus())
}

function trackSelectOpen(open: boolean): void {
  openSelectCount.value = Math.max(0, openSelectCount.value + (open ? 1 : -1))
}

function openSettings(tab: 'general' | 'models' | 'shortcuts' | 'storage' | 'about' = 'general'): void {
  settingsTab.value = tab
  settingsOpen.value = true
  // 打开设置会盖住编辑区，先丢弃灰字与在途补全
  editor.value?.clearCompletion()
  newMenuOpen.value = false
  sceneMenuOpen.value = false
}

async function runEnhance(mode: EnhanceMode, reuse?: RequestSnapshot): Promise<void> {
  if (!draft.value) return
  if (isComposing.value) {
    showToast({ type: 'warning', message: '请先完成当前中文输入，再使用 AI 增强' })
    return
  }
  // AI 结果面板即将打开，灰字与补全请求先让位
  editor.value?.clearCompletion()
  const modelConfigId = reuse?.modelConfigId ?? draft.value.modelConfigId ?? settings.value?.defaultModelConfigId ?? models.value.find((model) => model.isDefault)?.id ?? models.value[0]?.id ?? null
  if (!modelConfigId || !models.value.some((model) => model.id === modelConfigId)) {
    showToast({ type: 'info', message: '先配置并选择一个可用模型' })
    openSettings('models')
    return
  }

  let snapshot: RequestSnapshot
  if (reuse) {
    snapshot = reuse
  } else {
    if (hasSelection.value && !validSelectionLength.value) {
      showToast({ type: 'warning', message: '选区只有空白字符，请选择有效文字' })
      return
    }
    const range = hasSelection.value ? { from: selection.from, to: selection.to } : { from: 0, to: draft.value.content.length }
    snapshot = {
      draftId: draft.value.id,
      version: draft.value.version,
      content: draft.value.content,
      range,
      text: hasSelection.value ? selection.text : draft.value.content,
      scene: draft.value.scene,
      mode,
      modelConfigId,
      isSelection: hasSelection.value,
      editorKind: currentEditorKind.value
    }
  }
  if (!snapshot.text.trim()) {
    showToast({ type: 'warning', message: '先写点内容，再使用 AI 增强' })
    return
  }

  const requestId = crypto.randomUUID()
  Object.assign(ai, {
    open: true,
    loading: true,
    requestId,
    result: '',
    error: '',
    conflict: false,
    modelName: models.value.find((model) => model.id === snapshot.modelConfigId)?.name ?? '',
    durationMs: 0,
    snapshot
  })

  const request: AiRequest = {
    requestId,
    windowId,
    draftId: snapshot.draftId,
    draftVersion: snapshot.version,
    text: snapshot.text,
    scene: snapshot.scene,
    mode: snapshot.mode,
    modelConfigId: snapshot.modelConfigId,
    isSelection: snapshot.isSelection,
    range: snapshot.range
  }

  try {
    const result: AiResult = await window.sheepText.runEnhance(request)
    if (ai.requestId !== requestId) return
    ai.loading = false
    ai.result = result.text
    ai.durationMs = result.durationMs
    ai.modelName = result.modelName
    ai.conflict = draft.value.id !== snapshot.draftId || draft.value.version !== snapshot.version
      || (snapshot.isSelection && snapshot.editorKind !== currentEditorKind.value)
  } catch (error) {
    if (ai.requestId !== requestId) return
    ai.loading = false
    ai.error = cleanError(error)
  }
}

function adoptAiResult(): void {
  if (!ai.snapshot || ai.conflict || !ai.result) return
  if (ai.snapshot.isSelection && ai.snapshot.editorKind !== currentEditorKind.value) {
    ai.conflict = true
    showToast({ type: 'warning', message: '编辑方式已切换，请重新选择文字后再采用结果' })
    return
  }
  editor.value?.replaceRange(ai.snapshot.range.from, ai.snapshot.range.to, ai.result, !ai.snapshot.isSelection)
  closeAiPanel()
  showToast({ type: 'success', message: '已采用改写结果，可使用 Ctrl + Z 撤销' })
}

function regenerate(): void {
  const snapshot = ai.snapshot
  if (!snapshot || ai.loading) return
  if (ai.conflict) {
    closeAiPanel()
    void runEnhance(snapshot.mode)
  } else {
    void runEnhance(snapshot.mode, snapshot)
  }
}

async function copyAiResult(): Promise<void> {
  if (!ai.result) return
  await window.sheepText.copyText(ai.result)
  showToast({ type: 'success', message: '改写结果已复制，原文未改变' })
}

async function cancelAi(): Promise<void> {
  if (!ai.requestId) return
  await window.sheepText.cancelEnhance(ai.requestId)
}

function closeAiPanel(): void {
  if (ai.loading && ai.requestId) void window.sheepText.cancelEnhance(ai.requestId)
  Object.assign(ai, { open: false, loading: false, requestId: '', result: '', error: '', conflict: false, modelName: '', durationMs: 0, snapshot: null })
}

async function copyDraft(): Promise<void> {
  newMenuOpen.value = false
  if (!draft.value) return
  await window.sheepText.copyText(draft.value.content)
  showToast({ type: 'success', message: `已复制 ${draft.value.content.length.toLocaleString('zh-CN')} 字` })
}

async function saveAs(): Promise<void> {
  newMenuOpen.value = false
  if (!draft.value) return
  // 另存副本是文件丢失/冲突时的救援入口，不先强制覆盖原文件。
  if (saveInFlight) await saveInFlight
  try {
    const snapshot: Draft = {
      id: draft.value.id, content: draft.value.content, createdAt: draft.value.createdAt,
      updatedAt: draft.value.updatedAt, version: draft.value.version, scene: draft.value.scene,
      modelConfigId: draft.value.modelConfigId, displayMode: draft.value.displayMode, filePath: draft.value.filePath
    }
    const result = await window.sheepText.saveAs(snapshot)
    if (!result.canceled) showToast({ type: 'success', message: `已导出到 ${result.filePath}` })
  } catch (error) {
    showToast({ type: 'error', message: cleanError(error) })
  }
}

function minimizeWindow(): void {
  void window.sheepText.windowAction(windowId, 'minimize')
}

function toggleMaximize(): void {
  void window.sheepText.windowAction(windowId, 'toggle-maximize')
}

async function toggleAlwaysOnTop(): Promise<void> {
  const next = !alwaysOnTop.value
  alwaysOnTop.value = next
  try {
    await window.sheepText.setAlwaysOnTop(windowId, next)
  } catch (error) {
    alwaysOnTop.value = !next
    showToast({ type: 'error', message: cleanError(error) })
  }
}

async function flushBeforeQuit(): Promise<void> {
  const success = await flushSave()
  window.sheepText.notifyFlushComplete(windowId, success)
}

async function requestClose(): Promise<void> {
  if (closing.value) return
  closing.value = true
  const saved = await flushSave()
  if (saved) await window.sheepText.windowAction(windowId, 'close')
  else closing.value = false
}

function showToast(payload: ToastPayload): void {
  if (toastTimer) clearTimeout(toastTimer)
  toast.value = { ...payload, id: Date.now() }
  toastTimer = setTimeout(() => { toast.value = null }, payload.type === 'error' ? 7200 : 4200)
}

function cleanError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/^Error invoking remote method '[^']+': Error: /, '')
}
</script>

<template>
  <div class="app-root" :data-theme="themeAttribute" :style="themeStyle" :class="{ 'is-docked': isDocked, 'is-collapsed': isCollapsed }" @dragover="onWorkspaceDragOver" @drop="onWorkspaceDrop">
    <button v-if="isCollapsed" type="button" class="dock-rail no-drag" :class="`dock-${dockSide ?? 'left'}`" title="展开 SheepText" aria-label="展开 SheepText" @click="expandDockRail" />

    <div v-if="booting" class="boot-screen">
      <img class="boot-logo" :src="appIcon" alt="SheepText" />
      <strong>SheepText</strong>
      <span>正在找回你的草稿…</span>
    </div>

    <template v-else-if="draft && settings">
      <header class="titlebar has-tabs">
        <div class="titlebar-left">
          <div class="history-trigger no-drag" @mouseenter="onHistoryTriggerEnter" @mouseleave="onHistoryTriggerLeave">
            <IconButton title="文稿历史" :active="historyOpen" @click="toggleHistoryByClick"><History :size="18" /></IconButton>
          </div>
          <span v-if="isDocked" class="dock-chip">已停靠</span>
          <div class="new-draft-group no-drag" @mouseleave="scheduleNewMenuClose">
            <button class="quick-new" type="button" title="新建标签页（Ctrl + T）" @click="createDraft"><Plus :size="16" /></button>
            <button class="quick-new-menu" type="button" title="更多新建方式" @mouseenter="openNewMenu" @focus="newMenuOpen = true" @click="newMenuOpen = !newMenuOpen"><ChevronDown :size="14" /></button>
            <Transition name="popover">
              <div v-if="newMenuOpen" class="new-menu">
                <button type="button" @click="createDraft"><FilePlus2 :size="17" /><span><strong>新建标签页</strong><small>在当前窗口打开空白草稿</small></span></button>
                <button type="button" @click="createWindow"><PanelTop :size="17" /><span><strong>新建窗口</strong><small>独立编辑另一份内容</small></span></button>
                <button type="button" @click="importFile"><FolderOpen :size="17" /><span><strong>从文件中打开</strong><small>作为新标签打开本地 TXT / MD 文件</small></span></button>
                <button type="button" @click="saveAs"><FileDown :size="17" /><span><strong>另存为</strong><small>导出当前文稿到文件</small></span></button>
                <button type="button" @click="copyDraft"><Copy :size="17" /><span><strong>复制全文</strong><small>复制当前文稿内容</small></span></button>
              </div>
            </Transition>
          </div>
          <TabBar
            ref="tabBar"
            :tabs="tabs"
            :active-draft-id="draft.id"
            @select="switchTab"
            @close="closeTab"
            @reorder="reorderTabs"
            @drag-start="beginTabDrag"
            @drag-end="handleTabDragEnd"
            @cross-drop="onTabCrossDrop"
          />
        </div>

        <div class="titlebar-drag" />

        <div class="titlebar-actions">
          <IconButton title="始终置顶" :active="alwaysOnTop" @click="toggleAlwaysOnTop"><Pin :size="17" /></IconButton>
          <IconButton title="设置" @click="openSettings('general')"><SettingsIcon :size="17" /></IconButton>
          <span class="window-divider" />
          <IconButton title="最小化" @click="minimizeWindow"><Minus :size="17" /></IconButton>
          <IconButton title="最大化 / 还原" @click="toggleMaximize"><Maximize2 :size="16" /></IconButton>
          <IconButton title="关闭窗口" danger @click="requestClose"><X :size="18" /></IconButton>
        </div>
      </header>

      <main class="workspace" :class="[{ 'has-result': ai.open }, ...editorSurfaceClass]">
        <!-- 与右上角大纲按钮对称的文件夹入口；仅在当前文稿来自本地文件时出现 -->
        <div v-if="draft.filePath" class="folder-dock no-drag" @mouseenter="handleFolderEnter" @mouseleave="handleFolderLeave" @keydown.esc.stop="closeFolder">
          <button type="button" class="folder-toggle" :class="{ 'is-active': folderPinned }" :aria-pressed="folderPinned" :aria-expanded="folderOpen" :title="folderPinned ? '取消固定文件夹' : '文件夹：浏览同目录文稿（点击固定）'" @click="toggleFolderPinned"><FolderOpen :size="17" /></button>
          <Transition name="popover">
            <FolderPanel v-if="folderOpen" ref="folderPanelRef" :draft-id="draft.id" @close="closeFolder" @select="openLocalFileInWindow" />
          </Transition>
        </div>
        <div class="floating-command floating-command-left no-drag">
          <span class="floating-command-hint format-hint" :title="draft.displayMode === 'markdown' ? '当前格式：Markdown' : '当前格式：TXT'">
            <Text v-if="draft.displayMode === 'txt'" :size="16" />
            <Code2 v-else :size="16" />
          </span>
          <div class="command-left">
          <div class="command-group mode-switch" aria-label="文稿格式">
            <button :class="{ active: draft.displayMode === 'txt' }" @click="setDisplayMode('txt')"><Text :size="15" />TXT</button>
            <button :class="{ active: draft.displayMode === 'markdown' }" @click="setDisplayMode('markdown')"><Code2 :size="15" />Markdown</button>
          </div>
          <span class="scope-chip" :class="{ selected: hasSelection }">{{ hasSelection ? '已选 ' + selection.text.length.toLocaleString('zh-CN') + ' 字' : characterCount.toLocaleString('zh-CN') + ' 字' }}</span>
          </div>
        </div>
        <div v-if="hasDefaultModel" class="floating-command floating-command-right no-drag">
          <span class="floating-command-hint scene-hint" :title="'当前场景：' + SCENE_LABELS[draft.scene]">
            <MessageSquareText v-if="draft.scene === 'general'" :size="16" />
            <Code2 v-else-if="draft.scene === 'coding'" :size="16" />
            <Image v-else :size="16" />
          </span>
          <div class="command-right">
          <div class="scene-control" @mouseenter="sceneMenuOpen = true" @mouseleave="sceneMenuOpen = false">
            <button type="button" class="scene-button" :title="'当前场景：' + SCENE_LABELS[draft.scene]" @focus="sceneMenuOpen = true" @click="sceneMenuOpen = !sceneMenuOpen">
              <MessageSquareText v-if="draft.scene === 'general'" :size="17" /><Code2 v-else-if="draft.scene === 'coding'" :size="17" /><Image v-else :size="17" />
              <span class="action-label">{{ SCENE_LABELS[draft.scene] }}</span>
            </button>
            <Transition name="popover"><div v-if="sceneMenuOpen" class="scene-menu">
              <button v-for="option in sceneOptions" :key="option.value" :class="{ active: draft.scene === option.value }" @click="setScene(option.value)">
                <MessageSquareText v-if="option.value === 'general'" :size="17" /><Code2 v-else-if="option.value === 'coding'" :size="17" /><Image v-else :size="17" /><span><strong>{{ option.label }}</strong><small>{{ option.description }}</small></span>
              </button>
            </div></Transition>
          </div>
          <!-- 未设默认模型时隐藏增强入口，避免点了必然报错 -->
          <button v-if="hasDefaultModel" type="button" class="enhance-icon-button" title="保守增强：尽量保持原意和结构" :disabled="ai.loading" @mousedown.prevent @click="runEnhance('conservative')"><WandSparkles :size="18" /><span class="action-label">保守增强</span></button>
          <button v-if="hasDefaultModel" type="button" class="enhance-icon-button" title="创意重写：更大胆地优化表达" :disabled="ai.loading" @mousedown.prevent @click="runEnhance('creative')"><Sparkles :size="18" /><span class="action-label">创意重写</span></button>
          </div>
        </div>
        <div class="editor-layout" :class="{ markdown: draft.displayMode === 'markdown', 'has-folder-dock': Boolean(draft.filePath) }">
          <section class="editor-pane">
            <MilkdownEditor
              v-if="draft.displayMode === 'markdown'"
              :key="`${draft.id}-milkdown`"
              :readonly="externalResolving"
              ref="editor"
              :model-value="draft.content"
              :font-size="settings.fontSize"
              :draft-id="draft.id"
              :window-id="windowId"
              :completion-enabled="settings.completionEnabled"
              :completion-auto-enabled="settings.completionAutoEnabled"
              :completion-model-id="completionModelId"
              :completion-trigger="settings.completionTriggerKey"
              @completion-change="onCompletionChange"
              @update:model-value="onContentChanged"
              @selection-change="onSelectionChanged"
              @focus-change="editorFocused = $event"
              @composition-change="isComposing = $event"
              @font-size-change="onFontSizeChange"
              @pasted="onPasted"
              @paste-invalidated="hidePasteNotice"
              @toast="showToast"
              @outline-hold="outlineHeld = $event"
            />
            <TextEditor
              v-else-if="draft.displayMode === 'txt'"
              :key="`${draft.id}-text`"
              :readonly="externalResolving"
              ref="editor"
              :model-value="draft.content"
              :display-mode="draft.displayMode"
              :font-size="settings.fontSize"
              :draft-id="draft.id"
              @update:model-value="onContentChanged"
              @selection-change="onSelectionChanged"
              @focus-change="editorFocused = $event"
              @composition-change="isComposing = $event"
              @font-size-change="onFontSizeChange"
              @pasted="onPasted"
              @paste-invalidated="hidePasteNotice"
              @toast="showToast"
            />
            <div v-if="!draft.content && draft.displayMode === 'txt'" class="starter-hints no-drag">
              <span>试试这样开始</span>
              <button @click="editor?.focus()"><Code2 :size="15" />整理一段编程需求</button>
              <button @click="editor?.focus()"><Image :size="15" />完善一个生图想法</button>
            </div>
          </section>
        </div>

        <Transition name="popover">
          <div v-if="pasteNotice" class="paste-notice no-drag" @mouseenter="clearPasteNoticeTimer" @mouseleave="startPasteNoticeTimer" @focusin="clearPasteNoticeTimer" @focusout="startPasteNoticeTimer" @keydown.esc="hidePasteNotice">
            <ClipboardPaste :size="15" />
            <span class="paste-notice-label">粘贴：{{ pasteNotice.cleared ? '已清除格式' : '保留原格式' }}</span>
            <button v-if="!pasteNotice.cleared" type="button" @click="clearPastedFormat">清除格式</button>
            <button type="button" class="paste-notice-close" title="关闭" @click="keepPastedFormat"><X :size="13" /></button>
          </div>

          <!-- AI 补全提示条：灰字存在时显示，提示可按 → 采用，也可直接点按钮 -->
          <div v-if="completionNotice" class="paste-notice completion-notice no-drag" @keydown.esc="dismissCompletion">
            <Sparkles :size="15" />
            <span class="paste-notice-label">AI 补全</span>
            <span class="completion-notice-preview">{{ completionNotice.preview }}{{ completionNotice.preview.length >= 40 ? '…' : '' }}</span>
            <span class="completion-notice-hint">按 <kbd>→</kbd> 采用</span>
            <button type="button" @click="acceptCompletion">采用</button>
            <button type="button" class="paste-notice-close" title="丢弃（Esc）" @click="dismissCompletion"><X :size="13" /></button>
          </div>
        </Transition>

        <Transition name="popover">
          <div v-if="dragFileActive" class="drag-file-overlay">
            <div class="drag-file-hint">
              <FilePlus2 :size="26" />
              <strong>松手打开文件</strong>
              <span>支持 TXT 与 Markdown，每个文件在新窗口打开</span>
            </div>
          </div>
        </Transition>

        <Transition name="modal">
          <div v-if="externalConflict" class="external-conflict-overlay no-drag">
            <div class="external-conflict-dialog" role="alertdialog" aria-modal="true" aria-label="本地文件变更确认" @keydown.stop>
              <h3>{{ externalConflict.missing ? '文件已被移动或删除' : '文件已被外部修改' }}</h3>
              <p class="external-conflict-path">{{ externalConflict.path }}</p>
              <p>{{ externalConflict.missing ? '当前内容仍保留在窗口中，请另存副本以避免丢失。恢复原文件后可重新加载。' : '自动保存已暂停。重新加载会放弃当前未保存的修改；保留我的版本会将当前窗口内容写入磁盘。也可先另存副本。' }}</p>
              <div class="external-conflict-actions" style="flex-wrap: wrap">
                <BaseButton variant="ghost" size="sm" :disabled="externalResolving" @click="saveAs"><template #icon><FileDown :size="15" /></template>另存副本</BaseButton>
                <BaseButton variant="secondary" size="sm" :disabled="externalResolving" @click="resolveExternal('reload')"><template #icon><RefreshCw :size="15" /></template>重新加载</BaseButton>
                <BaseButton v-if="!externalConflict.missing" variant="primary" size="sm" :disabled="externalResolving" @click="resolveExternal('keep')"><template #icon><Save :size="15" /></template>保留我的版本</BaseButton>
              </div>
            </div>
          </div>
        </Transition>

        <HistoryDrawer
          @toast="showToast"
          :open="historyOpen"
          :items="historyItems"
          :search="historySearch"
          :loading="historyLoading"
          :has-more="historyHasMore"
          @update:search="historySearch = $event"
          @select="selectHistory"
          @delete="deleteHistory"
          @close="closeHistory"
          @load-more="loadHistory(false)"
          @hold="setHistoryHold"
        />

        <AiResultPanel
          :open="ai.open"
          :loading="ai.loading"
          :result="ai.result"
          :error="ai.error"
          :conflict="ai.conflict"
          :range-label="aiRangeLabel"
          :model-name="ai.modelName"
          :duration-ms="ai.durationMs"
          :display-mode="draft.displayMode"
          @adopt="adoptAiResult"
          @regenerate="regenerate"
          @copy="copyAiResult"
          @discard="closeAiPanel"
          @cancel="cancelAi"
        />
      </main>


      <SettingsPanel
        :open="settingsOpen"
        :settings="settings"
        :models="models"
        :app-version="appVersion"
        :encryption-available="encryptionAvailable"
        :window-id="windowId"
        :initial-tab="settingsTab"
        @close="settingsOpen = false"
        @settings-changed="settings = $event; applyTheme()"
        @models-changed="models = $event"
        @toast="showToast"
      />

      <Transition name="toast">
        <div v-if="toast" :key="toast.id" class="toast-message" :class="`is-${toast.type}`">
          <span class="toast-dot" />{{ toast.message }}
        </div>
      </Transition>
    </template>
  </div>
</template>
