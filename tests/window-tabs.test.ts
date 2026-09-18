import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, vi } from 'vitest'
import { DataStore } from '../src/main/data-store'
import { WindowManager } from '../src/main/window-manager'
import type { Draft } from '../src/shared/types'

// DataStore 只从 electron 取 safeStorage；窗口层用例只接触 requireRuntime 与标题设置，
// 不会真正创建 BrowserWindow。
vi.mock('electron', () => ({
  app: { isPackaged: false },
  BrowserWindow: class {},
  screen: {
    getAllDisplays: () => [],
    getPrimaryDisplay: () => ({ id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1080 } })
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: () => { throw new Error('测试环境不支持加密') },
    decryptString: () => { throw new Error('测试环境不支持解密') }
  }
}))

// 临时目录保留供复查，不做永久删除式清理。
function tempStore(): DataStore {
  return new DataStore(mkdtempSync(join(tmpdir(), 'sheeptext-tabs-')))
}

describe('窗口多标签数据层', () => {
  it('旧库升级后每个窗口恰好一个标签', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sheeptext-tabs-migrate-'))
    const dataDir = join(dir, 'data')
    mkdirSync(dataDir, { recursive: true })
    // 手工构造旧结构：只有 drafts 与 window_states，没有 window_tabs、也没有 file_path。
    const legacy = new DatabaseSync(join(dataDir, 'sheeptext.db'))
    legacy.exec(`
      CREATE TABLE drafts (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        version INTEGER NOT NULL DEFAULT 0,
        scene TEXT NOT NULL DEFAULT 'general',
        model_config_id TEXT,
        display_mode TEXT NOT NULL DEFAULT 'txt'
      );
      CREATE TABLE window_states (
        id TEXT PRIMARY KEY,
        draft_id TEXT NOT NULL,
        x INTEGER,
        y INTEGER,
        width INTEGER NOT NULL,
        height INTEGER NOT NULL,
        display_id TEXT,
        dock_side TEXT,
        is_docked INTEGER NOT NULL DEFAULT 0,
        expanded_x INTEGER,
        expanded_y INTEGER,
        always_on_top INTEGER NOT NULL DEFAULT 0,
        fixed_expanded INTEGER NOT NULL DEFAULT 0,
        is_open INTEGER NOT NULL DEFAULT 1,
        last_active_at INTEGER NOT NULL
      );
      INSERT INTO drafts(id, content, created_at, updated_at, version, scene, display_mode)
        VALUES ('legacy-draft', '旧文稿', 1, 1, 0, 'general', 'txt');
      INSERT INTO window_states(id, draft_id, width, height, last_active_at)
        VALUES ('legacy-window', 'legacy-draft', 860, 680, 1);
    `)
    legacy.close()

    const store = new DataStore(dir)
    try {
      expect(store.listWindowTabs('legacy-window')).toEqual(['legacy-draft'])
      expect(store.countWindowTabs('legacy-window')).toBe(1)
      expect(store.getWindow('legacy-window')?.draftId).toBe('legacy-draft')
      // 非活动标签同样算「已打开」。
      expect(store.getOpenWindowForDraft('legacy-draft')?.id).toBe('legacy-window')
    } finally {
      store.close()
    }
  })

  it('addWindowTab 追加到末尾并切换活动文稿', () => {
    const store = tempStore()
    try {
      const first = store.createDraft('第一行')
      const record = store.createWindowRecord(first.id, 860, 680)
      expect(store.listWindowTabs(record.id)).toEqual([first.id])

      const second = store.createDraft('第二行')
      const third = store.createDraft()
      store.addWindowTab(record.id, second.id)
      store.addWindowTab(record.id, third.id)
      expect(store.listWindowTabs(record.id)).toEqual([first.id, second.id, third.id])
      expect(store.countWindowTabs(record.id)).toBe(3)
      expect(store.getWindow(record.id)?.draftId).toBe(third.id)

      // 重复添加不产生重复行，但仍把该文稿设为活动。
      store.addWindowTab(record.id, first.id)
      expect(store.listWindowTabs(record.id)).toEqual([first.id, second.id, third.id])
      expect(store.getWindow(record.id)?.draftId).toBe(first.id)
    } finally {
      store.close()
    }
  })

  it('reorderWindowTabs 按给定顺序重排并忽略非本窗口文稿', () => {
    const store = tempStore()
    try {
      const first = store.createDraft('A')
      const record = store.createWindowRecord(first.id, 860, 680)
      const second = store.createDraft('B')
      const third = store.createDraft('C')
      store.addWindowTab(record.id, second.id)
      store.addWindowTab(record.id, third.id)

      store.reorderWindowTabs(record.id, [third.id, 'unknown-draft', first.id, second.id])
      expect(store.listWindowTabs(record.id)).toEqual([third.id, first.id, second.id])
      expect(store.countWindowTabs(record.id)).toBe(3)
    } finally {
      store.close()
    }
  })

  it('removeWindowTab 删除标签，清空后按窗口层约定补空白文稿', () => {
    const store = tempStore()
    try {
      const first = store.createDraft('仅有一个标签')
      const record = store.createWindowRecord(first.id, 860, 680)
      store.removeWindowTab(record.id, first.id)
      expect(store.listWindowTabs(record.id)).toEqual([])
      expect(store.countWindowTabs(record.id)).toBe(0)

      // window-manager.closeTab 的兜底流程：无标签时创建空白文稿并补入。
      const blank = store.createDraft()
      store.addWindowTab(record.id, blank.id)
      expect(store.listWindowTabs(record.id)).toEqual([blank.id])
      expect(store.getWindow(record.id)?.draftId).toBe(blank.id)
    } finally {
      store.close()
    }
  })

  it('标签非活动状态也算已打开，并反映到历史搜索的 openWindowId', () => {
    const store = tempStore()
    try {
      const background = store.createDraft('被搜索的内容')
      const record = store.createWindowRecord(background.id, 860, 680)
      const active = store.createDraft('当前活动文稿')
      store.addWindowTab(record.id, active.id)
      expect(store.getWindow(record.id)?.draftId).toBe(active.id)

      expect(store.getOpenWindowForDraft(background.id)?.id).toBe(record.id)
      expect(store.getOpenWindowForDraft(background.id, record.id)).toBeNull()

      const page = store.searchHistory({ search: '被搜索', cursor: null, limit: 30, currentDraftId: active.id })
      expect(page.items.map((item) => item.id)).toEqual([background.id])
      expect(page.items[0].openWindowId).toBe(record.id)
    } finally {
      store.close()
    }
  })

  it('deleteDraft 清理 window_tabs，不留悬挂行', () => {
    const store = tempStore()
    try {
      const removed = store.createDraft('待删除')
      const kept = store.createDraft('保留')
      const record = store.createWindowRecord(removed.id, 860, 680)
      store.addWindowTab(record.id, kept.id)

      // 窗口打开期间禁止删除仍在标签中的文稿。
      expect(() => store.deleteDraft(removed.id)).toThrow('仍在窗口中打开')
      expect(store.getDraft(removed.id)).not.toBeNull()

      store.markWindowClosed(record.id)
      store.deleteDraft(removed.id)
      expect(store.listWindowTabs(record.id)).toEqual([kept.id])
      expect(store.getDraft(removed.id)).toBeNull()

      const payload = store.exportPayload()
      expect(Array.isArray(payload.windowTabs)).toBe(true)
      expect((payload.windowTabs as Array<{ draftId: string }>).some((tab) => tab.draftId === removed.id)).toBe(false)
      expect((payload.windowTabs as Array<{ draftId: string }>).some((tab) => tab.draftId === kept.id)).toBe(true)
    } finally {
      store.close()
    }
  })
})

