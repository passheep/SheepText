// 本地文件文稿：严格解码与路径身份归一，不在读取时隐式转换磁盘文件。
import { stat, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve, win32 } from 'node:path'

export function displayModeForFile(filePath: string): 'txt' | 'markdown' {
  return /\.(md|markdown)$/i.test(filePath) ? 'markdown' : 'txt'
}

/** Windows 路径统一分隔符、绝对路径和大小写；不把大小写规则施加于 POSIX。 */
export function normalizeFilePath(filePath: string, cwd = process.cwd()): string {
  if (typeof filePath !== 'string' || !filePath.trim() || filePath.includes('\0')) throw new Error('文件路径无效')
  if (process.platform === 'win32' || win32.isAbsolute(filePath) || win32.isAbsolute(cwd)) {
    return win32.resolve(cwd, filePath).toLowerCase()
  }
  return resolve(cwd, filePath)
}

export type FileSnapshot = { mtimeMs: number; size: number }
export type SourceEncoding = 'utf8' | 'utf8-bom' | 'utf16le' | 'utf16be' | 'gbk'
export type TextFileContents = { content: string; convertedFromGbk: boolean; sourceEncoding: SourceEncoding }

export function isMissingFileError(error: unknown): boolean {
  return ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException)?.code ?? '')
}

export async function snapshotFile(filePath: string): Promise<FileSnapshot | null> {
  try {
    const info = await stat(filePath)
    if (!info.isFile()) throw new Error('路径不是普通文件')
    return { mtimeMs: info.mtimeMs, size: info.size }
  } catch (error) {
    if (isMissingFileError(error)) return null
    throw error
  }
}

/** BOM 确定的编码不再降级兜底，非法/截断序列必须报错，避免替换字符写回损坏正文。 */
export function decodeTextFile(buffer: Uint8Array): TextFileContents {
  const decode = (encoding: string, offset = 0): string => new TextDecoder(encoding, { fatal: true }).decode(buffer.subarray(offset))
  let content: string
  let sourceEncoding: SourceEncoding
  if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    content = decode('utf-8', 3); sourceEncoding = 'utf8-bom'
  } else if (buffer[0] === 0xff && buffer[1] === 0xfe) {
    content = decode('utf-16le', 2); sourceEncoding = 'utf16le'
  } else if (buffer[0] === 0xfe && buffer[1] === 0xff) {
    content = decode('utf-16be', 2); sourceEncoding = 'utf16be'
  } else {
    try { content = decode('utf-8'); sourceEncoding = 'utf8' }
    catch { content = decode('gbk'); sourceEncoding = 'gbk' }
  }
  return { content, sourceEncoding, convertedFromGbk: sourceEncoding === 'gbk' }
}

export async function readTextFile(filePath: string): Promise<TextFileContents> {
  return decodeTextFile(await readFile(filePath))
}

/** 写回前由服务检查冲突与版本，统一以无 BOM UTF-8 写入。 */
export async function writeTextFileUtf8(filePath: string, content: string): Promise<void> {
  // writeFile 的默认模式同时截断旧尾部；写入失败由服务保留 DB 备份并向上抛出。
  await writeFile(filePath, content, { encoding: 'utf8' })
}

export function fileDirectory(filePath: string): string {
  return dirname(filePath)
}
