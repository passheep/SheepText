import { describe, expect, it } from 'vitest'
import { stripPasteMarkdown } from '../src/shared/paste-format'

describe('粘贴清除格式转换', () => {
  it('去掉标题、强调与行内代码标记', () => {
    const source = ['### 标题样式', '**加粗** 与 *斜体* 和 `code`', '~~删除线~~'].join('\n')
    expect(stripPasteMarkdown(source)).toBe(['标题样式', '加粗 与 斜体 和 code', '删除线'].join('\n'))
  })

  it('列表与引用转为正文并保留缩进', () => {
    const source = ['- 第一项', '  1. 子项目', '> 引用文字'].join('\n')
    expect(stripPasteMarkdown(source)).toBe(['第一项', '  子项目', '引用文字'].join('\n'))
  })

  it('代码围栏内文字原样保留，仅去掉围栏行', () => {
    const source = ['```ts', 'const value = 1 // **不转换**', '```', '完'].join('\n')
    expect(stripPasteMarkdown(source)).toBe(['const value = 1 // **不转换**', '完'].join('\n'))
  })

  it('链接与图片保留可读文字与地址', () => {
    expect(stripPasteMarkdown('[文档](https://example.com)')).toBe('文档（https://example.com）')
    expect(stripPasteMarkdown('![示意图](https://example.com/a.png)')).toBe('示意图（https://example.com/a.png）')
  })

  it('空文本原样返回', () => {
    expect(stripPasteMarkdown('')).toBe('')
  })
})