/** 用假 DataStore 与假运行时直接驱动 WindowManager 的标签逻辑，不创建真实窗口。 */
function fakeWindowManager() {
  let counter = 0
  const drafts = new Map<string, Draft>()
  const tabsByWindow = new Map<string, string[]>()
  const record = { id: 'window-1', draftId: '' }
  const store = {
    createDraft: vi.fn(() => {
      const draft: Draft = {
        id: `draft-${++counter}`, content: '', createdAt: 1, updatedAt: 1, version: 0,
        scene: 'general', modelConfigId: null, displayMode: 'txt', filePath: null
      }
      drafts.set(draft.id, draft)
      return draft
    }),
    getDraft: vi.fn((id: string) => drafts.get(id) ?? null),
    listWindowTabs: vi.fn((windowId: string) => [...(tabsByWindow.get(windowId) ?? [])]),
    addWindowTab: vi.fn((windowId: string, draftId: string) => {
      const list = tabsByWindow.get(windowId) ?? []
      if (!list.includes(draftId)) list.push(draftId)
      tabsByWindow.set(windowId, list)
      record.draftId = draftId
    }),
    removeWindowTab: vi.fn((windowId: string, draftId: string) => {
      tabsByWindow.set(windowId, (tabsByWindow.get(windowId) ?? []).filter((id) => id !== draftId))
    }),
    setWindowDraft: vi.fn((_windowId: string, draftId: string) => { record.draftId = draftId }),
    reorderWindowTabs: vi.fn()
  }
  const manager = new WindowManager(store as unknown as DataStore)
  const browserWindow = { isDestroyed: () => false, setTitle: vi.fn() }
  const runtimes = (manager as unknown as { windows: Map<string, unknown> }).windows
  runtimes.set('window-1', {
    browserWindow,
    record,
    isCollapsed: false,
    interaction: { interacting: false, composing: false, drawerOpen: false, menuOpen: false, aiPreviewOpen: false },
    hoverStartedAt: null,
    outsideStartedAt: null,
    moveTimer: null,
    programmaticMove: false,
    programmaticMoveTimer: null,
    closeApproved: false,
    preferredWidth: 860,
    preferredHeight: 680
  })
  return { manager, store, drafts, tabsByWindow, record, browserWindow }
}

