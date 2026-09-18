import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { DataStore } from '../src/main/data-store'
import { DEFAULT_SETTINGS } from '../src/shared/constants'

// DataStore 只从 electron 取 safeStorage，设置归一化用例不会触碰系统能力。
vi.mock('electron', () => ({
  app: { isPackaged: false },
  BrowserWindow: class {},
  screen: { getAllDisplays: () => [], getPrimaryDisplay: () => ({ id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: () => { throw new Error('测试环境不支持加密') },
    decryptString: () => { throw new Error('测试环境不支持解密') }
  }
}))

// 临时目录保留供复查，不做永久删除式清理。
function tempStore(): DataStore {
  return new DataStore(mkdtempSync(join(tmpdir(), 'sheeptext-settings-')))
}

describe('应用设置归一化', () => {
  it('默认不铺背景纹理、不指定编辑器字体', () => {
    const store = tempStore()
    const settings = store.getSettings()
    expect(settings.editorPattern).toBe('none')
    expect(settings.editorFont).toBe('')
    expect(DEFAULT_SETTINGS.editorPattern).toBe('none')
    store.close()
  })

  it('停留在旧默认纹理的用户迁到无纹理，其他选择保留', () => {
    const store = tempStore()
    // 旧默认值 grid-large 视为“从未改过”，跟随新默认值
    expect(store.saveSettings({ ...DEFAULT_SETTINGS, editorPattern: 'grid-large' }).editorPattern).toBe('none')
    // 用户主动选择的其他纹理保持不动
    expect(store.saveSettings({ ...DEFAULT_SETTINGS, editorPattern: 'lines' }).editorPattern).toBe('lines')
    expect(store.saveSettings({ ...DEFAULT_SETTINGS, editorPattern: 'waves' }).editorPattern).toBe('waves')
    store.close()
  })

  it('编辑器字体为空或异常时回落到默认字体栈', () => {
    const store = tempStore()
    expect(store.saveSettings({ ...DEFAULT_SETTINGS, editorFont: '' }).editorFont).toBe('')
    expect(store.saveSettings({ ...DEFAULT_SETTINGS, editorFont: '   ' }).editorFont).toBe('')
    expect(store.saveSettings({ ...DEFAULT_SETTINGS, editorFont: '  楷体  ' }).editorFont).toBe('楷体')
    // 超长字体名截断到 120 字符，避免异常值撑坏样式
    expect(store.saveSettings({ ...DEFAULT_SETTINGS, editorFont: 'x'.repeat(200) }).editorFont).toHaveLength(120)
    store.close()
  })

  it('旧默认主题色迁移到新默认值，自定义主题色保留', () => {
    const store = tempStore()
    expect(store.saveSettings({ ...DEFAULT_SETTINGS, themeColor: '#6958cf' }).themeColor).toBe('#6958bb')
    expect(store.saveSettings({ ...DEFAULT_SETTINGS, themeColor: '#1f56f5' }).themeColor).toBe('#1f56f5')
    store.close()
  })
})