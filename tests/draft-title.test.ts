import { describe, expect, it } from 'vitest'
import { draftTabTitle, EMPTY_DRAFT_TAB_TITLE, sanitizeDraftTitle } from '../src/shared/draft-title'

describe('draftTabTitle', () => {
  it('本地文件文稿取文件名，忽略自定义标题', () => {
    expect(draftTabTitle({ title: '自定义名', filePath: 'C:\\notes\\a.md', content: '# 正文标题' })).toBe('a.md')
    expect(draftTabTitle({ title: '自定义名', filePath: '/tmp/b.txt', content: '' })).toBe('b.txt')
  })

  it('普通文稿优先使用自定义标题', () => {
    expect(draftTabTitle({ title: '周报草稿', filePath: null, content: '第一行内容' })).toBe('周报草稿')
    // 只有空白字符的自定义标题视为未命名
    expect(draftTabTitle({ title: '   ', filePath: null, content: '第一行内容' })).toBe('第一行内容')
  })

  it('未命名时取正文首个非空行并截断到 24 字', () => {
    expect(draftTabTitle({ title: null, filePath: null, content: '\n\n  实际首行  \n第二行' })).toBe('实际首行')
    const long = '一'.repeat(30)
    expect(draftTabTitle({ title: null, filePath: null, content: long })).toBe('一'.repeat(24))
  })

  it('空文稿返回「空白文稿」', () => {
    expect(draftTabTitle({ title: null, filePath: null, content: '   \n\n  ' })).toBe(EMPTY_DRAFT_TAB_TITLE)
    expect(draftTabTitle({ filePath: null, content: '' })).toBe(EMPTY_DRAFT_TAB_TITLE)
  })
})

describe('sanitizeDraftTitle', () => {
  it('压平空白与换行', () => {
    expect(sanitizeDraftTitle('  项目\n\n进度   汇报  ')).toBe('项目 进度 汇报')
  })

  it('去掉包裹的引号与书名号', () => {
    expect(sanitizeDraftTitle('「项目进度」')).toBe('项目进度')
    expect(sanitizeDraftTitle('"项目进度"')).toBe('项目进度')
    expect(sanitizeDraftTitle('《项目进度》')).toBe('项目进度')
    expect(sanitizeDraftTitle('【项目进度】')).toBe('项目进度')
  })

  it('去掉「标题：」前缀与结尾标点', () => {
    expect(sanitizeDraftTitle('标题：项目进度')).toBe('项目进度')
    expect(sanitizeDraftTitle('Title: 项目进度')).toBe('项目进度')
    expect(sanitizeDraftTitle('项目进度。')).toBe('项目进度')
  })

  it('按字符数截断，不切断代理对', () => {
    expect(sanitizeDraftTitle('一'.repeat(80), 24)).toBe('一'.repeat(24))
    // 表情符号占两个 UTF-16 单元，按字符截断后不应出现半个代理对
    const emoji = '🙂'.repeat(30)
    expect(Array.from(sanitizeDraftTitle(emoji, 10)).length).toBe(10)
  })

  it('空输入返回空串', () => {
    expect(sanitizeDraftTitle('')).toBe('')
    expect(sanitizeDraftTitle('   ')).toBe('')
    expect(sanitizeDraftTitle('「」')).toBe('')
  })
})