<script setup lang="ts">
import {
  ChevronDown, ClipboardPaste, Code2, Copy, FileDown, FilePlus2, FolderOpen,
  History, Image, Maximize2, MessageSquareText, Minus, PanelTop, Pin, Plus,
  Settings as SettingsIcon, Sparkles, Text, WandSparkles, X
} from '@lucide/vue'
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { HISTORY_PAGE_SIZE, SAVE_DEBOUNCE_MS, SCENE_LABELS } from '../../shared/constants'
import type {
  AiRequest, AiResult, AppSettings, Draft, DraftSummary, EnhanceMode, ModelConfigPublic,
  DockSide, SceneId, ToastPayload, WindowBootstrap, WindowInteractionState
} from '../../shared/types'
import AiResultPanel from './components/AiResultPanel.vue'
import type { SelectOption } from './components/BaseSelect.vue'
import BaseButton from './components/BaseButton.vue'
import HistoryDrawer from './components/HistoryDrawer.vue'
import IconButton from './components/IconButton.vue'
import MilkdownEditor from './components/MilkdownEditor.vue'
import SettingsPanel from './components/SettingsPanel.vue'
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
}

// 粘贴格式临时操作区状态：记录本次粘贴范围，超时或新编辑后失效
type PasteNotice = {
  draftId: string
  displayMode: 'txt' | 'markdown'
  range: { from: number; to: number }
  cleared: boolean
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
const appVersion = ref('0.3.0')
const encryptionAvailable = ref(true)
const editor = ref<EditorExpose | null>(null)
const editorFocused = ref(false)
const isComposing = ref(false)
const selection = reactive({ from: 0, to: 0, text: '' })
const saveState = ref<'saved' | 'saving' | 'error'>('saved')
const saveError = ref('')
const lastSavedVersion = ref(0)
const alwaysOnTop = ref(false)
const isDocked = ref(false)
const dockSide = ref<DockSide>(null)
const isCollapsed = ref(false)
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
  const color = settings.value?.themeColor ?? '#6958cf'
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
const aiRangeLabel = computed(() => {
  const snapshot = ai.snapshot
  if (!snapshot) return '全文'
  return snapshot.isSelection ? `选区 ${snapshot.text.length} 字` : '全文'
})
const interactionState = computed<WindowInteractionState>(() => ({
  interacting: editorFocused.value,
  composing: isComposing.value,
  drawerOpen: historyOpen.value,
  menuOpen: newMenuOpen.value || sceneMenuOpen.value || openSelectCount.value > 0 || settingsOpen.value || Boolean(pasteNotice.value),
  aiPreviewOpen: ai.open
}))

onMounted(async () => {
  try {
    const bootstrap = await window.sheepText.bootstrap(windowId)
    applyBootstrap(bootstrap)
    registerEvents()
    await nextTick()
    window.addEventListener('keydown', handleGlobalShortcut, true)
    document.addEventListener('pointerdown', handleOutsidePointerDown, true)
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
  window.removeEventListener('keydown', handleGlobalShortcut, true)
  document.removeEventListener('pointerdown', handleOutsidePointerDown, true)
  unsubscribers.forEach((unsubscribe) => unsubscribe())
})

watch(() => [draft.value?.id, draft.value?.displayMode], hidePasteNotice)
watch(interactionState, (state) => window.sheepText.setInteractionState(windowId, state), { deep: true })
watch(historyOpen, (open) => {
  if (open) void loadHistory(true)
})
watch(historySearch, () => {
  if (historyOpen.value) void loadHistory(true)
})

function applyBootstrap(bootstrap: WindowBootstrap): void {
  draft.value = bootstrap.draft
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
    window.sheepText.onRequestClose(() => void requestClose()),
    window.sheepText.onBeforeQuit(() => void flushBeforeQuit())
  )
}

function applyTheme(): void {
  const color = settings.value?.themeColor ?? '#6958cf'
  document.documentElement.dataset.theme = settings.value?.theme ?? 'system'
  document.documentElement.style.setProperty('--primary', color)
  document.documentElement.style.setProperty('--primary-strong', color)
  document.documentElement.style.setProperty('--primary-soft', 'color-mix(in srgb, ' + color + ' 14%, transparent)')
  document.documentElement.style.setProperty('--selection', 'color-mix(in srgb, ' + color + ' 22%, transparent)')
  const root = document.querySelector<HTMLElement>('.app-root')
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
    editorPattern: source.editorPattern
  }
}

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
    const created = await window.sheepText.createDraft(windowId)
    setCurrentDraft(created)
    closeHistory()
    closeAiPanel()
    await nextTick()
    editor.value?.focus()
    showToast({ type: 'success', message: '已新建空白文稿，原文稿保留在历史中' })
  } catch (error) {
    showToast({ type: 'error', message: cleanError(error) })
  }
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
    setCurrentDraft(result.draft)
    closeHistory()
    closeAiPanel()
    await nextTick()
    editor.value?.focus()
    showToast({ type: 'success', message: '文件内容已导入为独立文稿，不会修改或同步原文件' })
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
  if (!event.ctrlKey || event.altKey) return
  const key = event.key.toLowerCase()
  if (key === 'n') {
    event.preventDefault()
    if (event.shiftKey) void createWindow()
    else void createDraft()
    return
  }
  if (key === 'f' && !event.shiftKey) {
    event.preventDefault()
    if (settingsOpen.value) return
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
  if (!await flushSave()) return
  try {
    const result = await window.sheepText.openDraft(windowId, id)
    if (result.activatedExistingWindow) {
      showToast({ type: 'info', message: '该文稿已在另一个窗口中打开' })
      return
    }
    if (result.draft) {
      setCurrentDraft(result.draft)
      closeHistory()
      closeAiPanel()
      await nextTick()
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
    if (result.replacementDraft) {
      setCurrentDraft(result.replacementDraft)
      closeAiPanel()
      await nextTick()
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
  newMenuOpen.value = false
  sceneMenuOpen.value = false
}

async function runEnhance(mode: EnhanceMode, reuse?: RequestSnapshot): Promise<void> {
  if (!draft.value) return
  if (isComposing.value) {
    showToast({ type: 'warning', message: '请先完成当前中文输入，再使用 AI 增强' })
    return
  }
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
  if (!draft.value || !await flushSave()) return
  try {
    const snapshot: Draft = {
      id: draft.value.id, content: draft.value.content, createdAt: draft.value.createdAt,
      updatedAt: draft.value.updatedAt, version: draft.value.version, scene: draft.value.scene,
      modelConfigId: draft.value.modelConfigId, displayMode: draft.value.displayMode
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
  <div class="app-root" :data-theme="themeAttribute" :style="themeStyle" :class="{ 'is-docked': isDocked, 'is-collapsed': isCollapsed }">
    <button v-if="isCollapsed" type="button" class="dock-rail no-drag" :class="`dock-${dockSide ?? 'left'}`" title="展开 SheepText" aria-label="展开 SheepText" @click="expandDockRail" />

    <div v-if="booting" class="boot-screen">
      <img class="boot-logo" :src="appIcon" alt="SheepText" />
      <strong>SheepText</strong>
      <span>正在找回你的草稿…</span>
    </div>

    <template v-else-if="draft && settings">
      <header class="titlebar">
        <div class="titlebar-left">
          <div class="history-trigger no-drag" @mouseenter="onHistoryTriggerEnter" @mouseleave="onHistoryTriggerLeave">
            <IconButton title="文稿历史" :active="historyOpen" @click="toggleHistoryByClick"><History :size="18" /></IconButton>
          </div>
          <div class="new-draft-group no-drag" @mouseleave="newMenuOpen = false">
            <button class="quick-new" type="button" title="新建文稿" @click="createDraft"><Plus :size="16" /><span>新建</span></button>
            <button class="quick-new-menu" type="button" title="更多新建方式" @mouseenter="newMenuOpen = true" @focus="newMenuOpen = true" @click="newMenuOpen = !newMenuOpen"><ChevronDown :size="14" /></button>
            <Transition name="popover">
              <div v-if="newMenuOpen" class="new-menu">
                <button type="button" @click="createDraft"><FilePlus2 :size="17" /><span><strong>新建文稿</strong><small>在当前窗口打开空白草稿</small></span></button>
                <button type="button" @click="createWindow"><PanelTop :size="17" /><span><strong>新建窗口</strong><small>独立编辑另一份内容</small></span></button>
                <button type="button" @click="importFile"><FolderOpen :size="17" /><span><strong>从文件中打开</strong><small>导入 TXT / MD 为独立文稿</small></span></button>
                <button type="button" @click="saveAs"><FileDown :size="17" /><span><strong>另存为</strong><small>导出当前文稿到文件</small></span></button>
                <button type="button" @click="copyDraft"><Copy :size="17" /><span><strong>复制全文</strong><small>复制当前文稿内容</small></span></button>
              </div>
            </Transition>
          </div>
        </div>

        <div class="window-brand">
          <img class="brand-logo" :src="appIcon" alt="SheepText" />
          <span class="brand-name">SheepText</span>
          <span v-if="isDocked" class="dock-chip">已停靠</span>
        </div>

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
        <div class="floating-command floating-command-right no-drag">
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
          <button type="button" class="enhance-icon-button" title="保守增强：尽量保持原意和结构" :disabled="ai.loading" @mousedown.prevent @click="runEnhance('conservative')"><WandSparkles :size="18" /><span class="action-label">保守增强</span></button>
          <button type="button" class="enhance-icon-button" title="创意重写：更大胆地优化表达" :disabled="ai.loading" @mousedown.prevent @click="runEnhance('creative')"><Sparkles :size="18" /><span class="action-label">创意重写</span></button>
          </div>
        </div>
        <div class="editor-layout" :class="{ markdown: draft.displayMode === 'markdown' }">
          <section class="editor-pane">
            <MilkdownEditor
              v-if="draft.displayMode === 'markdown'"
              :key="`${draft.id}-milkdown`"
              ref="editor"
              :model-value="draft.content"
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
            <TextEditor
              v-else-if="draft.displayMode === 'txt'"
              :key="`${draft.id}-text`"
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
        </Transition>

        <HistoryDrawer
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
