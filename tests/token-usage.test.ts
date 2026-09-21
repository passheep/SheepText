import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { DataStore } from '../src/main/data-store'

// DataStore 只从 electron 取 safeStorage，用量统计用例不触碰系统能力。
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
  return new DataStore(mkdtempSync(join(tmpdir(), 'sheeptext-usage-')))
}

const ALL: Parameters<DataStore['queryTokenUsage']>[0] = { fromDay: null, toDay: null, modelConfigId: null, kind: null }

describe('AI 用量统计', () => {
  it('汇总输入、输出、总量与调用次数', () => {
    const store = tempStore()
    store.recordTokenUsage({
      kind: 'enhance', scene: 'general', modelConfigId: 'm1', modelName: '模型甲',
      promptTokens: 1200, completionTokens: 300, cacheHitTokens: 1000, cacheMissTokens: 200,
      status: 'ok', durationMs: 900
    })
    store.recordTokenUsage({
      kind: 'enhance', scene: 'coding', modelConfigId: 'm1', modelName: '模型甲',
      promptTokens: 800, completionTokens: 100, cacheHitTokens: 0, cacheMissTokens: 800,
      status: 'ok', durationMs: 700
    })
    const { summary } = store.queryTokenUsage(ALL)
    expect(summary.calls).toBe(2)
    expect(summary.promptTokens).toBe(2000)
    expect(summary.completionTokens).toBe(400)
    expect(summary.totalTokens).toBe(2400)
    expect(summary.cacheHitTokens).toBe(1000)
    expect(summary.cacheMissTokens).toBe(1000)
    expect(summary.cacheHitRate).toBeCloseTo(0.5, 5)
    expect(summary.errorCalls).toBe(0)
    store.close()
  })

  it('服务不返回缓存字段时，整段输入计入未命中', () => {
    const store = tempStore()
    store.recordTokenUsage({
      kind: 'enhance', scene: 'general', modelConfigId: 'm2', modelName: '模型乙',
      promptTokens: 500, completionTokens: 50, status: 'ok'
    })
    const { summary } = store.queryTokenUsage(ALL)
    expect(summary.cacheHitTokens).toBe(0)
    expect(summary.cacheMissTokens).toBe(500)
    expect(summary.cacheHitRate).toBe(0)
    store.close()
  })

  it('完全没有缓存数据时命中率为 null（界面显示「—」）', () => {
    const store = tempStore()
    const { summary } = store.queryTokenUsage(ALL)
    expect(summary.calls).toBe(0)
    expect(summary.cacheHitRate).toBeNull()
    store.close()
  })

  it('失败调用单独计数并保留原因', () => {
    const store = tempStore()
    store.recordTokenUsage({
      kind: 'completion', scene: null, modelConfigId: 'm3', modelName: '模型丙',
      status: 'error', durationMs: 8000, errorMessage: '模型未返回补全结果'
    })
    const { summary, byModel } = store.queryTokenUsage(ALL)
    expect(summary.calls).toBe(1)
    expect(summary.errorCalls).toBe(1)
    expect(summary.totalTokens).toBe(0)
    expect(byModel[0].label).toBe('模型丙')
    expect(byModel[0].errorCalls).toBe(1)
    store.close()
  })

  it('按类型、模型与日期区间筛选', () => {
    const store = tempStore()
    store.recordTokenUsage({ kind: 'enhance', scene: 'general', modelConfigId: 'm1', modelName: '甲', promptTokens: 100, status: 'ok' })
    store.recordTokenUsage({ kind: 'completion', scene: null, modelConfigId: 'm2', modelName: '乙', promptTokens: 200, status: 'ok' })
    expect(store.queryTokenUsage({ ...ALL, kind: 'completion' }).summary.totalTokens).toBe(200)
    expect(store.queryTokenUsage({ ...ALL, modelConfigId: 'm1' }).summary.totalTokens).toBe(100)

    // 未来日期区间应当筛掉全部记录
    expect(store.queryTokenUsage({ ...ALL, fromDay: '2099-01-01' }).summary.calls).toBe(0)
    // 覆盖今天的区间应当保留
    const today = new Date()
    const pad = (v: number) => String(v).padStart(2, '0')
    const todayKey = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`
    expect(store.queryTokenUsage({ ...ALL, fromDay: todayKey, toDay: todayKey }).summary.calls).toBe(2)
    store.close()
  })

  it('按天与按模型分组', () => {
    const store = tempStore()
    store.recordTokenUsage({ kind: 'enhance', scene: 'general', modelConfigId: 'm1', modelName: '甲', promptTokens: 100, completionTokens: 10, status: 'ok' })
    store.recordTokenUsage({ kind: 'enhance', scene: 'general', modelConfigId: 'm2', modelName: '乙', promptTokens: 300, completionTokens: 30, status: 'ok' })
    const { byDay, byModel } = store.queryTokenUsage(ALL)
    expect(byDay).toHaveLength(1)
    expect(byDay[0].totalTokens).toBe(440)
    // 中文不按拼音排序，这里只比对集合
    expect(new Set(byModel.map((row) => row.label))).toEqual(new Set(['甲', '乙']))
    // 按模型分组按总量降序，模型乙在前
    expect(byModel[0].label).toBe('乙')
    store.close()
  })

  it('清空后不留任何记录', () => {
    const store = tempStore()
    store.recordTokenUsage({ kind: 'enhance', scene: 'general', modelConfigId: 'm1', modelName: '甲', promptTokens: 100, status: 'ok' })
    store.clearTokenUsage()
    const { summary, byDay, byModel } = store.queryTokenUsage(ALL)
    expect(summary.calls).toBe(0)
    expect(byDay).toEqual([])
    expect(byModel).toEqual([])
    store.close()
  })
})