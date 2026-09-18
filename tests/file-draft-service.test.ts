import { describe, expect, it, vi } from 'vitest'
import type { Draft, DraftSaveInput, WindowRecord } from '../src/shared/types'
import { FileDraftService } from '../src/main/file-draft-service'
import { decodeTextFile, normalizeFilePath, type SourceEncoding } from '../src/main/file-drafts'

const electronMock = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  trashItem: vi.fn(),
  showSaveDialog: vi.fn(),
  showOpenDialog: vi.fn()
}))
vi.mock('electron', () => ({
  app: {}, clipboard: {}, safeStorage: {},
  shell: { trashItem: electronMock.trashItem },
  dialog: { showSaveDialog: electronMock.showSaveDialog, showOpenDialog: electronMock.showOpenDialog },
  ipcMain: { handle: (channel: string, handler: (...args: any[]) => any) => electronMock.handlers.set(channel, handler), on: vi.fn() }
}))

// 全部依赖内存模拟：不创建、回收或删除实际文件，也不做删除式测试清理。
function fixture(withDraft = true) {
  let draft: Draft | null = withDraft ? {
    id: 'draft', content: '基线', createdAt: 1, updatedAt: 1, version: 1,
    scene: 'general', modelConfigId: null, displayMode: 'txt', filePath: 'C:\\notes\\a.txt'
  } : null
  let disk = '基线'
  let encoding: SourceEncoding = 'utf8'
  let opened: WindowRecord | null = null
  const store = {
    getDraft: vi.fn(() => draft && { ...draft }),
    findFileDraft: vi.fn((path: string) => draft && normalizeFilePath(draft.filePath!) === path ? { ...draft } : null),
    createFileDraft: vi.fn((path: string, content: string, displayMode: 'txt' | 'markdown') => {
      draft = { id: 'draft', content, displayMode, filePath: path, version: 1, createdAt: 1, updatedAt: 1, scene: 'general', modelConfigId: null }
      return { ...draft }
    }),
    saveDraft: vi.fn((input: DraftSaveInput) => {
      if (!draft) throw new Error('不存在')
      if (input.version < draft.version) return { ...draft }
      draft = { ...draft, ...input }
      return { ...draft }
    }),
    getOpenWindowForDraft: vi.fn(() => opened)
  }
  const read = vi.fn(async () => ({ content: disk, sourceEncoding: encoding, convertedFromGbk: encoding === 'gbk' }))
  const write = vi.fn(async (_path: string, content: string) => { disk = content; encoding = 'utf8' })
  const snapshot = vi.fn(async () => ({ mtimeMs: 1, size: 6 }))
  const createWindow = vi.fn(async () => { opened = { id: 'window' } as WindowRecord; return 'window' })
  const toast = vi.fn()
  const service = new FileDraftService(store, { read, write, snapshot, createWindow, toast, activateWindow: () => true })
  const input = (content = '内存新正文', version = 2): DraftSaveInput => ({ id: 'draft', content, version, scene: 'coding', modelConfigId: null, displayMode: 'txt' })
  return {
    service, store, read, write, snapshot, toast, createWindow, input,
    disk: () => disk, draft: () => draft,
    external: (content: string, sourceEncoding: SourceEncoding = 'utf8') => { disk = content; encoding = sourceEncoding }
  }
}

