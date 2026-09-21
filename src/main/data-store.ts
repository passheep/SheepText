import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, unlinkSync } from 'node:fs'
import { basename, join, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { safeStorage } from 'electron'
import { DEFAULT_SETTINGS, LEGACY_DEFAULT_EDITOR_PATTERN, LEGACY_DEFAULT_THEME_COLOR } from '../shared/constants'
import { normalizeFilePath } from './file-drafts'
import type {
  AppSettings, ApiProtocol, DisplayMode, Draft, DraftSaveInput, DraftSummary,
  HistoryPage, HistoryQuery, ModelConfigInput, ModelConfigPublic, ProviderType,
  ReasoningEffort, SceneId, TokenUsageInput, TokenUsageQuery, TokenUsageResult,
  TokenUsageSummary, WindowRecord
} from '../shared/types'

type DbValue = string | number | bigint | null | Uint8Array

/** token_usage 聚合查询的原始行。 */
type UsageRow = {
  key: string
  label: string
  calls: number
  promptTokens: number
  completionTokens: number
  totalTokens: number
  cacheHitTokens: number
  cacheMissTokens: number
  errorCalls: number
}

type DraftRow = {
  id: string
  content: string
  created_at: number
  updated_at: number
  version: number
  scene: SceneId
  model_config_id: string | null
  display_mode: DisplayMode
  file_path?: string | null
}

type ModelRow = {
  id: string
  name: string
  provider: ProviderType
  api_protocol: ApiProtocol
  base_url: string
  api_key: Uint8Array | null
  model_id: string
  timeout_ms: number
  max_tokens: number
  temperature: number | null
  reasoning_effort: ReasoningEffort
  is_default: number
  created_at: number
  updated_at: number
}

type WindowRow = {
  id: string
  draft_id: string
  x: number | null
  y: number | null
  width: number
  height: number
  display_id: string | null
  dock_side: 'left' | 'right' | 'top' | 'bottom' | null
  is_docked: number
  expanded_x: number | null
  expanded_y: number | null
  always_on_top: number
  fixed_expanded: number
  is_open: number
  last_active_at: number
}

export class DataStore {
  private readonly db: DatabaseSync
  readonly dataDirectory: string
  readonly assetDirectory: string
  readonly dataFilePath: string

  constructor(userDataPath: string) {
    this.dataDirectory = join(userDataPath, 'data')
    this.assetDirectory = join(this.dataDirectory, 'images')
    mkdirSync(this.assetDirectory, { recursive: true })
    this.dataFilePath = join(this.dataDirectory, 'sheeptext.db')
    this.db = new DatabaseSync(this.dataFilePath)
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;')
    this.migrate()
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS drafts (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        version INTEGER NOT NULL DEFAULT 0,
        scene TEXT NOT NULL DEFAULT 'general',
        model_config_id TEXT,
        display_mode TEXT NOT NULL DEFAULT 'txt'
      );
      CREATE TABLE IF NOT EXISTS model_configs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        provider TEXT NOT NULL,
        api_protocol TEXT NOT NULL,
        base_url TEXT NOT NULL,
        api_key BLOB,
        model_id TEXT NOT NULL,
        timeout_ms INTEGER NOT NULL DEFAULT 60000,
        max_tokens INTEGER NOT NULL DEFAULT 4096,
        temperature REAL,
        reasoning_effort TEXT NOT NULL DEFAULT 'off',
        is_default INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS window_states (
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
        last_active_at INTEGER NOT NULL,
        FOREIGN KEY (draft_id) REFERENCES drafts(id)
      );
      CREATE TABLE IF NOT EXISTS window_tabs (
        window_id TEXT NOT NULL,
        draft_id TEXT NOT NULL,
        position INTEGER NOT NULL,
        PRIMARY KEY (window_id, draft_id)
      );
      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS token_usage (
        id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        day TEXT NOT NULL,
        kind TEXT NOT NULL,
        scene TEXT,
        model_config_id TEXT,
        model_name TEXT NOT NULL,
        prompt_tokens INTEGER NOT NULL DEFAULT 0,
        completion_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        cache_hit_tokens INTEGER NOT NULL DEFAULT 0,
        cache_miss_tokens INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL,
        duration_ms INTEGER,
        error_message TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_drafts_updated ON drafts(updated_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS idx_windows_draft_open ON window_states(draft_id, is_open);
      CREATE INDEX IF NOT EXISTS idx_windows_active ON window_states(is_open, last_active_at DESC);
      CREATE INDEX IF NOT EXISTS idx_window_tabs_window ON window_tabs(window_id, position);
      CREATE INDEX IF NOT EXISTS idx_token_usage_day ON token_usage(day);
      CREATE INDEX IF NOT EXISTS idx_token_usage_model ON token_usage(model_config_id, day);
    `)
    // F14 迁移：旧库补 file_path 列（null=普通文稿，非空=本地文件文稿）
    const draftColumns = this.db.prepare('PRAGMA table_info(drafts)').all() as Array<{ name: string }>
    if (!draftColumns.some((column) => column.name === 'file_path')) {
      this.db.exec('ALTER TABLE drafts ADD COLUMN file_path TEXT')
    }
    // F16 迁移：旧库每个窗口补一条标签；活动文稿仍由 window_states.draft_id 表示。
    this.db.exec(`
      INSERT OR IGNORE INTO window_tabs(window_id, draft_id, position)
      SELECT id, draft_id, 0 FROM window_states
    `)
    const row = this.db.prepare('SELECT value FROM app_settings WHERE key = ?').get('app') as { value: string } | undefined
    if (!row) this.db.prepare('INSERT INTO app_settings(key, value) VALUES (?, ?)').run('app', JSON.stringify(DEFAULT_SETTINGS))
  }

  close(): void {
    this.db.close()
  }

  backupTo(targetPath: string): void {
    if (resolve(targetPath) === resolve(this.dataFilePath)) throw new Error('不能覆盖正在使用的数据库，请选择其他位置')
    if (existsSync(targetPath)) unlinkSync(targetPath)
    const escaped = targetPath.replace(/'/g, "''")
    this.db.exec("VACUUM INTO '" + escaped + "'")
  }

  exportPayload(): Record<string, unknown> {
    const drafts = this.db.prepare('SELECT id, content, created_at AS createdAt, updated_at AS updatedAt, version, scene, model_config_id AS modelConfigId, display_mode AS displayMode FROM drafts ORDER BY updated_at DESC').all()
    const windows = this.db.prepare('SELECT id, draft_id AS draftId, x, y, width, height, display_id AS displayId, dock_side AS dockSide, is_docked AS isDocked, expanded_x AS expandedX, expanded_y AS expandedY, always_on_top AS alwaysOnTop, is_open AS isOpen, last_active_at AS lastActiveAt FROM window_states ORDER BY last_active_at DESC').all()
    const windowTabs = this.db.prepare('SELECT window_id AS windowId, draft_id AS draftId, position FROM window_tabs ORDER BY window_id ASC, position ASC').all()
    return { exportedAt: new Date().toISOString(), settings: this.getSettings(), models: this.listModels(), drafts, windows, windowTabs }
  }

  transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = work()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  getSettings(): AppSettings {
    const row = this.db.prepare('SELECT value FROM app_settings WHERE key = ?').get('app') as { value: string } | undefined
    if (!row) return this.normalizeSettings(DEFAULT_SETTINGS)
    try {
      return this.normalizeSettings(JSON.parse(row.value) as Partial<AppSettings>)
    } catch {
      return this.normalizeSettings(DEFAULT_SETTINGS)
    }
  }

  saveSettings(settings: AppSettings): AppSettings {
    const requestedDefaultModelId = this.normalizeSettings(settings).defaultModelConfigId
    const defaultModelExists = requestedDefaultModelId
      ? Boolean(this.db.prepare('SELECT 1 FROM model_configs WHERE id = ?').get(requestedDefaultModelId))
      : false
    const normalized: AppSettings = {
      ...this.normalizeSettings(settings),
      defaultModelConfigId: defaultModelExists ? requestedDefaultModelId : null
    }
    this.db.prepare(`
      INSERT INTO app_settings(key, value) VALUES ('app', $value)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run({ $value: JSON.stringify(normalized) })
    this.db.prepare('UPDATE model_configs SET is_default = CASE WHEN id = ? THEN 1 ELSE 0 END')
      .run(normalized.defaultModelConfigId)
    return normalized
  }

  private normalizeSettings(settings: Partial<AppSettings>): AppSettings {
    const merged = { ...DEFAULT_SETTINGS, ...settings }
    const booleanValue = (value: unknown, fallback: boolean): boolean =>
      typeof value === 'boolean' ? value : fallback

    return {
      theme: merged.theme === 'light' || merged.theme === 'dark' || merged.theme === 'system'
        ? merged.theme
        : DEFAULT_SETTINGS.theme,
      themeColor: typeof merged.themeColor === 'string' && /^#[0-9a-f]{6}$/i.test(merged.themeColor)
        // 仍停留在旧默认主题色的用户跟随新默认值；自定义过的颜色一律保留。
        ? (merged.themeColor.toLowerCase() === LEGACY_DEFAULT_THEME_COLOR
            ? DEFAULT_SETTINGS.themeColor
            : merged.themeColor.toLowerCase())
        : DEFAULT_SETTINGS.themeColor,
      fontSize: typeof merged.fontSize === 'number' && Number.isFinite(merged.fontSize)
        ? Math.max(13, Math.min(26, Math.round(merged.fontSize)))
        : DEFAULT_SETTINGS.fontSize,
      autoLaunch: booleanValue(merged.autoLaunch, DEFAULT_SETTINGS.autoLaunch),
      closeToTray: booleanValue(merged.closeToTray, DEFAULT_SETTINGS.closeToTray),
      keepTaskbarButton: booleanValue(merged.keepTaskbarButton, DEFAULT_SETTINGS.keepTaskbarButton),
      dockEnabled: booleanValue(merged.dockEnabled, DEFAULT_SETTINGS.dockEnabled),
      hideTaskbarWhenDocked: booleanValue(merged.hideTaskbarWhenDocked, DEFAULT_SETTINGS.hideTaskbarWhenDocked),
      hideAfterCopy: booleanValue(merged.hideAfterCopy, DEFAULT_SETTINGS.hideAfterCopy),
      defaultScene: merged.defaultScene === 'general' || merged.defaultScene === 'coding' || merged.defaultScene === 'image'
        ? merged.defaultScene
        : DEFAULT_SETTINGS.defaultScene,
      defaultModelConfigId: typeof merged.defaultModelConfigId === 'string' && merged.defaultModelConfigId.length > 0
        ? merged.defaultModelConfigId
        : null,
      defaultDisplayMode: merged.defaultDisplayMode === 'markdown' ? 'markdown' : 'txt',
      editorBackground: merged.editorBackground === 'blend' || merged.editorBackground === 'white' || merged.editorBackground === 'black'
        || merged.editorBackground === 'eye-care' || merged.editorBackground === 'paper' || merged.editorBackground === 'kraft'
        ? merged.editorBackground
        : 'auto',
      editorPattern: merged.editorPattern === 'grid-large' || merged.editorPattern === 'grid-small'
        || merged.editorPattern === 'lines' || merged.editorPattern === 'waves'
        // 仍停留在旧默认纹理的用户跟随新默认值“无纹理”；其余选择一律保留。
        ? (merged.editorPattern === LEGACY_DEFAULT_EDITOR_PATTERN ? DEFAULT_SETTINGS.editorPattern : merged.editorPattern)
        : 'none',
      // 字体族名限长，避免异常值撑坏样式
      editorFont: typeof merged.editorFont === 'string' && merged.editorFont.trim().length > 0
        ? merged.editorFont.trim().slice(0, 120)
        : '',
      completionEnabled: booleanValue(merged.completionEnabled, DEFAULT_SETTINGS.completionEnabled),
      // 空串表示沿用「默认模型」，不做存在性校验（模型可能稍后才配置）
      completionModelConfigId: typeof merged.completionModelConfigId === 'string'
        ? merged.completionModelConfigId.trim()
        : '',
      completionTriggerKey: merged.completionTriggerKey === 'ctrl-arrow-right' || merged.completionTriggerKey === 'alt-slash'
        ? merged.completionTriggerKey
        : DEFAULT_SETTINGS.completionTriggerKey
    }
  }

  getDraftAssetDirectory(draftId: string): string {
    if (!this.getDraft(draftId)) throw new Error('当前文稿不存在，无法保存图片')
    const target = resolve(this.assetDirectory, draftId)
    const root = resolve(this.assetDirectory) + sep
    if (!target.startsWith(root)) throw new Error('图片目录无效')
    mkdirSync(target, { recursive: true })
    return target
  }

  resolveDraftAssetPath(draftId: string, fileName: string): string {
    const safeName = basename(fileName)
    if (!safeName || safeName !== fileName) throw new Error('图片文件名无效')
    const directory = resolve(this.assetDirectory, draftId)
    const root = resolve(this.assetDirectory) + sep
    if (!directory.startsWith(root)) throw new Error('图片目录无效')
    const target = resolve(directory, safeName)
    if (!target.startsWith(directory + sep)) throw new Error('图片路径无效')
    return target
  }

  /** 按文件路径查找已有文稿（同一文件重复打开时复用记录） */
  findFileDraft(filePath: string): Draft | null {
    const normalized = normalizeFilePath(filePath)
    // 兼容旧库中未归一的盘符、大小写及分隔符，不依赖 SQLite 仅 ASCII 的 NOCASE。
    const rows = this.db.prepare('SELECT * FROM drafts WHERE file_path IS NOT NULL ORDER BY updated_at DESC').all() as DraftRow[]
    const row = rows.find((item) => normalizeFilePath(item.file_path!) === normalized)
    return row ? this.mapDraft(row) : null
  }

  /** 从本地文件创建文件文稿：内容双写数据库，filePath 记录磁盘位置 */
  createFileDraft(filePath: string, content: string, displayMode: DisplayMode): Draft {
    filePath = normalizeFilePath(filePath)
    const existing = this.findFileDraft(filePath)
    if (existing) return existing
    const settings = this.getSettings()
    const now = Date.now()
    const draft: Draft = {
      id: randomUUID(), content, createdAt: now, updatedAt: now, version: 1,
      scene: settings.defaultScene, modelConfigId: settings.defaultModelConfigId, displayMode,
      filePath
    }
    this.db.prepare(`
      INSERT INTO drafts(id, content, created_at, updated_at, version, scene, model_config_id, display_mode, file_path)
      VALUES ($id, $content, $createdAt, $updatedAt, $version, $scene, $modelConfigId, $displayMode, $filePath)
    `).run({
      $id: draft.id, $content: draft.content, $createdAt: draft.createdAt, $updatedAt: draft.updatedAt, $version: draft.version,
      $scene: draft.scene, $modelConfigId: draft.modelConfigId, $displayMode: draft.displayMode, $filePath: draft.filePath
    })
    return draft
  }

  /** 把已有文稿转变为文件文稿（用于普通文稿另存到文件后绑定） */
  bindDraftFile(id: string, filePath: string): void {
    this.db.prepare('UPDATE drafts SET file_path = ? WHERE id = ?').run(normalizeFilePath(filePath), id)
  }

  createDraft(content = '', displayMode?: DisplayMode): Draft {
    const settings = this.getSettings()
    const now = Date.now()
    const initialContent = String(content)
    const draft: Draft = {
      id: randomUUID(), content: initialContent, createdAt: now, updatedAt: now, version: initialContent ? 1 : 0,
      scene: settings.defaultScene, modelConfigId: settings.defaultModelConfigId, displayMode: displayMode ?? settings.defaultDisplayMode,
      filePath: null
    }
    this.db.prepare(`
      INSERT INTO drafts(id, content, created_at, updated_at, version, scene, model_config_id, display_mode)
      VALUES ($id, $content, $createdAt, $updatedAt, $version, $scene, $modelConfigId, $displayMode)
    `).run({
      $id: draft.id, $content: draft.content, $createdAt: draft.createdAt, $updatedAt: draft.updatedAt, $version: draft.version,
      $scene: draft.scene, $modelConfigId: draft.modelConfigId, $displayMode: draft.displayMode
    })
    return draft
  }

  getDraft(id: string): Draft | null {
    const row = this.db.prepare('SELECT * FROM drafts WHERE id = ?').get(id) as DraftRow | undefined
    return row ? this.mapDraft(row) : null
  }

  getMostRecentDraft(): Draft | null {
    const row = this.db.prepare(`
      SELECT * FROM drafts
      ORDER BY CASE WHEN length(trim(content)) > 0 THEN 0 ELSE 1 END, updated_at DESC
      LIMIT 1
    `).get() as DraftRow | undefined
    return row ? this.mapDraft(row) : null
  }

  saveDraft(input: DraftSaveInput): Draft {
    return this.transaction(() => {
      const current = this.getDraft(input.id)
      if (!current) throw new Error('文稿不存在或已被移除')
      if (input.version < current.version) return current
      const contentChanged = current.content !== input.content
      const updatedAt = contentChanged ? Date.now() : current.updatedAt
      this.db.prepare(`
        UPDATE drafts SET content = $content, updated_at = $updatedAt, version = $version,
          scene = $scene, model_config_id = $modelConfigId, display_mode = $displayMode
        WHERE id = $id
      `).run({
        $id: input.id, $content: input.content, $updatedAt: updatedAt, $version: input.version,
        $scene: input.scene, $modelConfigId: input.modelConfigId, $displayMode: input.displayMode
      })
      return this.getDraft(input.id) as Draft
    })
  }

  deleteDraft(id: string): void {
    this.transaction(() => {
      const draft = this.getDraft(id)
      if (!draft) throw new Error('文稿不存在或已被删除')
      const openWindow = this.getOpenWindowForDraft(id)
      if (openWindow) throw new Error('该文稿仍在窗口中打开，请先关闭对应窗口')
      // F16：同步清理标签行，避免 window_tabs 悬挂引用已删除的文稿。
      this.db.prepare('DELETE FROM window_tabs WHERE draft_id = ?').run(id)
      this.db.prepare('DELETE FROM window_states WHERE draft_id = ?').run(id)
      this.db.prepare('DELETE FROM drafts WHERE id = ?').run(id)
    })
    // 删除文稿只删记录，保留资源目录，避免永久删除仍被导出内容或其他文稿引用的图片。
  }

  searchHistory(query: HistoryQuery): HistoryPage {
    const limit = Math.max(1, Math.min(100, query.limit))
    const search = query.search.trim()
    const params: Record<string, DbValue> = {
      $currentDraftId: query.currentDraftId,
      $limit: limit + 1
    }
    let searchCondition = ''
    let cursorCondition = ''
    if (search) {
      searchCondition = "AND content LIKE $search ESCAPE '\\' COLLATE NOCASE"
      params.$search = `%${this.escapeLike(search)}%`
    }
    if (query.cursor) {
      cursorCondition = 'AND (d.updated_at < $cursorUpdatedAt OR (d.updated_at = $cursorUpdatedAt AND d.id < $cursorId))'
      params.$cursorUpdatedAt = query.cursor.updatedAt
      params.$cursorId = query.cursor.id
    }
    const rows = this.db.prepare(`
      SELECT d.id,
        substr(replace(replace(trim(d.content), char(13), ' '), char(10), ' '), 1, 120) AS summary,
        d.updated_at, d.created_at, length(d.content) AS character_count, d.display_mode, d.file_path,
        CASE WHEN d.id = $currentDraftId THEN 1 ELSE 0 END AS is_current,
        (SELECT w.id FROM window_tabs t JOIN window_states w ON w.id = t.window_id
          WHERE t.draft_id = d.id AND w.is_open = 1
          ORDER BY w.last_active_at DESC LIMIT 1) AS open_window_id
      FROM drafts d
      WHERE length(trim(d.content)) > 0 ${searchCondition} ${cursorCondition}
      ORDER BY d.updated_at DESC, d.id DESC
      LIMIT $limit
    `).all(params) as Array<{
      id: string; summary: string; updated_at: number; created_at: number; character_count: number
      display_mode: DisplayMode; is_current: number; open_window_id: string | null; file_path: string | null
    }>
    const hasMore = rows.length > limit
    const visibleRows = rows.slice(0, limit)
    const items: DraftSummary[] = visibleRows.map((row) => ({
      id: row.id,
      summary: row.summary.replace(/\s+/g, ' ') || '无标题文稿',
      updatedAt: row.updated_at,
      createdAt: row.created_at,
      characterCount: row.character_count,
      displayMode: row.display_mode,
      isCurrent: Boolean(row.is_current),
      openWindowId: row.open_window_id,
      filePath: row.file_path
    }))
    const lastItem = items.at(-1)
    return {
      items,
      nextCursor: lastItem ? { updatedAt: lastItem.updatedAt, id: lastItem.id } : null,
      hasMore
    }
  }

  private escapeLike(value: string): string {
    return value.replace(/[\\%_]/g, (character) => `\\${character}`)
  }

  listModels(): ModelConfigPublic[] {
    const rows = this.db.prepare('SELECT * FROM model_configs ORDER BY is_default DESC, updated_at DESC').all() as ModelRow[]
    return rows.map((row) => this.mapModel(row))
  }

  getModelWithSecret(id: string): (ModelConfigPublic & { apiKey: string }) | null {
    const row = this.db.prepare('SELECT * FROM model_configs WHERE id = ?').get(id) as ModelRow | undefined
    if (!row) return null
    return { ...this.mapModel(row), apiKey: this.decryptApiKey(row.api_key) }
  }

  saveModel(input: ModelConfigInput): ModelConfigPublic[] {
    const now = Date.now()
    const id = input.id || randomUUID()
    const existing = this.db.prepare('SELECT api_key, created_at FROM model_configs WHERE id = ?').get(id) as {
      api_key: Uint8Array | null; created_at: number
    } | undefined
    let encryptedKey = existing?.api_key ?? null
    if (input.apiKey?.trim()) encryptedKey = this.encryptApiKey(input.apiKey.trim())
    if (!encryptedKey) throw new Error('请填写 API Key')

    this.transaction(() => {
      if (input.isDefault) this.db.exec('UPDATE model_configs SET is_default = 0')
      this.db.prepare(`
        INSERT INTO model_configs(
          id, name, provider, api_protocol, base_url, api_key, model_id,
          timeout_ms, max_tokens, temperature, reasoning_effort, is_default, created_at, updated_at
        ) VALUES (
          $id, $name, $provider, $apiProtocol, $baseUrl, $apiKey, $modelId,
          $timeoutMs, $maxTokens, $temperature, $reasoningEffort, $isDefault, $createdAt, $updatedAt
        )
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name, provider = excluded.provider, api_protocol = excluded.api_protocol,
          base_url = excluded.base_url, api_key = excluded.api_key, model_id = excluded.model_id,
          timeout_ms = excluded.timeout_ms, max_tokens = excluded.max_tokens,
          temperature = excluded.temperature, reasoning_effort = excluded.reasoning_effort,
          is_default = excluded.is_default, updated_at = excluded.updated_at
      `).run({
        $id: id, $name: input.name.trim(), $provider: input.provider, $apiProtocol: input.apiProtocol,
        $baseUrl: input.baseUrl.trim().replace(/\/+$/, ''), $apiKey: encryptedKey,
        $modelId: input.modelId.trim(), $timeoutMs: Math.max(5_000, Math.min(300_000, input.timeoutMs)),
        $maxTokens: Math.max(128, Math.min(128_000, input.maxTokens)), $temperature: input.temperature,
        $reasoningEffort: input.reasoningEffort, $isDefault: input.isDefault ? 1 : 0,
        $createdAt: existing?.created_at ?? now, $updatedAt: now
      })
      const settings = this.getSettings()
      if (input.isDefault) {
        this.saveSettings({ ...settings, defaultModelConfigId: id })
      } else if (settings.defaultModelConfigId === id) {
        this.saveSettings({ ...settings, defaultModelConfigId: null })
      }
    })
    return this.listModels()
  }

  deleteModel(id: string): ModelConfigPublic[] {
    this.transaction(() => {
      this.db.prepare('DELETE FROM model_configs WHERE id = ?').run(id)
      this.db.prepare('UPDATE drafts SET model_config_id = NULL WHERE model_config_id = ?').run(id)
      const settings = this.getSettings()
      if (settings.defaultModelConfigId === id) this.saveSettings({ ...settings, defaultModelConfigId: null })
    })
    return this.listModels()
  }

  private encryptApiKey(apiKey: string): Uint8Array {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('当前系统加密能力不可用，无法安全保存 API Key')
    return safeStorage.encryptString(apiKey)
  }

  private decryptApiKey(value: Uint8Array | null): string {
    if (!value) return ''
    if (!safeStorage.isEncryptionAvailable()) throw new Error('系统加密能力不可用，无法读取 API Key')
    return safeStorage.decryptString(Buffer.from(value))
  }

  createWindowRecord(draftId: string, width: number, height: number): WindowRecord {
    const record: WindowRecord = {
      id: randomUUID(), draftId, x: null, y: null, width, height, displayId: null,
      dockSide: null, isDocked: false, expandedX: null, expandedY: null,
      alwaysOnTop: false, fixedExpanded: false, isOpen: true, lastActiveAt: Date.now()
    }
    this.upsertWindow(record)
    // F16：新窗口自带首个标签，保证窗口永远至少有一个标签。
    this.addWindowTab(record.id, draftId)
    return record
  }

  upsertWindow(record: WindowRecord): void {
    this.db.prepare(`
      INSERT INTO window_states(
        id, draft_id, x, y, width, height, display_id, dock_side, is_docked,
        expanded_x, expanded_y, always_on_top, fixed_expanded, is_open, last_active_at
      ) VALUES (
        $id, $draftId, $x, $y, $width, $height, $displayId, $dockSide, $isDocked,
        $expandedX, $expandedY, $alwaysOnTop, $fixedExpanded, $isOpen, $lastActiveAt
      )
      ON CONFLICT(id) DO UPDATE SET
        draft_id = excluded.draft_id, x = excluded.x, y = excluded.y, width = excluded.width,
        height = excluded.height, display_id = excluded.display_id, dock_side = excluded.dock_side,
        is_docked = excluded.is_docked, expanded_x = excluded.expanded_x, expanded_y = excluded.expanded_y,
        always_on_top = excluded.always_on_top, fixed_expanded = excluded.fixed_expanded,
        is_open = excluded.is_open, last_active_at = excluded.last_active_at
    `).run({
      $id: record.id, $draftId: record.draftId, $x: record.x, $y: record.y, $width: record.width,
      $height: record.height, $displayId: record.displayId, $dockSide: record.dockSide,
      $isDocked: record.isDocked ? 1 : 0, $expandedX: record.expandedX, $expandedY: record.expandedY,
      $alwaysOnTop: record.alwaysOnTop ? 1 : 0, $fixedExpanded: record.fixedExpanded ? 1 : 0,
      $isOpen: record.isOpen ? 1 : 0, $lastActiveAt: record.lastActiveAt
    })
  }

  getWindow(id: string): WindowRecord | null {
    const row = this.db.prepare('SELECT * FROM window_states WHERE id = ?').get(id) as WindowRow | undefined
    return row ? this.mapWindow(row) : null
  }

  getRecoveryWindows(): WindowRecord[] {
    const rows = this.db.prepare('SELECT * FROM window_states WHERE is_open = 1 ORDER BY last_active_at ASC').all() as WindowRow[]
    return rows.map((row) => this.mapWindow(row))
  }

  /** 设置窗口当前活动文稿（window_states.draft_id 仍表示活动标签）。 */
  setWindowDraft(windowId: string, draftId: string): void {
    this.db.prepare('UPDATE window_states SET draft_id = ?, last_active_at = ?, is_open = 1 WHERE id = ?')
      .run(draftId, Date.now(), windowId)
  }

  /** 按 position 升序返回窗口内的标签文稿 id。 */
  listWindowTabs(windowId: string): string[] {
    const rows = this.db.prepare('SELECT draft_id FROM window_tabs WHERE window_id = ? ORDER BY position ASC').all(windowId) as Array<{ draft_id: string }>
    return rows.map((row) => row.draft_id)
  }

  /** 追加标签到末尾（已存在则不重复），并把该文稿设为窗口活动文稿。 */
  addWindowTab(windowId: string, draftId: string): void {
    this.transaction(() => {
      const existing = this.db.prepare('SELECT 1 FROM window_tabs WHERE window_id = ? AND draft_id = ?').get(windowId, draftId)
      if (!existing) {
        const row = this.db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS nextPosition FROM window_tabs WHERE window_id = ?').get(windowId) as { nextPosition: number }
        this.db.prepare('INSERT INTO window_tabs(window_id, draft_id, position) VALUES (?, ?, ?)').run(windowId, draftId, row.nextPosition)
      }
      this.setWindowDraft(windowId, draftId)
    })
  }

  removeWindowTab(windowId: string, draftId: string): void {
    this.db.prepare('DELETE FROM window_tabs WHERE window_id = ? AND draft_id = ?').run(windowId, draftId)
  }

  /** 按数组下标重排 position；只处理确实属于该窗口的 id，未知 id 直接忽略。 */
  reorderWindowTabs(windowId: string, orderedDraftIds: string[]): void {
    this.transaction(() => {
      const known = new Set(this.listWindowTabs(windowId))
      const update = this.db.prepare('UPDATE window_tabs SET position = ? WHERE window_id = ? AND draft_id = ?')
      let position = 0
      for (const draftId of orderedDraftIds) {
        if (!known.has(draftId)) continue
        update.run(position, windowId, draftId)
        position += 1
      }
    })
  }

  countWindowTabs(windowId: string): number {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM window_tabs WHERE window_id = ?').get(windowId) as { count: number }
    return row.count
  }

  /** 经 window_tabs 判定文稿是否已在打开窗口的任一标签中（活动或后台标签都算）。 */
  getOpenWindowForDraft(draftId: string, exceptWindowId?: string): WindowRecord | null {
    const statement = exceptWindowId
      ? this.db.prepare(`
          SELECT w.* FROM window_tabs t JOIN window_states w ON w.id = t.window_id
          WHERE t.draft_id = ? AND w.is_open = 1 AND w.id <> ?
          ORDER BY w.last_active_at DESC LIMIT 1
        `)
      : this.db.prepare(`
          SELECT w.* FROM window_tabs t JOIN window_states w ON w.id = t.window_id
          WHERE t.draft_id = ? AND w.is_open = 1
          ORDER BY w.last_active_at DESC LIMIT 1
        `)
    const row = (exceptWindowId ? statement.get(draftId, exceptWindowId) : statement.get(draftId)) as WindowRow | undefined
    return row ? this.mapWindow(row) : null
  }

  markWindowClosed(windowId: string): void {
    this.db.prepare('UPDATE window_states SET is_open = 0, last_active_at = ? WHERE id = ?').run(Date.now(), windowId)
  }

  // 查询最近关闭窗口的有效几何，供托盘重开或冷启动时继承尺寸与位置。
  getLastClosedWindowBounds(): { x: number; y: number; width: number; height: number; displayId: string | null } | null {
    const row = this.db.prepare(
      'SELECT x, y, width, height, display_id FROM window_states WHERE is_open = 0 AND x IS NOT NULL AND y IS NOT NULL ORDER BY last_active_at DESC LIMIT 1'
    ).get() as { x: number; y: number; width: number; height: number; display_id: string | null } | undefined
    if (!row) return null
    return { x: row.x, y: row.y, width: row.width, height: row.height, displayId: row.display_id }
  }

  private mapDraft(row: DraftRow): Draft {
    return {
      id: row.id, content: row.content, createdAt: row.created_at, updatedAt: row.updated_at,
      version: row.version, scene: row.scene, modelConfigId: row.model_config_id, displayMode: row.display_mode,
      filePath: row.file_path ?? null
    }
  }

  private mapModel(row: ModelRow): ModelConfigPublic {
    return {
      id: row.id, name: row.name, provider: row.provider, apiProtocol: row.api_protocol,
      baseUrl: row.base_url, modelId: row.model_id, timeoutMs: row.timeout_ms, maxTokens: row.max_tokens,
      temperature: row.temperature, reasoningEffort: row.reasoning_effort, isDefault: Boolean(row.is_default),
      hasApiKey: Boolean(row.api_key?.length), createdAt: row.created_at, updatedAt: row.updated_at
    }
  }

  /** 写入一条 AI 调用用量；失败也要记，补全的静默失败靠这里排查。 */
  recordTokenUsage(input: TokenUsageInput): void {
    const createdAt = Date.now()
    const promptTokens = Math.max(0, Math.round(input.promptTokens ?? 0))
    const completionTokens = Math.max(0, Math.round(input.completionTokens ?? 0))
    // 部分服务（非 DeepSeek）不返回缓存字段，此时整段输入计入未命中，命中率才不会虚高。
    const cacheHitTokens = Math.max(0, Math.round(input.cacheHitTokens ?? 0))
    const cacheMissTokens = input.cacheMissTokens === undefined
      ? Math.max(0, promptTokens - cacheHitTokens)
      : Math.max(0, Math.round(input.cacheMissTokens))
    this.db.prepare(`
      INSERT INTO token_usage(
        id, created_at, day, kind, scene, model_config_id, model_name,
        prompt_tokens, completion_tokens, total_tokens,
        cache_hit_tokens, cache_miss_tokens, status, duration_ms, error_message
      ) VALUES (
        $id, $createdAt, $day, $kind, $scene, $modelConfigId, $modelName,
        $promptTokens, $completionTokens, $totalTokens,
        $cacheHitTokens, $cacheMissTokens, $status, $durationMs, $errorMessage
      )
    `).run({
      $id: randomUUID(),
      $createdAt: createdAt,
      $day: this.toDayKey(createdAt),
      $kind: input.kind,
      $scene: input.scene,
      $modelConfigId: input.modelConfigId,
      $modelName: input.modelName,
      $promptTokens: promptTokens,
      $completionTokens: completionTokens,
      $totalTokens: promptTokens + completionTokens,
      $cacheHitTokens: cacheHitTokens,
      $cacheMissTokens: cacheMissTokens,
      $status: input.status,
      $durationMs: input.durationMs ?? null,
      $errorMessage: input.errorMessage ? String(input.errorMessage).slice(0, 300) : null
    })
  }

  /** 按日期区间 / 模型 / 类型聚合用量，同时给出汇总、按天与按模型三个视图。 */
  queryTokenUsage(query: TokenUsageQuery): TokenUsageResult {
    const params: Record<string, DbValue> = {
      $fromDay: query.fromDay,
      $toDay: query.toDay,
      $modelConfigId: query.modelConfigId,
      $kind: query.kind
    }
    const conditions = [
      '($fromDay IS NULL OR day >= $fromDay)',
      '($toDay IS NULL OR day <= $toDay)',
      '($modelConfigId IS NULL OR model_config_id = $modelConfigId)',
      '($kind IS NULL OR kind = $kind)'
    ].join(' AND ')
    const metrics = `COUNT(*) AS calls,
      SUM(prompt_tokens) AS promptTokens,
      SUM(completion_tokens) AS completionTokens,
      SUM(total_tokens) AS totalTokens,
      SUM(cache_hit_tokens) AS cacheHitTokens,
      SUM(cache_miss_tokens) AS cacheMissTokens,
      SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errorCalls`
    const summary = this.db.prepare(`SELECT ${metrics} FROM token_usage WHERE ${conditions}`).get(params)
    const byDay = this.db.prepare(`
      SELECT day AS key, day AS label, ${metrics} FROM token_usage
      WHERE ${conditions} GROUP BY day ORDER BY day DESC
    `).all(params)
    const byModel = this.db.prepare(`
      SELECT COALESCE(model_config_id, '') AS key, model_name AS label, ${metrics} FROM token_usage
      WHERE ${conditions} GROUP BY model_name ORDER BY totalTokens DESC
    `).all(params)
    return {
      summary: this.mapUsageSummary(summary as UsageRow | undefined),
      byDay: (byDay as UsageRow[]).map((row) => ({ ...this.mapUsageSummary(row), key: row.key, label: row.label })),
      byModel: (byModel as UsageRow[]).map((row) => ({ ...this.mapUsageSummary(row), key: row.key, label: row.label }))
    }
  }

  /** 清空全部用量记录（设置页手动触发，需二次确认）。 */
  clearTokenUsage(): void {
    this.db.exec('DELETE FROM token_usage')
  }

  private mapUsageSummary(row: UsageRow | undefined): TokenUsageSummary {
    const cacheHitTokens = Number(row?.cacheHitTokens ?? 0)
    const cacheMissTokens = Number(row?.cacheMissTokens ?? 0)
    const cacheTotal = cacheHitTokens + cacheMissTokens
    return {
      calls: Number(row?.calls ?? 0),
      promptTokens: Number(row?.promptTokens ?? 0),
      completionTokens: Number(row?.completionTokens ?? 0),
      totalTokens: Number(row?.totalTokens ?? 0),
      cacheHitTokens,
      cacheMissTokens,
      // 没有任何缓存数据时给 null，界面显示「—」而不是 0%，避免误导。
      cacheHitRate: cacheTotal > 0 ? cacheHitTokens / cacheTotal : null,
      errorCalls: Number(row?.errorCalls ?? 0)
    }
  }

  /** 本地日期键（YYYY-MM-DD），按用户所在时区切天。 */
  private toDayKey(timestamp: number): string {
    const date = new Date(timestamp)
    const pad = (value: number) => String(value).padStart(2, '0')
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  }

  private mapWindow(row: WindowRow): WindowRecord {
    return {
      id: row.id, draftId: row.draft_id, x: row.x, y: row.y, width: row.width, height: row.height,
      displayId: row.display_id, dockSide: row.dock_side, isDocked: Boolean(row.is_docked),
      expandedX: row.expanded_x, expandedY: row.expanded_y, alwaysOnTop: Boolean(row.always_on_top),
      fixedExpanded: Boolean(row.fixed_expanded), isOpen: Boolean(row.is_open), lastActiveAt: row.last_active_at
    }
  }
}