describe('窗口层多标签', () => {
  it('closeTab 切换活动标签，清空后补一个空白文稿', () => {
    const f = fakeWindowManager()
    const first = f.store.createDraft()
    const second = f.store.createDraft()
    f.tabsByWindow.set('window-1', [first.id, second.id])
    f.record.draftId = first.id

    f.manager.closeTab('window-1', first.id)
    expect(f.record.draftId).toBe(second.id)
    expect(f.tabsByWindow.get('window-1')).toEqual([second.id])

    f.manager.closeTab('window-1', second.id)
    const remaining = f.tabsByWindow.get('window-1') ?? []
    expect(remaining).toHaveLength(1)
    expect(remaining[0]).not.toBe(second.id)
    expect(f.record.draftId).toBe(remaining[0])
    expect(f.store.createDraft).toHaveBeenCalledTimes(3)
  })

  it('windowTabs 标题规则：文件名 / 首行摘要截断 / 空白文稿', () => {
    const f = fakeWindowManager()
    const fileDraft = f.store.createDraft()
    fileDraft.filePath = 'C:\\笔记\\项目计划.md'
    const longLine = f.store.createDraft()
    longLine.content = '一'.repeat(30) + '\n第二行'
    const empty = f.store.createDraft()
    f.tabsByWindow.set('window-1', [fileDraft.id, longLine.id, empty.id])

    const tabs = f.manager.windowTabs('window-1')
    expect(tabs.map((tab) => tab.title)).toEqual(['项目计划.md', '一'.repeat(24), '空白文稿'])
    expect(tabs[0]).toMatchObject({ displayMode: 'txt', filePath: 'C:\\笔记\\项目计划.md' })
  })

  it('newTab 创建空白文稿并追加为活动标签', () => {
    const f = fakeWindowManager()
    const first = f.store.createDraft()
    f.tabsByWindow.set('window-1', [first.id])
    f.record.draftId = first.id

    const tabs = f.manager.newTab('window-1')
    expect(tabs).toHaveLength(2)
    expect(tabs[1].title).toBe('空白文稿')
    expect(f.record.draftId).toBe(tabs[1].draftId)
  })

  it('switchDraft 对不在标签中的文稿先补入标签', () => {
    const f = fakeWindowManager()
    const first = f.store.createDraft()
    f.tabsByWindow.set('window-1', [first.id])
    f.record.draftId = first.id
    const extra = f.store.createDraft()

    f.manager.switchDraft('window-1', extra.id)
    expect(f.tabsByWindow.get('window-1')).toEqual([first.id, extra.id])
    expect(f.record.draftId).toBe(extra.id)
    expect(f.browserWindow.setTitle).toHaveBeenCalledWith('SheepText')
  })
})