import { app, Menu, nativeImage, net, protocol, Tray } from 'electron'
import { existsSync, mkdirSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { AiService } from './ai-service'
import { DataStore } from './data-store'
import { registerIpc } from './ipc'
import { WindowManager } from './window-manager'

let store: DataStore | null = null
let windows: WindowManager | null = null
let tray: Tray | null = null
let quitting = false

protocol.registerSchemesAsPrivileged([{
  scheme: 'sheeptext-asset',
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
}])

// 自动化截图环境缺少可用 GPU 进程，测试时改用软件渲染。
if (process.env.SHEEPTEXT_CAPTURE_PATH) app.disableHardwareAcceleration()

if (process.env.SHEEPTEXT_TEST_USER_DATA) {
  const testUserData = resolve(process.env.SHEEPTEXT_TEST_USER_DATA)
  mkdirSync(testUserData, { recursive: true })
  app.setPath('userData', testUserData)
}

const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) app.quit()

// 从命令行参数提取待打开的本地文件（需求 F15）
function extractFileArgs(argv: string[]): string[] {
  return argv.filter((arg) => /\.(txt|md|markdown)$/i.test(arg) && !arg.startsWith('-')).map((arg) => resolve(arg))
}

// 在主进程就绪后逐个打开文件（每个文件一个新窗口）
async function openFilesFromArgs(argv: string[]): Promise<void> {
  for (const filePath of extractFileArgs(argv)) {
    try {
      const existing = store?.findFileDraft(filePath)
      const record = existing ? store?.getOpenWindowForDraft(existing.id) : null
      if (record) { windows?.activateWindow(record.id); continue }
      const { readTextFile } = await import('./file-drafts')
      const { content } = await readTextFile(filePath)
      const draft = existing ? existing : store!.createFileDraft(filePath, content, filePath.toLowerCase().match(/\.(md|markdown)$/i) ? 'markdown' : 'txt')
      if (existing) store!.saveDraft({ id: existing.id, content, version: existing.version, scene: existing.scene, modelConfigId: existing.modelConfigId, displayMode: existing.displayMode })
      await windows?.createWindowForDraft(draft.id)
    } catch {
      // 单个文件打开失败不阻断其他文件
    }
  }
}

app.on('second-instance', (_event, argv) => {
  const files = extractFileArgs(argv)
  if (files.length) void openFilesFromArgs(argv)
  else windows?.showRecentOrCreate()
})

app.whenReady().then(async () => {
  app.setAppUserModelId('com.sheeptext.desktop')
  store = new DataStore(app.getPath('userData'))
  protocol.handle('sheeptext-asset', (request) => {
    try {
      const url = new URL(request.url)
      if (url.hostname !== 'local') return new Response('Not found', { status: 404 })
      const parts = url.pathname.split('/').filter(Boolean).map((part) => decodeURIComponent(part))
      if (parts.length !== 2 || !store) return new Response('Not found', { status: 404 })
      const assetPath = store.resolveDraftAssetPath(parts[0], parts[1])
      if (!existsSync(assetPath)) return new Response('Not found', { status: 404 })
      return net.fetch(pathToFileURL(assetPath).toString())
    } catch {
      return new Response('Not found', { status: 404 })
    }
  })
  windows = new WindowManager(store)
  const aiService = new AiService(store)
  registerIpc(store, aiService, windows)
  createTray(windows)
  windows.startDockMonitor()

  const startHidden = process.argv.includes('--hidden')
  await windows.restoreWorkspace(startHidden)
  // 冷启动命令行里携带的文件路径（文件关联/拖到图标）
  await openFilesFromArgs(process.argv)

  app.on('activate', () => windows?.showRecentOrCreate())
})

app.on('window-all-closed', () => {
  // Windows 下保留托盘进程，用户可随时恢复最近文稿。
})

app.on('before-quit', (event) => {
  if (windows && !windows.isQuitting()) {
    event.preventDefault()
    windows.requestQuit()
    return
  }
  quitting = true
  windows?.stopDockMonitor()
})

app.on('will-quit', () => {
  tray?.destroy()
  tray = null
  store?.close()
  store = null
})

function createTray(windowManager: WindowManager): void {
  const iconPath = app.isPackaged
    ? join(process.resourcesPath, 'tray.png')
    : join(__dirname, '../../resources/tray.png')
  const image = nativeImage.createFromPath(iconPath)
  tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image)
  tray.setToolTip('SheepText · 随手写，安心改')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开 SheepText', click: () => windowManager.showRecentOrCreate() },
    { label: '新建窗口', click: () => void windowManager.createNewWindow(true) },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        windowManager.requestQuit()
      }
    }
  ]))
  tray.on('click', () => windowManager.toggleRecentOrCreate())
}

process.on('uncaughtException', (error) => {
  console.error('[SheepText] uncaughtException', error)
  if (!quitting) windows?.broadcast('app:toast', { type: 'error', message: `程序发生异常：${error.message}` })
})