describe('FileDraftService', () => {
  it('并发打开、不同 Windows 大小写/分隔符只产生一个文稿和窗口', async () => {
    const f = fixture(false)
    const results = await Promise.all([
      f.service.openLocalFile('C:/Notes/A.TXT'),
      f.service.openLocalFile('.\\a.txt', 'c:\\NOTES')
    ])
    expect(results.map((item) => item.windowId)).toEqual(['window', 'window'])
    expect(results[1].reused).toBe(true)
    expect(f.store.createFileDraft).toHaveBeenCalledTimes(1)
    expect(f.createWindow).toHaveBeenCalledTimes(1)
    expect(f.draft()?.filePath).toBe('c:\\notes\\a.txt')
    expect(f.write).not.toHaveBeenCalled()
  })

  it('打开失败不会卡死全局队列', async () => {
    const f = fixture(false)
    f.read.mockRejectedValueOnce(new Error('无法读取'))
    await expect(f.service.openLocalFile('C:/notes/a.txt')).rejects.toThrow('无法读取')
    await expect(f.service.openLocalFile('C:/notes/a.txt')).resolves.toMatchObject({ opened: true })
  })

  it('重启基线使用 DB 正文识别离线变化；历史打开不覆盖 DB', async () => {
    const f = fixture()
    f.external('离线变更')
    await f.service.openLocalFile('C:/notes/a.txt')
    expect(f.draft()?.content).toBe('基线')
    expect(await f.service.checkExternalChange('draft')).toEqual({ changed: true, missing: false, path: 'C:\\notes\\a.txt' })
    await expect(f.service.saveDraft(f.input())).rejects.toThrow('外部修改')
    expect(f.write).not.toHaveBeenCalled()
  })

  it('即使 mtime/size 未变化也比较正文，冲突锁不会被普通检查解除', async () => {
    const f = fixture()
    expect((await f.service.checkExternalChange('draft')).changed).toBe(false)
    f.external('替换')
    expect((await f.service.checkExternalChange('draft')).changed).toBe(true)
    f.external('基线')
    expect((await f.service.checkExternalChange('draft')).changed).toBe(true)
    expect(f.snapshot).not.toHaveBeenCalled()
    await expect(f.service.saveDraft(f.input())).rejects.toThrow('外部修改')
  })

  it('keep 用当前输入而非 DB 旧正文；正常保存更新基线', async () => {
    const f = fixture()
    f.external('其他编辑器正文')
    const result = await f.service.resolveExternalChange('draft', 'keep', f.input('未自动保存的正文', 8))
    expect(result.draft.content).toBe('未自动保存的正文')
    expect(result.draft.version).toBe(8)
    expect(f.disk()).toBe('未自动保存的正文')
    expect((await f.service.checkExternalChange('draft')).changed).toBe(false)
    await f.service.saveDraft(f.input('继续编辑', 9))
    expect((await f.service.checkExternalChange('draft')).changed).toBe(false)
  })

  it.each([0, 20])('reload 版本严格大于 DB 和输入（输入版本 %s）', async (version) => {
    const f = fixture()
    f.external('磁盘正文')
    const result = await f.service.resolveExternalChange('draft', 'reload', f.input('内存', version))
    expect(result.draft.version).toBe(Math.max(1, version) + 1)
    expect(result.draft.content).toBe('磁盘正文')
    expect(f.write).not.toHaveBeenCalled()
    await expect(f.service.saveDraft(f.input('迟到请求', 1))).rejects.toThrow('版本已过期')
    expect(f.write).not.toHaveBeenCalled()
  })

  it('保存/keep 在触碰磁盘前拒绝旧版本、错误文稿及非法 action', async () => {
    const f = fixture()
    await expect(f.service.saveDraft(f.input('旧', 0))).rejects.toThrow('版本已过期')
    await expect(f.service.resolveExternalChange('draft', 'keep', f.input('旧', 0))).rejects.toThrow('版本已过期')
    await expect(f.service.resolveExternalChange('draft', 'keep', { ...f.input(), id: 'other' })).rejects.toThrow('参数无效')
    await expect(f.service.resolveExternalChange('draft', 'bad' as 'keep', f.input())).rejects.toThrow('不支持')
    expect(f.read).not.toHaveBeenCalled()
    expect(f.write).not.toHaveBeenCalled()
  })

  it('每文稿写入串行，排队旧请求在前一保存完成后重新检查版本', async () => {
    const f = fixture()
    let release!: () => void
    let started!: () => void
    const entered = new Promise<void>((resolve) => { started = resolve })
    const gate = new Promise<void>((resolve) => { release = resolve })
    f.write.mockImplementationOnce(async (_path, content) => { started(); await gate; f.external(content) })
    const first = f.service.saveDraft(f.input('新', 10))
    await entered
    const old = f.service.resolveExternalChange('draft', 'keep', f.input('旧', 2))
    const rejected = expect(old).rejects.toThrow('版本已过期')
    expect(f.write).toHaveBeenCalledTimes(1)
    release()
    await first
    await rejected
    expect(f.disk()).toBe('新')
    expect(f.write).toHaveBeenCalledTimes(1)
  })

  it('写盘失败保留 DB 恢复副本并抛错，不发送转换成功提示', async () => {
    const f = fixture()
    f.external('基线', 'gbk')
    f.write.mockRejectedValueOnce(new Error('磁盘已满'))
    await expect(f.service.saveDraft(f.input())).rejects.toThrow('磁盘已满')
    expect(f.draft()?.content).toBe('内存新正文')
    expect(f.disk()).toBe('基线')
    expect(f.toast).not.toHaveBeenCalled()
    await expect(f.service.saveDraft(f.input('自动重试', 3))).rejects.toThrow('外部修改')
    await f.service.resolveExternalChange('draft', 'keep', f.input('救援正文', 4))
    expect(f.disk()).toBe('救援正文')
    expect(f.toast).toHaveBeenCalledTimes(1)
  })

  it('DB 失败不写盘、不伪装成功，队列允许重试', async () => {
    const f = fixture()
    f.store.saveDraft.mockImplementationOnce(() => { throw new Error('DB 失败') })
    await expect(f.service.saveDraft(f.input())).rejects.toThrow('DB 失败')
    expect(f.write).not.toHaveBeenCalled()
    await f.service.saveDraft(f.input())
    expect(f.disk()).toBe('内存新正文')
  })

  it('缺失与权限错误区分，不吞读错误；reload 失败保留 DB', async () => {
    const f = fixture()
    f.read.mockRejectedValueOnce(Object.assign(new Error('缺失'), { code: 'ENOENT' }))
    expect(await f.service.checkExternalChange('draft')).toMatchObject({ changed: true, missing: true, path: 'C:\\notes\\a.txt' })
    f.read.mockRejectedValueOnce(Object.assign(new Error('拒绝访问'), { code: 'EACCES' }))
    await expect(f.service.checkExternalChange('draft')).rejects.toThrow('拒绝访问')
    f.read.mockRejectedValueOnce(new Error('非法编码'))
    await expect(f.service.resolveExternalChange('draft', 'reload', f.input())).rejects.toThrow('非法编码')
    expect(f.draft()?.content).toBe('基线')
    expect(f.write).not.toHaveBeenCalled()
  })

  it.each<SourceEncoding>(['gbk', 'utf16le', 'utf16be', 'utf8-bom'])('编码 %s 只在写盘成功后提示转换', async (encoding) => {
    const f = fixture(false)
    f.external('基线', encoding)
    await f.service.openLocalFile('C:/notes/a.txt')
    expect(f.toast).not.toHaveBeenCalled()
    await f.service.resolveExternalChange('draft', 'reload', f.input())
    expect(f.toast).not.toHaveBeenCalled()
    await f.service.saveDraft(f.input('保存', 4))
    expect(f.toast).toHaveBeenCalledWith('draft', expect.objectContaining({ message: expect.stringContaining('UTF-8') }))
    await f.service.saveDraft(f.input('再次保存', 5))
    expect(f.toast).toHaveBeenCalledTimes(1)
  })

  it('另存不能通过大小写/分隔符/相对路径绕过原文件限制', () => {
    const f = fixture()
    expect(() => f.service.assertSaveAsTarget('draft', 'c:/NOTES/./A.TXT')).toThrow('不能覆盖')
    expect(() => f.service.assertSaveAsTarget('draft', 'C:/notes/backup.txt')).not.toThrow()
  })
})

