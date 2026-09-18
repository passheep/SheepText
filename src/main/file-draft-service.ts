import type { Draft, DraftSaveInput, ToastPayload } from '../shared/types'
import type { DataStore } from './data-store'
import {
  displayModeForFile, isMissingFileError, normalizeFilePath, readTextFile, snapshotFile, writeTextFileUtf8,
  type FileSnapshot, type TextFileContents
} from './file-drafts'

type Store = Pick<DataStore, 'getDraft' | 'findFileDraft' | 'createFileDraft' | 'saveDraft' | 'getOpenWindowForDraft'>
type Ports = {
  read: typeof readTextFile
  snapshot: typeof snapshotFile
  write: typeof writeTextFileUtf8
  activateWindow: (id: string) => boolean
  createWindow: (draftId: string) => Promise<string>
  /** 在指定窗口作为新标签打开，窗口不存在或标签已满时返回 false */
  openTab?: (windowId: string, draftId: string) => boolean
  toast: (draftId: string, payload: ToastPayload) => void
}
export type OpenLocalFileResult = {
  opened: boolean; windowId: string; draft: Draft; reused?: boolean
  snapshot?: FileSnapshot | null; convertedFromGbk?: boolean; sourceEncoding?: TextFileContents['sourceEncoding']
  /** 因当前窗口标签已满而改在新窗口打开 */
  openedInNewWindow?: boolean
}

/** 所有打开入口共用全局队列；保存、检测、冲突解决、删除共用每文稿队列。 */
export class FileDraftService {
  private openTail: Promise<unknown> = Promise.resolve()
  private readonly draftTails = new Map<string, Promise<unknown>>()
  private readonly baselines = new Map<string, TextFileContents>()
  private readonly conflicts = new Set<string>()
  // DB 或磁盘失败时保留完整请求，且错误仍向调用者传播，不能伪装保存成功。
  private readonly pendingInputs = new Map<string, DraftSaveInput>()
  private readonly ports: Ports

  constructor(private readonly store: Store, ports: Pick<Ports, 'activateWindow' | 'createWindow' | 'toast'> & Partial<Ports>) {
    this.ports = { read: readTextFile, snapshot: snapshotFile, write: writeTextFileUtf8, ...ports }
  }

  withDraft<T>(id: string, work: () => Promise<T>): Promise<T> {
    const result = (this.draftTails.get(id) ?? Promise.resolve()).then(work)
    const tail = result.then(() => undefined, () => undefined)
    this.draftTails.set(id, tail)
    void tail.then(() => { if (this.draftTails.get(id) === tail) this.draftTails.delete(id) })
    return result
  }

  /** 打开本地文件；传入 targetWindowId 时优先在该窗口作为新标签打开（U07）。 */
  openLocalFile(filePath: string, cwd?: string, targetWindowId?: string): Promise<OpenLocalFileResult> {
    const result = this.openTail.then(async () => {
      const path = normalizeFilePath(filePath, cwd)
      if (!/\.(txt|md|markdown)$/i.test(path)) throw new Error('仅支持打开 TXT 或 Markdown 文件')
      const existing = this.store.findFileDraft(path)
      if (existing) return this.withDraft(existing.id, async () => {
        // 历史/重启后的 DB 正文是恢复基线，不能用新读到的磁盘内容悄悄覆盖它。
        const draft = this.requireDraft(existing.id)
        await this.checkUnlocked(draft)
        const opened = this.store.getOpenWindowForDraft(draft.id)
        if (opened && this.ports.activateWindow(opened.id)) {
          return { opened: true, windowId: opened.id, draft, reused: true }
        }
        return { opened: true, draft, ...await this.placeDraft(draft.id, targetWindowId) }
      })
      const text = await this.ports.read(path)
      const snapshot = await this.ports.snapshot(path)
      if (!snapshot) throw new Error('文件已不存在')
      const draft = this.store.createFileDraft(path, text.content, displayModeForFile(path))
      this.baselines.set(draft.id, text)
      return {
        opened: true, draft, snapshot, convertedFromGbk: text.convertedFromGbk, sourceEncoding: text.sourceEncoding,
        ...await this.placeDraft(draft.id, targetWindowId)
      }
    })
    this.openTail = result.then(() => undefined, () => undefined)
    return result
  }

  /** 优先放入目标窗口的标签栏，标签已满或没有目标窗口时另开新窗口。 */
  private async placeDraft(draftId: string, targetWindowId?: string): Promise<{ windowId: string; openedInNewWindow: boolean }> {
    if (targetWindowId && this.ports.openTab?.(targetWindowId, draftId)) {
      return { windowId: targetWindowId, openedInNewWindow: false }
    }
    return { windowId: await this.ports.createWindow(draftId), openedInNewWindow: true }
  }

