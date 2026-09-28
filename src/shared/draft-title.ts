/**
 * 标签 / 窗口 / 历史列表共用的文稿标题规则（主进程与渲染层共用，避免两处实现漂移）：
 * 本地文件取文件名；普通文稿优先用用户自定义标题，其次取正文首个非空行的前 24 个字符；
 * 都没有内容时显示“空白文稿”。
 */
export const EMPTY_DRAFT_TAB_TITLE = '空白文稿'

/** 自定义标题的输入上限，避免异常长的标题撑坏标签与历史列表。 */
export const DRAFT_TITLE_MAX_LENGTH = 60

/** AI 生成标题的长度上限：短一些更贴近标签栏的实际可读宽度。 */
export const AI_TITLE_MAX_LENGTH = 18

export function draftTabTitle(draft: { title?: string | null; filePath: string | null; content: string }): string {
  if (draft.filePath) return lastPathSegment(draft.filePath)
  const custom = String(draft.title ?? '').trim()
  if (custom) return custom
  const firstLine = draft.content.split(/\r?\n/).map((line) => line.trim()).find((line) => line.length > 0) ?? ''
  if (!firstLine) return EMPTY_DRAFT_TAB_TITLE
  const characters = Array.from(firstLine)
  return characters.length > 24 ? characters.slice(0, 24).join('') : firstLine
}

/**
 * 清洗标题文本：压平空白、去掉包裹的引号/书名号与「标题：」这类前缀。
 * 用户手输与模型返回共用，保证入库的标题总是干净的一行。
 */
export function sanitizeDraftTitle(raw: string, maxLength = DRAFT_TITLE_MAX_LENGTH): string {
  // 控制字符（含换行、制表）先压成空格，避免标题里出现不可见字符
  let text = String(raw ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ')
  text = text.replace(/\s+/g, ' ').trim()
  text = text.replace(/^(?:标题|题目|名称|title)\s*[:：]\s*/i, '')
  text = text.replace(/^[「『“"'《【\[]+/, '').replace(/[」』”"'》】\]]+$/, '')
  text = text.replace(/[。，、；：]+$/, '').trim()
  const characters = Array.from(text)
  return characters.length > maxLength ? characters.slice(0, maxLength).join('') : text
}

/** 取路径最后一段；渲染层没有 node:path，因此自行处理两种分隔符。 */
function lastPathSegment(filePath: string): string {
  const parts = filePath.split(/[\\/]/)
  return parts[parts.length - 1] || filePath
}