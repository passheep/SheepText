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
let fileService: ReturnType<typeof registerIpc> | null = null
let workspaceReady = false
let drainingOpenQueue = false
const openQueue: Array<{ argv: string[]; cwd: string; activateIfEmpty: boolean }> = [
  { argv: process.argv, cwd: process.cwd(), activateIfEmpty: false }
]

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
  return argv.filter((arg) => /\.(txt|md|markdown)$/i.test(arg) && !arg.startsWith('-'))
}

// 就绪前到达的 second-instance 不丢弃；相对路径必须以发起进程的 cwd 解析。
async function drainOpenQueue(): Promise<void> {
  if (!workspaceReady || !fileService || drainingOpenQueue) return
  drainingOpenQueue = true
  try {
    while (openQueue.length) {
      const request = openQueue.shift()!
      const files = extractFileArgs(request.argv)
      if (!files.length && request.activateIfEmpty) windows?.showRecentOrCreate()
      for (const filePath of files) {
        try { await fileService.openLocalFile(filePath, request.cwd) }
        catch (error) {
          console.error('[SheepText] openLocalFile', filePath, error)
          // 单个文件失败不阻断队列，但必须告知用户，不能静默吞掉。
          if (windows && store) {
            const live = store.getRecoveryWindows().some((record) => windows?.getBrowserWindow(record.id))
            if (live) windows.showRecentOrCreate()
            else await windows.createNewWindow(true)
            windows.broadcast('app:toast', { type: 'error', message: `打开文件失败：${filePath}：${error instanceof Error ? error.message : String(error)}` })
          }
        }
      }
    }
  } finally { drainingOpenQueue = false }
}

app.on('second-instance', (_event, argv, cwd) => {
  openQueue.push({ argv, cwd, activateIfEmpty: true })
  void drainOpenQueue()
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
  fileService = registerIpc(store, aiService, windows)
  createTray(windows)
  windows.startDockMonitor()

  const startHidden = process.argv.includes('--hidden')
  await windows.restoreWorkspace(startHidden)
  workspaceReady = true
  await drainOpenQueue()

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



