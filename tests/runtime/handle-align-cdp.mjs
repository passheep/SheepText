// 量取块操作手柄与所在文本行的对齐情况：直接找与手柄中心最近的文本行，不依赖块结构。
// 只创建测试文件，不删除文件。
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
const port = process.env.SHEEPTEXT_CDP_PORT || '9338'
const wait = ms => new Promise(r => setTimeout(r, ms))
const pages = async () => (await (await fetch(`http://localhost:${port}/json/list`)).json()).filter(p => p.type === 'page')
const sockets = []
async function connect(page) {
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise(r => ws.addEventListener('open', r, { once: true }))
  sockets.push(ws)
  let id = 0
  const pending = new Map()
  ws.onmessage = event => { const m = JSON.parse(event.data); pending.get(m.id)?.(m); pending.delete(m.id) }
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const key = ++id
    const timer = setTimeout(() => reject(new Error(method + ' 超时')), 12000)
    pending.set(key, m => { clearTimeout(timer); m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result) })
    ws.send(JSON.stringify({ id: key, method, params }))
  })
  const evaluate = async expression => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
    return r.result.value
  }
  return { send, evaluate }
}
// 收集正文所有文本行盒（跳过列表符号与占位符）
const collectLines = `(() => {
  const lines = []
  const editor = document.querySelector('.ProseMirror')
  const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT)
  let node = null
  while ((node = walker.nextNode())) {
    const text = node.nodeValue || ''
    if (!text.trim()) continue
    const parent = node.parentElement
    if (!parent || parent.closest('.label-wrapper')) continue
    if (parent.classList.contains('milkdown-placeholder') || parent.closest('.milkdown-placeholder')) continue
    const range = document.createRange()
    range.selectNodeContents(node)
    for (const rect of range.getClientRects()) {
      if (rect.height > 0 && rect.width > 0) lines.push({ top: rect.top, bottom: rect.bottom, center: rect.top + rect.height / 2, text: text.slice(0, 12) })
    }
  }
  return lines
})()`
try {
  const root = await connect((await pages())[0])
  const directory = resolve('.runtime-user-data', `handle-fixtures-${Date.now()}`)
  await mkdir(directory, { recursive: true })
  const file = resolve(directory, '手柄对齐.md')
  const longParagraph = '这是一段很长的正文内容，用来验证换行后的多行段落。'.repeat(6)
  await writeFile(file, [
    '第一段正文内容', longParagraph, '第二段正文内容', '# 一级标题',
    '- 列表项内容', '- 较长的列表项内容，用于验证多行列表的首行对齐。', '结尾段落'
  ].join('\n\n') + '\n', 'utf8')
  const opened = await root.evaluate(`window.sheepText.openLocalFile(${JSON.stringify(file)})`)
  await wait(900)
  const page = (await pages()).find(p => p.url.includes(opened.windowId))
  const { send, evaluate } = await connect(page)
  await send('Page.bringToFront')
  const blocks = await evaluate(`[...document.querySelectorAll('.ProseMirror > p, .ProseMirror > h1, .ProseMirror > ul')].map(block => { const r = block.getBoundingClientRect(); return { tag: block.tagName, height: Math.round(r.height), x: Math.round(r.left + 60), y: Math.round(r.top + 12) } })`)
  const results = []
  for (const block of blocks) {
    // 悬停到块内首行位置，确保选中的是目标块本身
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: block.x, y: block.y, button: 'none', buttons: 0 })
    await wait(360)
    const measured = await evaluate(`(() => {
      const handle = document.querySelector('.milkdown-block-handle')
      if (!handle || handle.dataset.show !== 'true') return { shown: false }
      const h = handle.getBoundingClientRect()
      const center = h.top + h.height / 2
      const lines = ${collectLines}
      if (!lines.length) return { shown: true, noLines: true }
      let nearest = null
      for (const line of lines) {
        const distance = Math.abs(line.center - center)
        if (!nearest || distance < nearest.distance) nearest = { ...line, distance }
      }
      const editorRect = document.querySelector('.ProseMirror').getBoundingClientRect()
      const style = getComputedStyle(document.querySelector('.ProseMirror'))
      return {
        shown: true,
        handleCenter: +center.toFixed(1),
        nearestLineCenter: +nearest.center.toFixed(1),
        delta: +(center - nearest.center).toFixed(1),
        nearestText: nearest.text,
        gapToText: +(editorRect.left + (parseFloat(style.paddingLeft) || 0) - h.right).toFixed(1)
      }
    })()`)
    results.push({ tag: block.tag, blockHeight: block.height, ...measured })
  }
  const worst = Math.max(...results.filter(r => r.delta !== undefined && r.delta !== null).map(r => Math.abs(r.delta)))
  console.log(JSON.stringify({ results, worstDelta: worst }, null, 1))
} finally { sockets.forEach(ws => ws.close()) }