describe('主进程 IPC（回收仅 mock）', () => {
  async function ipcFixture() {
    const { registerIpc } = await import('../src/main/ipc')
    const f = fixture()
    let currentId = 'draft'
    const record = () => ({ id: 'window', draftId: currentId })
    const extra = {
      getWindow: vi.fn(record),
      createDraft: vi.fn(() => ({ ...f.draft()!, id: 'replacement', filePath: null })),
      deleteDraft: vi.fn()
    }
    const windows = {
      getBrowserWindow: vi.fn(() => ({ webContents: { id: 7, send: vi.fn() }, isDestroyed: () => false })),
      activateWindow: vi.fn(() => true), createWindowForDraft: vi.fn(async () => 'new-window'),
      switchDraft: vi.fn((_id: string, draftId: string) => { currentId = draftId })
    }
    electronMock.handlers.clear()
    electronMock.trashItem.mockReset()
    electronMock.showSaveDialog.mockReset()
    electronMock.showOpenDialog.mockReset()
    const service = registerIpc({ ...f.store, ...extra } as any, {} as any, windows as any)
    const invoke = (channel: string, ...args: unknown[]) => electronMock.handlers.get(channel)!({ sender: { id: 7 } }, 'window', ...args)
    return { ...f, ...extra, windows, invoke, service }
  }

  it('回收失败不切文稿、不删 DB；成功后才切换和删除', async () => {
    const f = await ipcFixture()
    electronMock.trashItem.mockRejectedValueOnce(new Error('回收失败'))
    await expect(f.invoke('draft:delete', 'draft')).rejects.toThrow('回收失败')
    expect(f.windows.switchDraft).not.toHaveBeenCalled()
    expect(f.createDraft).not.toHaveBeenCalled()
    expect(f.deleteDraft).not.toHaveBeenCalled()
    electronMock.trashItem.mockImplementationOnce(async () => {
      expect(f.windows.switchDraft).not.toHaveBeenCalled()
      expect(f.deleteDraft).not.toHaveBeenCalled()
    })
    await expect(f.invoke('draft:delete', 'draft')).resolves.toMatchObject({ deletedId: 'draft' })
    expect(f.windows.switchDraft).toHaveBeenCalledWith('window', 'replacement')
    expect(f.deleteDraft).toHaveBeenCalledWith('draft')
  })

  it('file:open 身份认证；对话框与直接打开共用同一服务', async () => {
    const f = await ipcFixture()
    const open = vi.spyOn(f.service, 'openLocalFile').mockResolvedValue({ opened: true, windowId: 'new-window', draft: f.draft()! })
    expect(() => electronMock.handlers.get('file:open')!({ sender: { id: 99 } }, 'window', 'C:/notes/a.txt')).toThrow('身份校验失败')
    expect(open).not.toHaveBeenCalled()
    await f.invoke('file:open', 'C:/notes/a.txt')
    electronMock.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: ['C:/notes/a.txt'] })
    expect(await f.invoke('draft:import-file')).toMatchObject({ canceled: false, openedInNewWindow: true, draft: { id: 'draft' } })
    await f.invoke('draft:open', 'draft')
    expect(open).toHaveBeenCalledTimes(3)
    expect(f.windows.switchDraft).not.toHaveBeenCalled()
  })

  it('另存救援拒绝当前路径大小写变体，不信任渲染层 filePath', async () => {
    const f = await ipcFixture()
    electronMock.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: 'c:/NOTES/A.TXT' })
    await expect(f.invoke('draft:save-as', { ...f.draft(), filePath: null, content: '救援正文' })).rejects.toThrow('不能覆盖')
  })
})

