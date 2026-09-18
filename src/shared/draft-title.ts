/**
 * 标签标题规则（主进程与渲染层共用，避免两处实现漂移）：
 * 本地文件取文件名；普通文稿取正文首个非空行的前 24 个字符；没有内容时显示“空白文稿”。
 */
export const EMPTY_DRAFT_TAB_TITLE = '空白文稿'

export function draftTabTitle(draft: { filePath: string | null; content: string }): string {
  if (draft.filePath) return lastPathSegment(draft.filePath)
  const firstLine = draft.content.split(/\r?\n/).map((line) => line.trim()).find((line) => line.length > 0) ?? ''
  if (!firstLine) return EMPTY_DRAFT_TAB_TITLE
  const characters = Array.from(firstLine)
  return characters.length > 24 ? characters.slice(0, 24).join('') : firstLine
}

/** 取路径最后一段；渲染层没有 node:path，因此自行处理两种分隔符。 */
function lastPathSegment(filePath: string): string {
  const parts = filePath.split(/[\\/]/)
  return parts[parts.length - 1] || filePath
}