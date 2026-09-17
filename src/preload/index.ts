import { contextBridge, ipcRenderer } from 'electron'
import type {
  AiRequest,
  AppSettings,
  Draft,
  DraftSaveInput,
  HistoryQuery,
  ModelConfigInput,
  ModelConfigPublic,
  PastedImageInput,
  SheepTextApi,
  ToastPayload,
  WindowAction, WindowInteractionState
} from '../shared/types'

const api: SheepTextApi = {
  bootstrap: (windowId) => ipcRenderer.invoke('app:bootstrap', windowId),
  saveDraft: (input: DraftSaveInput) => ipcRenderer.invoke('draft:save', currentWindowId(), input),
  createDraft: (windowId: string) => ipcRenderer.invoke('draft:create', windowId),
  openDraft: (windowId: string, draftId: string) => ipcRenderer.invoke('draft:open', windowId, draftId),
  searchHistory: (query: HistoryQuery) => ipcRenderer.invoke('history:search', currentWindowId(), query),
  deleteDraft: (windowId: string, draftId: string) => ipcRenderer.invoke('draft:delete', windowId, draftId),
  newWindow: () => ipcRenderer.invoke('window:new', currentWindowId()),
  listModels: () => ipcRenderer.invoke('models:list', currentWindowId()),
  saveModel: (input: ModelConfigInput) => ipcRenderer.invoke('models:save', currentWindowId(), input),
  deleteModel: (id: string) => ipcRenderer.invoke('models:delete', currentWindowId(), id),
  testModel: (input: ModelConfigInput, kind: 'connection' | 'generation') => ipcRenderer.invoke('models:test', currentWindowId(), input, kind),
  runEnhance: (request: AiRequest) => ipcRenderer.invoke('ai:enhance', currentWindowId(), request),
  cancelEnhance: (requestId: string) => ipcRenderer.invoke('ai:cancel', currentWindowId(), requestId),
  getSettings: () => ipcRenderer.invoke('settings:get', currentWindowId()),
  saveSettings: (settings: AppSettings) => ipcRenderer.invoke('settings:save', currentWindowId(), settings),
  saveAs: (draft: Draft) => ipcRenderer.invoke('draft:save-as', currentWindowId(), draft),
  importFile: () => ipcRenderer.invoke('draft:import-file', currentWindowId()),
  openLocalFile: (filePath: string) => ipcRenderer.invoke('file:open', filePath),
  checkExternalChange: (draftId: string) => ipcRenderer.invoke('file:check-external', currentWindowId(), draftId),
  resolveExternalChange: (draftId: string, action: 'reload' | 'keep') => ipcRenderer.invoke('file:resolve-external', currentWindowId(), draftId, action),
  savePastedImage: (draftId: string, input: PastedImageInput) => ipcRenderer.invoke('draft:paste-image', currentWindowId(), draftId, input),
  getStorageInfo: () => ipcRenderer.invoke('storage:info', currentWindowId()),
  backupData: () => ipcRenderer.invoke('storage:backup', currentWindowId()),
  exportData: () => ipcRenderer.invoke('storage:export', currentWindowId()),
  copyText: (text: string) => ipcRenderer.invoke('clipboard:copy', currentWindowId(), text),
  copyAndHide: (windowId: string, text: string) => ipcRenderer.invoke('clipboard:copy-hide', windowId, text),
  setAlwaysOnTop: (windowId: string, value: boolean) => ipcRenderer.invoke('window:always-on-top', windowId, value),
  setInteractionState: (windowId: string, state: WindowInteractionState) => ipcRenderer.send('window:interaction', windowId, state),
  windowAction: (windowId: string, action: WindowAction) => ipcRenderer.invoke('window:action', windowId, action),
  openExternal: (url: string) => ipcRenderer.invoke('shell:open-external', currentWindowId(), url),
  showItemInFolder: (filePath: string) => ipcRenderer.invoke('shell:show-item-in-folder', currentWindowId(), filePath),
  onModelsChanged: (callback: (models: ModelConfigPublic[]) => void) => subscribe('models:changed', callback),
  onSettingsChanged: (callback: (settings: AppSettings) => void) => subscribe('settings:changed', callback),
  onDockStateChanged: (callback) => subscribe('window:dock-state', callback),
  onToast: (callback: (payload: ToastPayload) => void) => subscribe('app:toast', callback),
  onRequestClose: (callback: () => void) => subscribe('window:request-close', callback),
  onBeforeQuit: (callback: () => void) => subscribe('app:before-quit', callback),
  notifyFlushComplete: (windowId: string, success: boolean) => ipcRenderer.send('app:flush-complete', windowId, success)
}

function currentWindowId(): string {
  const windowId = new URLSearchParams(globalThis.location.search).get('windowId')
  if (!windowId) throw new Error('缺少窗口标识')
  return windowId
}

function subscribe<T>(channel: string, callback: (payload: T) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, payload: T): void => callback(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

contextBridge.exposeInMainWorld('sheepText', api)