describe('严格编码', () => {
  it.each([
    [[0xef, 0xbb, 0xbf, 0xff], '非法 UTF8 BOM'],
    [[0xff, 0xfe, 0x61], '截断 UTF16 LE'],
    [[0xfe, 0xff, 0x00], '截断 UTF16 BE'],
    [[0xff, 0xfe, 0x00, 0xd8], '孤立代理项'],
    [[0x81], '截断 GBK']
  ])('%s %s 必须抛出而非替换字符', (bytes) => {
    expect(() => decodeTextFile(Uint8Array.from(bytes as number[]))).toThrow()
  })
  it('识别 UTF8、UTF8 BOM、UTF16 两种端序与 GBK', () => {
    expect(decodeTextFile(Buffer.from('你好'))).toMatchObject({ content: '你好', sourceEncoding: 'utf8' })
    expect(decodeTextFile(Uint8Array.from([0xef, 0xbb, 0xbf, 0x61]))).toMatchObject({ content: 'a', sourceEncoding: 'utf8-bom' })
    expect(decodeTextFile(Uint8Array.from([0xff, 0xfe, 0x60, 0x4f]))).toMatchObject({ content: '你', sourceEncoding: 'utf16le' })
    expect(decodeTextFile(Uint8Array.from([0xfe, 0xff, 0x4f, 0x60]))).toMatchObject({ content: '你', sourceEncoding: 'utf16be' })
    expect(decodeTextFile(Uint8Array.from([0xc4, 0xe3, 0xba, 0xc3]))).toMatchObject({ content: '你好', sourceEncoding: 'gbk', convertedFromGbk: true })
  })
})
