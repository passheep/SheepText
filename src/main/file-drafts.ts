// 本地文件文稿支持：编码探测读写、外部修改快照（需求 20260917 F14~F17）。
import { stat, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** 支持的本地文稿扩展名与对应编辑模式 */
export function displayModeForFile(filePath: string): 'txt' | 'markdown' {
  return /\.(md|markdown)$/i.test(filePath) ? 'markdown' : 'txt'
}

/** 文件外部修改快照：打开/保存后记录，切回窗口时比对 */
export type FileSnapshot = { mtimeMs: number; size: number }

export async function snapshotFile(filePath: string): Promise<FileSnapshot | null> {
  try {
    const info = await stat(filePath)
    return { mtimeMs: info.mtimeMs, size: info.size }
  } catch {
    return null
  }
}

/**
 * 读取文件内容：先按 UTF-8 严格解码，失败（含多字节截断）再按 GBK 兜底。
 * 返回转换标记供保存提示使用。
 */
export async function readTextFile(filePath: string): Promise<{ content: string; convertedFromGbk: boolean }> {
  const buffer = await readFile(filePath)
  // BOM 处理
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return { content: new TextDecoder('utf-8').decode(buffer.subarray(3)), convertedFromGbk: false }
  }
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return { content: new TextDecoder('utf-16le').decode(buffer.subarray(2)), convertedFromGbk: false }
  }
  // UTF-8 严格解码：包含非法序列即认为不是 UTF-8
  const strictUtf8 = new TextDecoder('utf-8', { fatal: true })
  try {
    return { content: strictUtf8.decode(buffer), convertedFromGbk: false }
  } catch {
    // GBK 兜底（Node/Electron 内置 ICU 支持 gbk 标签）
    const decoded = new TextDecoder('gbk').decode(buffer)
    return { content: decoded, convertedFromGbk: true }
  }
}

/** 统一以 UTF-8 写回文件 */
export async function writeTextFileUtf8(filePath: string, content: string): Promise<void> {
  await writeFile(filePath, content, { encoding: 'utf8' })
}

export function fileDirectory(filePath: string): string {
  return dirname(filePath)
}
