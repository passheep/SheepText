import { app, clipboard, dialog, ipcMain, safeStorage, shell, type IpcMainInvokeEvent } from 'electron'
import { randomBytes } from 'node:crypto'
import { copyFile, cp, mkdir, readdir, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, parse } from 'node:path'
import type {
  AiRequest,
  AppSettings,
  Draft,
  DraftSaveInput,
  HistoryQuery,
  ModelConfigInput, PastedImageInput,
  WindowAction, WindowInteractionState
} from '../shared/types'
import { AiService } from './ai-service'
import { DataStore } from './data-store'
import { WindowManager } from './window-manager'
import { FileDraftService } from './file-draft-service'

export function registerIpc(store: DataStore, aiService: AiService, windows: WindowManager): FileDraftService {
  const files = new FileDraftService(store, {
    activateWindow: (id) => windows.activateWindow(id),
    createWindow: (id) => windows.createWindowForDraft(id),
    toast: (id, payload) => {
      const record = store.getOpenWindowForDraft(id)
      const window = record ? windows.getBrowserWindow(record.id) : null
      if (window && !window.isDestroyed()) window.webContents.send('app:toast', payload)
    }
  })
  const assertWindow = (event: IpcMainInvokeEvent, windowId: string): void => {
    const browserWindow = windows.getBrowserWindow(windowId)
    if (!browserWindow || browserWindow.webContents.id !== event.sender.id) throw new Error('窗口身份校验失败')
  }

  ipcMain.handle('app:bootstrap', (event, windowId: string) => {
    assertWindow(event, windowId)
    const windowRecord = store.getWindow(windowId)
    if (!windowRecord) throw new Error('窗口状态不存在')
    const draft = store.getDraft(windowRecord.draftId)
    if (!draft) throw new Error('当前文稿不存在')
    return {
      windowId,
      draft,
      settings: store.getSettings(),
      models: store.listModels(),
      window: windowRecord,
      appVersion: app.getVersion(),
      encryptionAvailable: safeStorage.isEncryptionAvailable()
    }
  })

  ipcMain.handle('draft:save', async (event, windowId: string, input: DraftSaveInput) => {
    assertWindow(event, windowId)
    const record = store.getWindow(windowId)
    if (!record || record.draftId !== input.id) throw new Error('当前窗口未打开该文稿')
    return files.saveDraft(input)
  })

  ipcMain.handle('draft:create', (event, windowId: string) => {
    assertWindow(event, windowId)
    const draft = store.createDraft()
    windows.switchDraft(windowId, draft.id)
    return draft
  })

  ipcMain.handle('draft:open', async (event, windowId: string, draftId: string) => {
    assertWindow(event, windowId)
    const draft = store.getDraft(draftId)
    if (!draft) throw new Error('文稿不存在或已被移除')
    if (draft.filePath) {
      const result = await files.openLocalFile(draft.filePath)
      return { activatedExistingWindow: true, draft: result.draft }
    }
    const opened = store.getOpenWindowForDraft(draftId, windowId)
    if (opened && windows.activateWindow(opened.id)) return { activatedExistingWindow: true }
    windows.switchDraft(windowId, draftId)
    return { activatedExistingWindow: false, draft }
  })

  ipcMain.handle('history:search', (event, windowId: string, query: HistoryQuery) => {
    assertWindow(event, windowId)
    return store.searchHistory(query)
  })

  ipcMain.handle('draft:delete', async (event, windowId: string, draftId: string) => {
    assertWindow(event, windowId)
    return files.withDraft(draftId, async () => {
      const windowRecord = store.getWindow(windowId)
      if (!windowRecord) throw new Error('当前窗口状态不存在')
      const opened = store.getOpenWindowForDraft(draftId)
      if (opened && opened.id !== windowId) throw new Error('该文稿正在另一个窗口中编辑，请先关闭对应窗口后再删除')
      const target = store.getDraft(draftId)
      if (!target) throw new Error('文稿不存在或已被移除')
      // 必须先回收成功；失败（含文件已丢失）原样抛出，不能先切换或删除 DB。
      if (target.filePath) await shell.trashItem(target.filePath)
      let replacementDraft: Draft | undefined
      if (store.getWindow(windowId)?.draftId === draftId) {
        replacementDraft = store.createDraft()
        windows.switchDraft(windowId, replacementDraft.id)
      }
      store.deleteDraft(draftId)
      return { deletedId: draftId, replacementDraft }
    })
  })

  ipcMain.handle('window:new', (event, windowId: string) => {
    assertWindow(event, windowId)
    return windows.createNewWindow(true)
  })

  ipcMain.handle('models:list', (event, windowId: string) => {
    assertWindow(event, windowId)
    return store.listModels()
  })

  ipcMain.handle('models:save', (event, windowId: string, input: ModelConfigInput) => {
    assertWindow(event, windowId)
    const models = store.saveModel(input)
    windows.broadcast('models:changed', models)
    windows.broadcast('settings:changed', store.getSettings())
    return models
  })

  ipcMain.handle('models:delete', (event, windowId: string, id: string) => {
    assertWindow(event, windowId)
    const models = store.deleteModel(id)
    windows.broadcast('models:changed', models)
    windows.broadcast('settings:changed', store.getSettings())
    return models
  })

  ipcMain.handle('models:test', (event, windowId: string, input: ModelConfigInput, kind: 'connection' | 'generation') => {
    assertWindow(event, windowId)
    return aiService.testConnection(input, kind)
  })

  ipcMain.handle('ai:enhance', (event, windowId: string, request: AiRequest) => {
    assertWindow(event, windowId)
    if (request.windowId !== windowId) throw new Error('AI 请求窗口不一致')
    return aiService.enhance(request)
  })

  ipcMain.handle('ai:cancel', (event, windowId: string, requestId: string) => {
    assertWindow(event, windowId)
    aiService.cancel(requestId)
  })

  ipcMain.handle('settings:get', (event, windowId: string) => {
    assertWindow(event, windowId)
    return store.getSettings()
  })

  ipcMain.handle('settings:save', (event, windowId: string, settings: AppSettings) => {
    assertWindow(event, windowId)
    const saved = store.saveSettings(settings)
    // 开发模式只保存偏好，避免把 electron.exe 注册为系统启动项。
    if (app.isPackaged) {
      app.setLoginItemSettings({
        openAtLogin: saved.autoLaunch,
        args: saved.autoLaunch ? ['--hidden'] : []
      })
    }
    windows.applySettings(saved)
    windows.broadcast('settings:changed', saved)
    return saved
  })

  ipcMain.handle('draft:import-file', async (event, windowId: string) => {
    assertWindow(event, windowId)
    const browserWindow = windows.getBrowserWindow(windowId)
    if (!browserWindow) throw new Error('窗口不存在')
    const result = await dialog.showOpenDialog(browserWindow, {
      title: '从文件中打开', properties: ['openFile'], filters: [{ name: 'SheepText 文稿', extensions: ['txt', 'md', 'markdown'] }]
    })
    if (result.canceled || !result.filePaths[0]) return { canceled: true, openedInNewWindow: true }
    const resultOpen = await files.openLocalFile(result.filePaths[0])
    return { canceled: false, filePath: resultOpen.draft.filePath, draft: resultOpen.draft, openedInNewWindow: true }
  })

  ipcMain.handle('file:open', (event, windowId: string, filePath: string) => {
    assertWindow(event, windowId)
    return files.openLocalFile(filePath)
  })

  ipcMain.handle('file:check-external', async (event, windowId: string, draftId: string) => {
    assertWindow(event, windowId)
    const record = store.getWindow(windowId)
    if (!record || record.draftId !== draftId) throw new Error('当前窗口未打开该文稿')
    return files.checkExternalChange(draftId)
  })

  // 外部修改确认后：重新加载（读磁盘并更新 DB）或保留内存版本覆盖磁盘
  ipcMain.handle('file:resolve-external', (event, windowId: string, draftId: string, action: 'reload' | 'keep', input: DraftSaveInput) => {
    assertWindow(event, windowId)
    const record = store.getWindow(windowId)
    if (!record || record.draftId !== draftId || input?.id !== draftId) throw new Error('当前窗口未打开该文稿')
    return files.resolveExternalChange(draftId, action, input)
  })
  // 不再接受渲染层登记基线；基线只能由主进程读取/写入成功后管理。

  ipcMain.handle('draft:paste-image', async (event, windowId: string, draftId: string, input: PastedImageInput) => {
    assertWindow(event, windowId)
    const record = store.getWindow(windowId)
    if (!record || record.draftId !== draftId) throw new Error('当前窗口未打开该文稿')
    const extensions: Record<string, string> = {
      'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp',
      'image/gif': '.gif', 'image/bmp': '.bmp'
    }
    const extension = extensions[input.mimeType]
    if (!extension) throw new Error('暂不支持这种图片格式')
    const bytes = input.bytes instanceof Uint8Array ? input.bytes : new Uint8Array(input.bytes)
    if (!bytes.byteLength) throw new Error('剪贴板图片为空')
    if (bytes.byteLength > 25 * 1024 * 1024) throw new Error('单张图片不能超过 25 MB')
    const directory = store.getDraftAssetDirectory(draftId)
    const fileName = `pasted-${formatFileTime(Date.now())}-${randomBytes(5).toString('hex')}${extension}`
    const filePath = store.resolveDraftAssetPath(draftId, fileName)
    await writeFile(filePath, bytes)
    const url = `sheeptext-asset://local/${encodeURIComponent(draftId)}/${encodeURIComponent(fileName)}`
    return { url, filePath, markdown: `![粘贴图片](${url})` }
  })

  ipcMain.handle('storage:info', async (event, windowId: string) => {
    assertWindow(event, windowId)
    const bytes = await directorySize(store.dataDirectory)
    return { path: store.dataFilePath, bytes, formattedSize: formatBytes(bytes) }
  })

  ipcMain.handle('storage:backup', async (event, windowId: string) => {
    assertWindow(event, windowId)
    const browserWindow = windows.getBrowserWindow(windowId)
    if (!browserWindow) throw new Error('窗口不存在')
    const result = await dialog.showSaveDialog(browserWindow, {
      title: '备份 SheepText 数据', defaultPath: 'SheepText-backup-' + formatFileTime(Date.now()) + '.db', filters: [{ name: 'SQLite 数据库', extensions: ['db'] }]
    })
    if (result.canceled || !result.filePath) return { canceled: true }
    store.backupTo(result.filePath)
    try {
      const assetsTarget = join(dirname(result.filePath), parse(result.filePath).name + '-images')
      await cp(store.assetDirectory, assetsTarget, { recursive: true, force: true })
    } catch { /* 尚无图片时仅备份数据库 */ }
    return { canceled: false, filePath: result.filePath }
  })

  ipcMain.handle('storage:export', async (event, windowId: string) => {
    assertWindow(event, windowId)
    const browserWindow = windows.getBrowserWindow(windowId)
    if (!browserWindow) throw new Error('窗口不存在')
    const result = await dialog.showSaveDialog(browserWindow, {
      title: '导出 SheepText 数据', defaultPath: 'SheepText-export-' + formatFileTime(Date.now()) + '.json', filters: [{ name: 'JSON 数据文件', extensions: ['json'] }]
    })
    if (result.canceled || !result.filePath) return { canceled: true }
    await writeFile(result.filePath, JSON.stringify(store.exportPayload(), null, 2), 'utf8')
    return { canceled: false, filePath: result.filePath }
  })
  ipcMain.handle('draft:save-as', async (event, windowId: string, draft: Draft) => {
    assertWindow(event, windowId)
    if (store.getWindow(windowId)?.draftId !== draft.id) throw new Error('当前窗口未打开该文稿')
    const browserWindow = windows.getBrowserWindow(windowId)
    if (!browserWindow) throw new Error('窗口不存在')
    const extension = draft.displayMode === 'markdown' ? 'md' : 'txt'
    const result = await dialog.showSaveDialog(browserWindow, {
      title: '另存为',
      defaultPath: `SheepText-${formatFileTime(Date.now())}.${extension}`,
      filters: [
        { name: 'Markdown 文档', extensions: ['md'] },
        { name: '文本文档', extensions: ['txt'] }
      ]
    })
    if (result.canceled || !result.filePath) return { canceled: true }
    // 另存可直接救援渲染层未保存正文，但不能借此绕过冲突覆盖原文件。
    files.assertSaveAsTarget(draft.id, result.filePath)
    const output = draft.displayMode === 'markdown'
      ? await exportMarkdownAssets(store, draft, result.filePath)
      : draft.content
    await writeFile(result.filePath, output, { encoding: 'utf8' })
    return { canceled: false, filePath: result.filePath }
  })

  ipcMain.handle('clipboard:copy', (event, windowId: string, text: string) => {
    assertWindow(event, windowId)
    clipboard.writeText(text)
  })

  ipcMain.handle('clipboard:copy-hide', (event, windowId: string, text: string) => {
    assertWindow(event, windowId)
    clipboard.writeText(text)
    windows.collapseOrHide(windowId)
  })

  ipcMain.handle('window:always-on-top', (event, windowId: string, value: boolean) => {
    assertWindow(event, windowId)
    windows.setAlwaysOnTop(windowId, value)
  })

  ipcMain.on('app:flush-complete', (event, windowId: string, success: boolean) => {
    const browserWindow = windows.getBrowserWindow(windowId)
    if (browserWindow?.webContents.id === event.sender.id) windows.notifyFlushComplete(windowId, success)
  })

  ipcMain.on('window:interaction', (event, windowId: string, state: WindowInteractionState) => {
    const browserWindow = windows.getBrowserWindow(windowId)
    if (browserWindow?.webContents.id === event.sender.id) windows.setInteractionState(windowId, state)
  })

  ipcMain.handle('window:action', (event, windowId: string, action: WindowAction) => {
    assertWindow(event, windowId)
    switch (action) {
      case 'minimize':
        windows.minimizeWindow(windowId)
        return
      case 'toggle-maximize':
        windows.toggleMaximizeWindow(windowId)
        return
      case 'close':
        windows.closeWindow(windowId)
        return
      case 'hide':
        windows.hideWindow(windowId)
        return
      case 'reset-size':
        windows.resetWindowSize(windowId)
        return
      case 'expand-dock':
        windows.expandDockedWindow(windowId)
        return
      default:
        throw new Error('不支持的窗口操作')
    }
  })

  // F18：在资源管理器中显示文件所在位置
  ipcMain.handle('shell:show-item-in-folder', (event, windowId: string, filePath: string) => {
    assertWindow(event, windowId)
    if (!/^[a-zA-Z]:[\\/]/.test(filePath)) throw new Error('路径不合法')
    shell.showItemInFolder(filePath)
  })

  ipcMain.handle('shell:open-external', async (event, windowId: string, url: string) => {
    assertWindow(event, windowId)
    const parsed = new URL(url)
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('只允许打开 HTTP 或 HTTPS 链接')
    await shell.openExternal(parsed.toString())
  })
  return files
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
}

