import { app, BrowserWindow, screen } from 'electron'
import { writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import {
  DOCK_COLLAPSE_DELAY,
  DOCK_EXPAND_DELAY,
  DOCK_THRESHOLD,
  DOCK_VISIBLE_SIZE,
  WINDOW_DEFAULT_HEIGHT,
  WINDOW_DEFAULT_WIDTH,
  WINDOW_MIN_HEIGHT,
  WINDOW_MIN_WIDTH
} from '../shared/constants'
import type { AppSettings, DockSide, WindowInteractionState, WindowRecord } from '../shared/types'
import { DataStore } from './data-store'

type WindowRuntime = {
  browserWindow: BrowserWindow
  record: WindowRecord
  isCollapsed: boolean
  interaction: WindowInteractionState
  hoverStartedAt: number | null
  outsideStartedAt: number | null
  moveTimer: NodeJS.Timeout | null
  programmaticMove: boolean
  programmaticMoveTimer: NodeJS.Timeout | null
  closeApproved: boolean
  preferredWidth: number
  preferredHeight: number
}

const IDLE_INTERACTION: WindowInteractionState = {
  interacting: false,
  composing: false,
  drawerOpen: false,
  menuOpen: false,
  aiPreviewOpen: false
}

export class WindowManager {
  private readonly windows = new Map<string, WindowRuntime>()
  private dockTimer: NodeJS.Timeout | null = null
  private quitting = false
  private cascadeIndex = 0
  private pendingFlushIds = new Set<string>()
  private flushTimeout: NodeJS.Timeout | null = null

  constructor(private readonly store: DataStore) {}

  setQuitting(value: boolean): void {
    this.quitting = value
  }

  isQuitting(): boolean {
    return this.quitting
  }

  startDockMonitor(): void {
    if (this.dockTimer) return
    this.dockTimer = setInterval(() => this.monitorDockedWindows(), 100)
  }

  stopDockMonitor(): void {
    if (this.dockTimer) clearInterval(this.dockTimer)
    this.dockTimer = null
  }

  async restoreWorkspace(startHidden = false): Promise<void> {
    const records = this.store.getRecoveryWindows()
    if (records.length) {
      for (const record of records) await this.createWindow(record, startHidden)
      return
    }

    const draft = this.store.getMostRecentDraft() ?? this.store.createDraft()
    const record = this.store.createWindowRecord(draft.id, WINDOW_DEFAULT_WIDTH, WINDOW_DEFAULT_HEIGHT)
    await this.createWindow(record, startHidden)
  }

  async createNewWindow(show = true): Promise<void> {
    const draft = this.store.createDraft()
    const record = this.store.createWindowRecord(draft.id, WINDOW_DEFAULT_WIDTH, WINDOW_DEFAULT_HEIGHT)
    await this.createWindow(record, !show)
  }

  /** 为本地文件创建独立窗口（需求 F15：每个文件一个新窗口） */
  async createWindowForDraft(draftId: string, show = true): Promise<string> {
    const record = this.store.createWindowRecord(draftId, WINDOW_DEFAULT_WIDTH, WINDOW_DEFAULT_HEIGHT)
    const browserWindow = await this.createWindow(record, !show)
    return browserWindow.webContents.getURL().includes('windowId=')
      ? new URL(browserWindow.webContents.getURL()).searchParams.get('windowId') ?? record.id
      : record.id
  }

  async createWindow(record: WindowRecord, startHidden = false): Promise<BrowserWindow> {
    const preferredWidth = Math.max(record.width, WINDOW_MIN_WIDTH)
    const preferredHeight = Math.max(record.height, WINDOW_MIN_HEIGHT)
    const normalized = this.normalizeRecordBounds(record)
    normalized.isOpen = true
    normalized.fixedExpanded = false
    normalized.lastActiveAt = Date.now()
    this.store.upsertWindow({ ...normalized, width: preferredWidth, height: preferredHeight })

    const settings = this.store.getSettings()
    const browserWindow = new BrowserWindow({
      x: normalized.x ?? undefined,
      y: normalized.y ?? undefined,
      width: normalized.width,
      height: normalized.height,
      minWidth: WINDOW_MIN_WIDTH,
      minHeight: WINDOW_MIN_HEIGHT,
      show: false,
      frame: false,
      transparent: false,
      backgroundColor: '#f4f1eb',
      icon: app.isPackaged ? join(process.resourcesPath, 'icon.ico') : join(__dirname, '../../resources/icon.ico'),
      skipTaskbar: !settings.keepTaskbarButton,
      roundedCorners: true,
      thickFrame: true,
      autoHideMenuBar: true,
      resizable: true,
      maximizable: true,
      minimizable: true,
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    })

    browserWindow.setAlwaysOnTop(normalized.alwaysOnTop, 'floating')
    const runtime: WindowRuntime = {
      browserWindow,
      record: { ...normalized, width: preferredWidth, height: preferredHeight },
      isCollapsed: false,
      interaction: { ...IDLE_INTERACTION },
      hoverStartedAt: null,
      outsideStartedAt: null,
      moveTimer: null,
      programmaticMove: false,
      programmaticMoveTimer: null,
      closeApproved: false,
      preferredWidth,
      preferredHeight
    }
    this.windows.set(normalized.id, runtime)

    browserWindow.once('ready-to-show', () => {
      if (process.env.SHEEPTEXT_CAPTURE_PATH && this.windows.size === 1) {
        const captureWidth = Number(process.env.SHEEPTEXT_CAPTURE_WIDTH)
        const captureHeight = Number(process.env.SHEEPTEXT_CAPTURE_HEIGHT)
        if (Number.isFinite(captureWidth) && Number.isFinite(captureHeight)) {
          const display = screen.getPrimaryDisplay().workArea
          const width = Math.min(display.width, Math.max(WINDOW_MIN_WIDTH, Math.round(captureWidth)))
          const height = Math.min(display.height, Math.max(WINDOW_MIN_HEIGHT, Math.round(captureHeight)))
          browserWindow.setBounds({
            x: display.x + Math.round((display.width - width) / 2),
            y: display.y + Math.round((display.height - height) / 2),
            width,
            height
          })
        }
      }
      if (!startHidden) browserWindow.show()
      if (process.env.SHEEPTEXT_CAPTURE_PATH && this.windows.size === 1) {
        setTimeout(async () => {
          try {
            const captureView = process.env.SHEEPTEXT_CAPTURE_VIEW
            if (captureView === 'settings' || captureView === 'models' || captureView === 'settings-select') {
              await browserWindow.webContents.executeJavaScript(`document.querySelector('[title="设置"]')?.click()`)
              if (captureView === 'models') {
                await new Promise((resolveDelay) => setTimeout(resolveDelay, 180))
                await browserWindow.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.settings-nav button')).find((item) => item.textContent?.includes('模型配置'))?.click()`)
              } else if (captureView === 'settings-select') {
                await new Promise((resolveDelay) => setTimeout(resolveDelay, 180))
                await browserWindow.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.settings-scroll .select-trigger')).at(-1)?.click()`)
              }
            } else if (captureView === 'history' || captureView === 'history-delete') {
              await browserWindow.webContents.executeJavaScript(`document.querySelector('[title="文稿历史"]')?.click()`)
              await new Promise((resolveDelay) => setTimeout(resolveDelay, 140))
              if (!await browserWindow.webContents.executeJavaScript(`Boolean(document.querySelector('.history-drawer'))`)) {
                await browserWindow.webContents.executeJavaScript(`document.querySelector('[title="文稿历史"]')?.click()`)
              }
              if (captureView === 'history-delete') {
                await new Promise((resolveDelay) => setTimeout(resolveDelay, 220))
                await browserWindow.webContents.executeJavaScript(`document.querySelector('.history-delete-button')?.click()`)
              }
            } else if (captureView === 'new-menu') {
              await browserWindow.webContents.executeJavaScript(`document.querySelector('.quick-new-menu')?.dispatchEvent(new MouseEvent('mouseenter'))`)
            } else if (captureView === 'scene-menu') {
              await browserWindow.webContents.executeJavaScript(`document.querySelector('.scene-button')?.click()`)
            } else if (captureView === 'markdown') {
              await browserWindow.webContents.executeJavaScript(`Array.from(document.querySelectorAll('button')).find((item) => item.textContent?.includes('Markdown'))?.click()`)
            } else if (captureView === 'search') {
              await browserWindow.webContents.executeJavaScript(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true, cancelable: true }))`)
            } else if (captureView === 'font-size') {
              await browserWindow.webContents.executeJavaScript(`document.querySelector('.cm-content')?.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, ctrlKey: true, bubbles: true, cancelable: true }))`)
              await new Promise((resolveDelay) => setTimeout(resolveDelay, 700))
            } else if (captureView === 'paste-image') {
              await browserWindow.webContents.executeJavaScript(`new Promise((resolveCapture) => {
                const canvas = document.createElement('canvas')
                canvas.width = 120
                canvas.height = 72
                const context = canvas.getContext('2d')
                if (context) {
                  const gradient = context.createLinearGradient(0, 0, 120, 72)
                  gradient.addColorStop(0, '#6f5bd8')
                  gradient.addColorStop(1, '#61c4a8')
                  context.fillStyle = gradient
                  context.fillRect(0, 0, 120, 72)
                  context.fillStyle = '#ffffff'
                  context.font = '600 18px sans-serif'
                  context.fillText('SheepText', 15, 42)
                }
                canvas.toBlob((blob) => {
                  if (!blob) return resolveCapture(false)
                  const transfer = new DataTransfer()
                  transfer.items.add(new File([blob], 'clipboard.png', { type: 'image/png' }))
                  const target = document.querySelector('.cm-content')
                  const event = new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true })
                  target?.dispatchEvent(event)
                  resolveCapture(Boolean(target))
                }, 'image/png')
              })`)
              await new Promise((resolveDelay) => setTimeout(resolveDelay, 900))
            }
            await new Promise((resolveDelay) => setTimeout(resolveDelay, 500))
            const image = await browserWindow.webContents.capturePage()
            await writeFile(resolve(process.env.SHEEPTEXT_CAPTURE_PATH as string), image.toPNG())
            this.quitting = true
            app.quit()
          } catch (error) {
            console.error('[SheepText] screenshot capture failed', error)
            app.exit(1)
          }
        }, 1800)
      }
    })
    if (process.env.ELECTRON_RENDERER_URL) {
      const separator = process.env.ELECTRON_RENDERER_URL.includes('?') ? '&' : '?'
      await browserWindow.loadURL(`${process.env.ELECTRON_RENDERER_URL}${separator}windowId=${encodeURIComponent(normalized.id)}`)
    } else {
      await browserWindow.loadFile(join(__dirname, '../renderer/index.html'), { query: { windowId: normalized.id } })
    }


    browserWindow.on('focus', () => {
      runtime.record.lastActiveAt = Date.now()
      this.store.upsertWindow(runtime.record)
    })
    browserWindow.on('move', () => this.scheduleMoveSettled(runtime))
    browserWindow.on('will-resize', (_event, nextBounds) => {
      if (runtime.programmaticMove || runtime.isCollapsed || browserWindow.isMaximized()) return
      runtime.preferredWidth = Math.max(WINDOW_MIN_WIDTH, nextBounds.width)
      runtime.preferredHeight = Math.max(WINDOW_MIN_HEIGHT, nextBounds.height)
    })
    browserWindow.on('resize', () => this.saveWindowBounds(runtime))
    browserWindow.on('close', (event) => {
      if (!this.quitting && !runtime.closeApproved) {
        event.preventDefault()
        browserWindow.webContents.send('window:request-close')
        return
      }
      this.saveWindowBounds(runtime)
      if (!this.quitting) {
        runtime.record.isOpen = false
        this.store.markWindowClosed(runtime.record.id)
      }
    })
    browserWindow.on('closed', () => {
      if (runtime.moveTimer) clearTimeout(runtime.moveTimer)
      if (runtime.programmaticMoveTimer) clearTimeout(runtime.programmaticMoveTimer)
      runtime.moveTimer = null
      runtime.programmaticMoveTimer = null
      this.windows.delete(runtime.record.id)
      if (!this.quitting && this.windows.size === 0 && !this.store.getSettings().closeToTray) {
        this.quitting = true
        app.quit()
      }
    })

    return browserWindow
  }

  getBrowserWindow(windowId: string): BrowserWindow | null {
    return this.windows.get(windowId)?.browserWindow ?? null
  }

  activateWindow(windowId: string): boolean {
    const runtime = this.windows.get(windowId)
    if (!runtime) return false
    if (runtime.isCollapsed) this.expand(runtime)
    if (runtime.browserWindow.isMinimized()) runtime.browserWindow.restore()
    runtime.browserWindow.show()
    runtime.browserWindow.focus()
    return true
  }

  showRecentOrCreate(): void {
    const runtimes = [...this.windows.values()].sort((a, b) => b.record.lastActiveAt - a.record.lastActiveAt)
    if (runtimes[0]) {
      this.activateWindow(runtimes[0].record.id)
      return
    }
    const draft = this.store.getMostRecentDraft() ?? this.store.createDraft()
    // 无存活窗口时，优先继承最近关闭窗口的有效几何，避免回退默认尺寸。
    const lastBounds = this.store.getLastClosedWindowBounds()
    const width = lastBounds?.width ?? WINDOW_DEFAULT_WIDTH
    const height = lastBounds?.height ?? WINDOW_DEFAULT_HEIGHT
    const record = this.store.createWindowRecord(draft.id, width, height)
    if (lastBounds) {
      record.x = lastBounds.x
      record.y = lastBounds.y
      record.displayId = lastBounds.displayId
    }
    void this.createWindow(record, false)
  }

  toggleRecentOrCreate(): void {
    const runtimes = [...this.windows.values()].sort((a, b) => b.record.lastActiveAt - a.record.lastActiveAt)
    const runtime = runtimes[0]
    if (!runtime) {
      this.showRecentOrCreate()
      return
    }
    if (runtime.browserWindow.isVisible() && runtime.browserWindow.isFocused()) {
      runtime.browserWindow.hide()
      return
    }
    this.activateWindow(runtime.record.id)
  }

  switchDraft(windowId: string, draftId: string): void {
    const runtime = this.windows.get(windowId)
    if (!runtime) throw new Error('窗口不存在')
    runtime.record.draftId = draftId
    runtime.record.lastActiveAt = Date.now()
    this.store.setWindowDraft(windowId, draftId)
  }

  closeWindow(windowId: string): void {
    const runtime = this.windows.get(windowId)
    if (!runtime) return
    runtime.closeApproved = true
    runtime.browserWindow.close()
  }

  minimizeWindow(windowId: string): void {
    const runtime = this.windows.get(windowId)
    if (!runtime) return
    // 最小化前先落库有效几何，避免防抖期间隐藏或退出丢失最新位置。
    this.saveWindowBounds(runtime)
    runtime.browserWindow.minimize()
  }

  hideWindow(windowId: string): void {
    const runtime = this.windows.get(windowId)
    if (!runtime) return
    // 隐藏前先落库有效几何，保证托盘重开或重启时使用最近位置。
    this.saveWindowBounds(runtime)
    runtime.browserWindow.hide()
  }

  setAlwaysOnTop(windowId: string, value: boolean): void {
    const runtime = this.requireRuntime(windowId)
    runtime.record.alwaysOnTop = value
    if (value && runtime.isCollapsed) this.expand(runtime)
    runtime.browserWindow.setAlwaysOnTop(value, 'floating')
    this.store.upsertWindow(runtime.record)
  }

  toggleMaximizeWindow(windowId: string): void {
    const runtime = this.requireRuntime(windowId)
    if (runtime.isCollapsed) this.expand(runtime)
    if (runtime.record.isDocked) this.clearDockState(runtime)
    if (runtime.browserWindow.isMaximized()) runtime.browserWindow.unmaximize()
    else runtime.browserWindow.maximize()
  }

  resetWindowSize(windowId: string): void {
    const runtime = this.requireRuntime(windowId)
    if (runtime.browserWindow.isMaximized()) runtime.browserWindow.unmaximize()
    if (runtime.isCollapsed) this.expand(runtime)
    if (runtime.record.isDocked) this.clearDockState(runtime)

    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    const area = display.workArea
    const width = Math.min(WINDOW_DEFAULT_WIDTH, Math.max(WINDOW_MIN_WIDTH, area.width - 80))
    const height = Math.min(WINDOW_DEFAULT_HEIGHT, Math.max(WINDOW_MIN_HEIGHT, area.height - 80))
    const bounds = {
      x: area.x + Math.round((area.width - width) / 2),
      y: area.y + Math.round((area.height - height) / 2),
      width,
      height
    }
    runtime.preferredWidth = bounds.width
    runtime.preferredHeight = bounds.height
    runtime.record.x = bounds.x
    runtime.record.y = bounds.y
    runtime.record.width = bounds.width
    runtime.record.height = bounds.height
    runtime.record.displayId = String(display.id)
    runtime.record.expandedX = null
    runtime.record.expandedY = null
    runtime.record.lastActiveAt = Date.now()
    this.setBounds(runtime, bounds)
    this.store.upsertWindow(runtime.record)
    runtime.browserWindow.show()
    runtime.browserWindow.focus()
  }

  expandDockedWindow(windowId: string): void {
    const runtime = this.requireRuntime(windowId)
    if (runtime.isCollapsed) this.expand(runtime)
    runtime.browserWindow.show()
    runtime.browserWindow.focus()
  }

  applySettings(settings: AppSettings): void {
    for (const runtime of this.windows.values()) {
      this.setTaskbarVisibility(runtime, settings)
      if (!settings.dockEnabled && runtime.record.isDocked) {
        if (runtime.isCollapsed) this.expand(runtime)
        this.clearDockState(runtime)
      }
    }
  }

  setInteractionState(windowId: string, state: WindowInteractionState): void {
    const runtime = this.windows.get(windowId)
    if (runtime) runtime.interaction = state
  }

  collapseOrHide(windowId: string): void {
    const runtime = this.requireRuntime(windowId)
    if (runtime.record.isDocked) this.collapse(runtime)
    else runtime.browserWindow.hide()
  }

  notifyDockState(runtime: WindowRuntime): void {
    if (!runtime.browserWindow.isDestroyed()) {
      runtime.browserWindow.webContents.send('window:dock-state', {
        isDocked: runtime.record.isDocked,
        isCollapsed: runtime.isCollapsed,
        dockSide: runtime.record.dockSide
      })
    }
  }

  broadcast(channel: string, payload: unknown): void {
    for (const runtime of this.windows.values()) {
      if (!runtime.browserWindow.isDestroyed()) runtime.browserWindow.webContents.send(channel, payload)
    }
  }

  requestQuit(): void {
    if (this.quitting || this.pendingFlushIds.size) return
    const active = [...this.windows.values()].filter((runtime) => !runtime.browserWindow.isDestroyed())
    if (!active.length) {
      this.finalizeQuit()
      return
    }
    this.pendingFlushIds = new Set(active.map((runtime) => runtime.record.id))
    active.forEach((runtime) => runtime.browserWindow.webContents.send('app:before-quit'))
    this.flushTimeout = setTimeout(() => this.finalizeQuit(), 5000)
  }

  notifyFlushComplete(windowId: string, success: boolean): void {
    if (!this.pendingFlushIds.has(windowId)) return
    if (!success) {
      if (this.flushTimeout) clearTimeout(this.flushTimeout)
      this.flushTimeout = null
      this.pendingFlushIds.clear()
      const runtime = this.windows.get(windowId)
      runtime?.browserWindow.show()
      runtime?.browserWindow.focus()
      runtime?.browserWindow.webContents.send('app:toast', { type: 'error', message: '保存失败，已取消退出，请先处理文稿保存问题' })
      return
    }
    this.pendingFlushIds.delete(windowId)
    if (!this.pendingFlushIds.size) this.finalizeQuit()
  }

  private finalizeQuit(): void {
    if (this.flushTimeout) clearTimeout(this.flushTimeout)
    this.flushTimeout = null
    this.pendingFlushIds.clear()
    this.quitting = true
    app.quit()
  }

  private requireRuntime(windowId: string): WindowRuntime {
    const runtime = this.windows.get(windowId)
    if (!runtime) throw new Error('窗口不存在')
    return runtime
  }

  private normalizeRecordBounds(record: WindowRecord): WindowRecord {
    const displays = screen.getAllDisplays()
    const display = displays.find((item) => String(item.id) === record.displayId)
      ?? (record.x !== null && record.y !== null ? screen.getDisplayNearestPoint({ x: record.x, y: record.y }) : screen.getPrimaryDisplay())
    const area = display.workArea
    const width = Math.min(Math.max(record.width, WINDOW_MIN_WIDTH), area.width)
    const height = Math.min(Math.max(record.height, WINDOW_MIN_HEIGHT), area.height)
    const offset = (this.cascadeIndex++ % 6) * 28
    const fallbackX = area.x + Math.round((area.width - width) / 2) + offset
    const fallbackY = area.y + Math.round((area.height - height) / 2) + offset
    const sourceX = record.isDocked && record.expandedX !== null ? record.expandedX : record.x
    const sourceY = record.isDocked && record.expandedY !== null ? record.expandedY : record.y
    const x = Math.min(Math.max(sourceX ?? fallbackX, area.x), area.x + area.width - width)
    const y = Math.min(Math.max(sourceY ?? fallbackY, area.y), area.y + area.height - height)
    return { ...record, x, y, width, height, displayId: String(display.id), expandedX: record.isDocked ? x : record.expandedX, expandedY: record.isDocked ? y : record.expandedY }
  }

  private scheduleMoveSettled(runtime: WindowRuntime): void {
    if (runtime.programmaticMove || runtime.isCollapsed) return
    if (runtime.moveTimer) clearTimeout(runtime.moveTimer)
    runtime.moveTimer = setTimeout(() => {
      runtime.moveTimer = null
      this.handleMoveSettled(runtime)
    }, 180)
  }

  private handleMoveSettled(runtime: WindowRuntime): void {
    if (runtime.browserWindow.isDestroyed() || runtime.isCollapsed || runtime.browserWindow.isMaximized()) return
    let bounds = runtime.browserWindow.getBounds()
    const display = screen.getDisplayMatching(bounds)
    const area = display.workArea
    const desiredWidth = Math.min(runtime.preferredWidth, area.width)
    const desiredHeight = Math.min(runtime.preferredHeight, area.height)
    if (bounds.width !== desiredWidth || bounds.height !== desiredHeight) {
      bounds = { ...bounds, width: desiredWidth, height: desiredHeight }
      this.setBounds(runtime, bounds)
    }
    const settings = this.store.getSettings()

    if (!settings.dockEnabled) {
      if (runtime.record.isDocked) this.clearDockState(runtime)
      this.persistWindowBounds(runtime, bounds, display)
      return
    }

    const areaRight = area.x + area.width
    const areaBottom = area.y + area.height
    const taskbarSides = this.getTaskbarSides(display)
    const allCandidates: Array<{ side: Exclude<DockSide, null>; distance: number }> = [
      { side: 'left', distance: Math.abs(bounds.x - area.x) },
      { side: 'right', distance: Math.abs(areaRight - (bounds.x + bounds.width)) },
      { side: 'top', distance: Math.abs(bounds.y - area.y) },
      { side: 'bottom', distance: Math.abs(areaBottom - (bounds.y + bounds.height)) }
    ]
    const adjacentDisplaySides = this.getAdjacentDisplaySides(display, bounds)
    const candidates = allCandidates.filter((item) => !taskbarSides.has(item.side) && !adjacentDisplaySides.has(item.side))
    const outsideSides = new Set<DockSide>()
    if (bounds.x < area.x) outsideSides.add('left')
    if (bounds.x + bounds.width > areaRight) outsideSides.add('right')
    if (bounds.y < area.y) outsideSides.add('top')
    if (bounds.y + bounds.height > areaBottom) outsideSides.add('bottom')
    const candidate = candidates
      .filter((item) => item.distance <= DOCK_THRESHOLD || outsideSides.has(item.side))
      .sort((left, right) => left.distance - right.distance)[0]

    if (!candidate) {
      if (runtime.record.isDocked) this.clearDockState(runtime)
      this.persistWindowBounds(runtime, bounds, display)
      return
    }

    const snapped = { ...bounds }
    if (candidate.side === 'left') snapped.x = area.x
    if (candidate.side === 'right') snapped.x = areaRight - bounds.width
    if (candidate.side === 'top') snapped.y = area.y
    if (candidate.side === 'bottom') snapped.y = areaBottom - bounds.height
    snapped.x = Math.min(Math.max(snapped.x, area.x), areaRight - bounds.width)
    snapped.y = Math.min(Math.max(snapped.y, area.y), areaBottom - bounds.height)

    runtime.record.isDocked = true
    runtime.record.dockSide = candidate.side
    runtime.record.expandedX = snapped.x
    runtime.record.expandedY = snapped.y
    runtime.record.x = snapped.x
    runtime.record.y = snapped.y
    runtime.record.width = runtime.preferredWidth
    runtime.record.height = runtime.preferredHeight
    runtime.record.displayId = String(display.id)
    runtime.record.lastActiveAt = Date.now()
    runtime.outsideStartedAt = null
    this.store.upsertWindow(runtime.record)
    this.setBounds(runtime, snapped)
    this.notifyDockState(runtime)
  }

  private saveWindowBounds(runtime: WindowRuntime): void {
    if (runtime.browserWindow.isDestroyed() || runtime.isCollapsed || runtime.programmaticMove || runtime.browserWindow.isMaximized()) return
    const bounds = runtime.browserWindow.getBounds()
    const display = screen.getDisplayMatching(bounds)
    this.persistWindowBounds(runtime, bounds, display)
  }

  private persistWindowBounds(runtime: WindowRuntime, bounds: Electron.Rectangle, display: Electron.Display): void {
    runtime.record.x = bounds.x
    runtime.record.y = bounds.y
    runtime.record.width = runtime.preferredWidth
    runtime.record.height = runtime.preferredHeight
    runtime.record.displayId = String(display.id)
    runtime.record.lastActiveAt = Date.now()
    if (runtime.record.isDocked) {
      runtime.record.expandedX = bounds.x
      runtime.record.expandedY = bounds.y
    }
    this.store.upsertWindow(runtime.record)
  }

  private monitorDockedWindows(): void {
    const now = Date.now()
    const cursor = screen.getCursorScreenPoint()
    const dockEnabled = this.store.getSettings().dockEnabled
    for (const runtime of this.windows.values()) {
      if (runtime.browserWindow.isDestroyed()) continue
      if (!dockEnabled) {
        if (runtime.record.isDocked) {
          if (runtime.isCollapsed) this.expand(runtime)
          this.clearDockState(runtime)
        }
        continue
      }
      if (!runtime.record.isDocked || !runtime.browserWindow.isVisible()) continue
      const bounds = runtime.browserWindow.getBounds()
      const display = this.getRuntimeDisplay(runtime)
      if (runtime.record.dockSide && this.getTaskbarSides(display).has(runtime.record.dockSide)) {
        if (runtime.isCollapsed) this.expand(runtime)
        this.clearDockState(runtime)
        continue
      }
      if (runtime.record.alwaysOnTop) {
        if (runtime.isCollapsed) this.expand(runtime)
        runtime.outsideStartedAt = null
        continue
      }

      if (runtime.isCollapsed) {
        if (this.isCursorOverCollapsedStrip(runtime.record.dockSide, cursor, bounds, display.workArea)) {
          runtime.hoverStartedAt ??= now
          if (now - runtime.hoverStartedAt >= DOCK_EXPAND_DELAY) this.expand(runtime)
        } else {
          runtime.hoverStartedAt = null
        }
        continue
      }

      const inside = cursor.x >= bounds.x - 3 && cursor.x <= bounds.x + bounds.width + 3 &&
        cursor.y >= bounds.y - 3 && cursor.y <= bounds.y + bounds.height + 3
      const blocked = runtime.interaction.composing || runtime.interaction.drawerOpen ||
        runtime.interaction.menuOpen || runtime.interaction.aiPreviewOpen
      if (inside || blocked) {
        runtime.outsideStartedAt = null
      } else {
        runtime.outsideStartedAt ??= now
        if (now - runtime.outsideStartedAt >= DOCK_COLLAPSE_DELAY) this.collapse(runtime)
      }
    }
  }

  private collapse(runtime: WindowRuntime): void {
    if (!runtime.record.isDocked || !runtime.record.dockSide || runtime.record.alwaysOnTop || runtime.isCollapsed || runtime.browserWindow.isDestroyed()) return
    const bounds = runtime.browserWindow.getBounds()
    const area = this.getRuntimeDisplay(runtime).workArea
    runtime.record.expandedX = bounds.x
    runtime.record.expandedY = bounds.y
    runtime.record.width = runtime.preferredWidth
    runtime.record.height = runtime.preferredHeight
    runtime.isCollapsed = true
    this.setTaskbarVisibility(runtime)
    runtime.browserWindow.setAlwaysOnTop(true, 'screen-saver')
    runtime.outsideStartedAt = null
    const collapsed = { ...bounds }
    if (runtime.record.dockSide === 'left') collapsed.x = area.x - bounds.width + DOCK_VISIBLE_SIZE
    if (runtime.record.dockSide === 'right') collapsed.x = area.x + area.width - DOCK_VISIBLE_SIZE
    if (runtime.record.dockSide === 'top') collapsed.y = area.y - bounds.height + DOCK_VISIBLE_SIZE
    if (runtime.record.dockSide === 'bottom') collapsed.y = area.y + area.height - DOCK_VISIBLE_SIZE
    this.animateBounds(runtime, collapsed)
    this.store.upsertWindow(runtime.record)
    this.notifyDockState(runtime)
  }

  private expand(runtime: WindowRuntime): void {
    if (!runtime.record.isDocked || !runtime.isCollapsed || runtime.browserWindow.isDestroyed()) return
    const wasVisible = runtime.browserWindow.isVisible()
    const display = this.getRuntimeDisplay(runtime)
    const area = display.workArea
    const width = Math.min(runtime.preferredWidth, area.width)
    const height = Math.min(runtime.preferredHeight, area.height)
    const x = Math.min(Math.max(runtime.record.expandedX ?? area.x, area.x), area.x + area.width - width)
    const y = Math.min(Math.max(runtime.record.expandedY ?? area.y, area.y), area.y + area.height - height)
    runtime.isCollapsed = false
    this.setTaskbarVisibility(runtime)
    runtime.hoverStartedAt = null
    runtime.outsideStartedAt = null
    this.animateBounds(runtime, { x, y, width, height })
    runtime.browserWindow.setAlwaysOnTop(runtime.record.alwaysOnTop, 'floating')
    if (wasVisible) runtime.browserWindow.showInactive()
    this.notifyDockState(runtime)
  }

  private clearDockState(runtime: WindowRuntime): void {
    runtime.record.isDocked = false
    runtime.record.dockSide = null
    runtime.record.expandedX = null
    runtime.record.expandedY = null
    runtime.isCollapsed = false
    this.setTaskbarVisibility(runtime)
    runtime.hoverStartedAt = null
    runtime.outsideStartedAt = null
    this.store.upsertWindow(runtime.record)
    this.notifyDockState(runtime)
  }

  private getRuntimeDisplay(runtime: WindowRuntime): Electron.Display {
    return screen.getAllDisplays().find((item) => String(item.id) === runtime.record.displayId)
      ?? screen.getDisplayMatching(runtime.browserWindow.getBounds())
  }

  private isCursorOverCollapsedStrip(
    side: DockSide,
    cursor: Electron.Point,
    bounds: Electron.Rectangle,
    area: Electron.Rectangle
  ): boolean {
    const areaRight = area.x + area.width
    const areaBottom = area.y + area.height
    if (side === 'left') return cursor.x >= area.x - 3 && cursor.x <= area.x + DOCK_VISIBLE_SIZE + 3 && cursor.y >= bounds.y && cursor.y <= bounds.y + bounds.height
    if (side === 'right') return cursor.x >= areaRight - DOCK_VISIBLE_SIZE - 3 && cursor.x <= areaRight + 3 && cursor.y >= bounds.y && cursor.y <= bounds.y + bounds.height
    if (side === 'top') return cursor.y >= area.y - 3 && cursor.y <= area.y + DOCK_VISIBLE_SIZE + 3 && cursor.x >= bounds.x && cursor.x <= bounds.x + bounds.width
    if (side === 'bottom') return cursor.y >= areaBottom - DOCK_VISIBLE_SIZE - 3 && cursor.y <= areaBottom + 3 && cursor.x >= bounds.x && cursor.x <= bounds.x + bounds.width
    return false
  }

  private getTaskbarSides(display: Electron.Display): Set<Exclude<DockSide, null>> {
    const bounds = display.bounds
    const area = display.workArea
    const sides = new Set<Exclude<DockSide, null>>()
    if (area.x > bounds.x) sides.add('left')
    if (area.y > bounds.y) sides.add('top')
    if (area.x + area.width < bounds.x + bounds.width) sides.add('right')
    if (area.y + area.height < bounds.y + bounds.height) sides.add('bottom')
    return sides
  }

  private getAdjacentDisplaySides(display: Electron.Display, windowBounds: Electron.Rectangle): Set<Exclude<DockSide, null>> {
    const area = display.workArea
    const areaRight = area.x + area.width
    const areaBottom = area.y + area.height
    const windowRight = windowBounds.x + windowBounds.width
    const windowBottom = windowBounds.y + windowBounds.height
    const sides = new Set<Exclude<DockSide, null>>()
    const overlaps = (firstStart: number, firstEnd: number, secondStart: number, secondEnd: number): boolean =>
      Math.min(firstEnd, secondEnd) > Math.max(firstStart, secondStart)

    for (const other of screen.getAllDisplays()) {
      if (other.id === display.id) continue
      const otherBounds = other.bounds
      const otherRight = otherBounds.x + otherBounds.width
      const otherBottom = otherBounds.y + otherBounds.height
      const verticalOverlap = overlaps(windowBounds.y, windowBottom, otherBounds.y, otherBottom)
      const horizontalOverlap = overlaps(windowBounds.x, windowRight, otherBounds.x, otherRight)

      if (verticalOverlap && Math.abs(otherRight - area.x) <= 1) sides.add('left')
      if (verticalOverlap && Math.abs(otherBounds.x - areaRight) <= 1) sides.add('right')
      if (horizontalOverlap && Math.abs(otherBottom - area.y) <= 1) sides.add('top')
      if (horizontalOverlap && Math.abs(otherBounds.y - areaBottom) <= 1) sides.add('bottom')
    }
    return sides
  }

  private setTaskbarVisibility(runtime: WindowRuntime, settings: AppSettings = this.store.getSettings()): void {
    if (runtime.browserWindow.isDestroyed()) return
    const keepTaskbarButton = settings.keepTaskbarButton && !(
      runtime.isCollapsed && settings.dockEnabled && settings.hideTaskbarWhenDocked
    )
    runtime.browserWindow.setSkipTaskbar(!keepTaskbarButton)
  }

  private animateBounds(runtime: WindowRuntime, target: Electron.Rectangle): void {
    if (runtime.browserWindow.isDestroyed()) return
    const start = runtime.browserWindow.getBounds()
    const duration = 190
    const startedAt = Date.now()
    if (runtime.programmaticMoveTimer) clearTimeout(runtime.programmaticMoveTimer)
    runtime.programmaticMove = true
    const tick = (): void => {
      if (runtime.browserWindow.isDestroyed()) return
      const progress = Math.min(1, (Date.now() - startedAt) / duration)
      const eased = progress < 0.5
        ? 4 * progress * progress * progress
        : 1 - Math.pow(-2 * progress + 2, 3) / 2
      runtime.browserWindow.setBounds({
        x: Math.round(start.x + (target.x - start.x) * eased),
        y: Math.round(start.y + (target.y - start.y) * eased),
        width: target.width,
        height: target.height
      })
      if (progress < 1) {
        runtime.programmaticMoveTimer = setTimeout(tick, 16)
      } else {
        runtime.programmaticMove = false
        runtime.programmaticMoveTimer = null
      }
    }
    tick()
  }

  private setBounds(runtime: WindowRuntime, bounds: Electron.Rectangle): void {
    if (runtime.browserWindow.isDestroyed()) return
    if (runtime.programmaticMoveTimer) clearTimeout(runtime.programmaticMoveTimer)
    runtime.programmaticMove = true
    runtime.browserWindow.setBounds(bounds, true)
    runtime.programmaticMoveTimer = setTimeout(() => {
      runtime.programmaticMove = false
      runtime.programmaticMoveTimer = null
    }, 220)
  }
}





