// 粘贴内容“清除格式”转换：把已带 Markdown 标记的文本转为可读正文（方案 B）。
// 仅处理文字格式标记，保留段落换行、缩进与代码块内文字；不处理图片下载或 HTML 富样式。
export function stripPasteMarkdown(source: string): string {
  if (!source) return source
  const lines = source.split(/\r?\n/)
  const result: string[] = []
  let fenceOpen = false
  let fenceMarker = ''

  for (const line of lines) {
    // 代码围栏：丢弃围栏行本身，保留内部代码文字与缩进
    if (/^\s*(```|~~~)/.test(line)) {
      const marker = line.trim().slice(0, 3)
      if (!fenceOpen) {
        fenceOpen = true
        fenceMarker = marker
      } else if (marker === fenceMarker) {
        fenceOpen = false
        fenceMarker = ''
      }
      continue
    }
    if (fenceOpen) {
      result.push(line)
      continue
    }

    let text = line
    // 标题、引用、列表与任务列表前缀
    text = text.replace(/^(\s*)#{1,6}\s+/, '$1')
    text = text.replace(/^(\s*)>\s?/, '$1')
    text = text.replace(/^(\s*)[-*+]\s+(?:\[[ xX]\]\s+)?/, '$1')
    text = text.replace(/^(\s*)\d+[.)]\s+/, '$1')
    // 图片与链接：保留可读文字与地址信息
    text = text.replace(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, (_m, alt: string, url: string) => (alt ? `${alt}（${url}）` : url))
    text = text.replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, (_m, label: string, url: string) => (label === url ? url : `${label}（${url}）`))
    // 强调、删除线与行内代码标记
    text = text.replace(/(\*\*\*|___)(?=\S)([\s\S]*?\S)\1/g, '$2')
    text = text.replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '$2')
    text = text.replace(/(^|[^*])\*(?!\s)([^*\r\n]*?)\*(?!\*)/g, '$1$2')
    text = text.replace(/(?<![\w_])_(?=\S)([^_\r\n]*?\S)_(?![\w_])/g, '$1')
    text = text.replace(/~~(?=\S)([\s\S]*?\S)~~/g, '$1')
    text = text.replace(/`([^`\r\n]+)`/g, '$1')

    result.push(text)
  }
  return result.join('\n')
}