  assertSaveAsTarget(id: string, targetPath: string): void {
    const current = this.requireDraft(id)
    if (current.filePath && normalizeFilePath(current.filePath) === normalizeFilePath(targetPath)) {
      throw new Error('另存副本不能覆盖当前本地文件，请选择其他路径；覆盖原文件请先解决外部修改')
    }
  }

  checkExternalChange(id: string): Promise<{ changed: boolean; missing: boolean; path: string | null }> {
    return this.withDraft(id, () => this.checkUnlocked(this.requireDraft(id)))
  }

  private async checkUnlocked(draft: Draft): Promise<{ changed: boolean; missing: boolean; path: string | null }> {
    if (!draft.filePath) return { changed: false, missing: false, path: null }
    let disk: TextFileContents
    try { disk = await this.ports.read(draft.filePath) }
    catch (error) {
      this.conflicts.add(draft.id)
      if (isMissingFileError(error)) return { changed: true, missing: true, path: draft.filePath }
      throw error
    }
    const baseline = this.baselines.get(draft.id)
    if (disk.content !== (baseline?.content ?? draft.content) || (baseline && disk.sourceEncoding !== baseline.sourceEncoding)) {
      this.conflicts.add(draft.id)
    }
    // 离线变化仍保留 DB 正文作为基线，只有明确 reload/keep 才解除冲突。
    if (!baseline) this.baselines.set(draft.id, { ...disk, content: draft.content })
    return { changed: this.conflicts.has(draft.id), missing: false, path: draft.filePath }
  }

  saveDraft(input: DraftSaveInput): Promise<Draft> {
    const request = { ...input }
    return this.withDraft(request.id, async () => {
      const current = this.requireDraft(request.id)
      this.validateInput(current, request)
      if (!current.filePath) return this.store.saveDraft(request)
      const status = await this.checkUnlocked(current)
      if (status.changed) throw new Error(status.missing ? '文件已不存在，请先另存或解决外部修改' : '文件已被外部修改，请先选择重新加载或保留当前内容')
      return this.writeUnlocked(current, request)
    })
  }

  resolveExternalChange(id: string, action: 'reload' | 'keep', input: DraftSaveInput): Promise<{ draft: Draft }> {
    const request = { ...input }
    return this.withDraft(id, async () => {
      const current = this.requireDraft(id)
      this.validateInput(current, request, action === 'reload')
      if (!current.filePath) throw new Error('该文稿不是文件文稿')
      if (action === 'reload') {
        const disk = await this.ports.read(current.filePath)
        const draft = this.store.saveDraft({ ...request, content: disk.content, version: Math.max(current.version, request.version) + 1 })
        this.baselines.set(id, disk)
        this.conflicts.delete(id)
        this.pendingInputs.delete(id)
        return { draft }
      }
      if (action !== 'keep') throw new Error('不支持的外部修改处理方式')
      // keep 明确覆盖磁盘，但正文必须来自渲染层当前输入而非 DB 的旧备份。
      const disk = await this.ports.read(current.filePath)
      return { draft: await this.writeUnlocked(current, request, disk) }
    })
  }

  private async writeUnlocked(current: Draft, input: DraftSaveInput, disk = this.baselines.get(current.id)): Promise<Draft> {
    this.validateInput(this.requireDraft(current.id), input)
    this.pendingInputs.set(current.id, input)
    // 先持久化恢复副本；写盘失败保留它（重启正文与磁盘不符会再次触发冲突）。
    const saved = this.store.saveDraft(input)
    try { await this.ports.write(current.filePath!, input.content) }
    catch (error) {
      // 包括可能的部分写入：必须显式处理后才能再写，防止自动重试掩盖数据损失。
      this.conflicts.add(current.id)
      throw error
    }
    this.baselines.set(current.id, { content: input.content, convertedFromGbk: false, sourceEncoding: 'utf8' })
    this.conflicts.delete(current.id)
    this.pendingInputs.delete(current.id)
    if (disk && disk.sourceEncoding !== 'utf8') {
      this.ports.toast(current.id, { type: 'info', message: `文件已从 ${disk.sourceEncoding.toUpperCase()} 转换为 UTF-8 并保存` })
    }
    return saved
  }

  private requireDraft(id: string): Draft {
    const draft = this.store.getDraft(id)
    if (!draft) throw new Error('文稿不存在或已被移除')
    return draft
  }

  private validateInput(current: Draft, input: DraftSaveInput, allowOld = false): void {
    if (input.id !== current.id || typeof input.content !== 'string' || !Number.isSafeInteger(input.version) || input.version < 0) throw new Error('文稿保存参数无效')
    if (!allowOld && input.version < current.version) throw new Error('文稿版本已过期，请使用最新内容重试')
  }
}