function formatFileTime(timestamp: number): string {
  const date = new Date(timestamp)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`
}

async function directorySize(directory: string): Promise<number> {
  let total = 0
  let entries
  try { entries = await readdir(directory, { withFileTypes: true, encoding: 'utf8' }) } catch { return 0 }
  for (const entry of entries) {
    const fullPath = join(directory, entry.name)
    if (entry.isDirectory()) total += await directorySize(fullPath)
    else if (entry.isFile()) { try { total += (await stat(fullPath)).size } catch { /* 已被移动时跳过 */ } }
  }
  return total
}

async function exportMarkdownAssets(store: DataStore, draft: Draft, outputFile: string): Promise<string> {
  const matches = [...draft.content.matchAll(/sheeptext-asset:\/\/local\/([^/\s)]+)\/([^\s)]+)/g)]
  if (!matches.length) return draft.content
  const outputBase = parse(outputFile).name + '-assets'
  const outputDirectory = join(dirname(outputFile), outputBase)
  await mkdir(outputDirectory, { recursive: true })
  let content = draft.content
  for (const match of matches) {
    const draftId = decodeURIComponent(match[1])
    const fileName = basename(decodeURIComponent(match[2]))
    if (draftId !== draft.id || !fileName) continue
    const source = store.resolveDraftAssetPath(draftId, fileName)
    const destination = join(outputDirectory, fileName)
    await copyFile(source, destination)
    const relativeUrl = `./${encodeURIComponent(outputBase)}/${encodeURIComponent(fileName)}`
    content = content.replaceAll(match[0], relativeUrl)
  }
  return content
}



