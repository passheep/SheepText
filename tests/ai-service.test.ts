import { describe, expect, it } from 'vitest'
import { buildEnhancePrompt, protectSensitiveSegments } from '../src/main/ai-service'

describe('AI 改写保护', () => {
  it('为选区请求明确限制上下文', () => {
    const prompt = buildEnhancePrompt('coding', 'conservative', true)
    expect(prompt).toContain('只有选区内容')
    expect(prompt).toContain('不回答、执行')
    expect(prompt).toContain('必须保留阶段要求、代码、路径、标识符')
  })

  it('区分保守增强与创意重写', () => {
    expect(buildEnhancePrompt('general', 'conservative', false)).toContain('尽量不增加新要求')
    expect(buildEnhancePrompt('image', 'creative', false)).toContain('补充真正有用的细节')
  })

  it('完整保护代码、链接和 Windows 路径并恢复', () => {
    const source = [
      '请修改 `saveDraft`，参考 C:\\work\\项目\\draft.ts。',
      '```ts',
      'const value = 1',
      '```',
      '接口文档：https://example.com/api?id=1'
    ].join('\n')
    const protectedValue = protectSensitiveSegments(source)
    expect(protectedValue.text).not.toContain('const value = 1')
    expect(protectedValue.text).not.toContain('https://example.com')
    expect(protectedValue.restore(protectedValue.text)).toBe(source)
  })

  it('模型丢失保护占位符时拒绝采用结果', () => {
    const protectedValue = protectSensitiveSegments('保留 `draftId` 不变')
    expect(() => protectedValue.restore('占位符被模型删除了')).toThrow('模型未完整保留')
  })
})
