import { describe, expect, it } from 'vitest'
import { displayModeForFile, readTextFile, writeTextFileUtf8, snapshotFile } from '../src/main/file-drafts'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 临时测试文件保留供复查，不使用自动永久删除目录的清理流程。
describe('文件文稿读写模块', () => {
  it('扩展名推断编辑模式', () => {
    expect(displayModeForFile('C:/笔记.md')).toBe('markdown')
    expect(displayModeForFile('C:/笔记.MARKDOWN')).toBe('markdown')
    expect(displayModeForFile('C:/笔记.txt')).toBe('txt')
    expect(displayModeForFile('C:/笔记')).toBe('txt')
  })

  it('UTF-8 内容直接解码，不标记转换', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sheeptext-file-'))
    const filePath = join(dir, 'a.txt')
    await writeTextFileUtf8(filePath, '中文内容 hello')
    const { content, convertedFromGbk } = await readTextFile(filePath)
    expect(content).toBe('中文内容 hello')
    expect(convertedFromGbk).toBe(false)
  })

  it('GBK 编码内容兜底解码并标记转换', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sheeptext-gbk-'))
    // “你好”的 GBK 编码字节。
    await writeFile(join(dir, 'b.txt'), Buffer.from([0xc4, 0xe3, 0xba, 0xc3]))
    const { content, convertedFromGbk } = await readTextFile(join(dir, 'b.txt'))
    expect(content).toBe('你好')
    expect(convertedFromGbk).toBe(true)
  })

  it('UTF-8 BOM 自动剥离', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sheeptext-bom-'))
    await writeFile(join(dir, 'c.txt'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('BOM 内容', 'utf8')]))
    const { content, convertedFromGbk } = await readTextFile(join(dir, 'c.txt'))
    expect(content).toBe('BOM 内容')
    expect(convertedFromGbk).toBe(false)
  })

  it('快照记录 mtime 与大小，文件不存在返回 null', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sheeptext-snap-'))
    const filePath = join(dir, 'd.txt')
    await writeFile(filePath, '12345', 'utf8')
    const snap = await snapshotFile(filePath)
    expect(snap).not.toBeNull()
    expect(snap!.size).toBe(5)
    expect(await snapshotFile(join(dir, 'missing.txt'))).toBeNull()
  })
})
