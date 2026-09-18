import { execFileSync } from 'node:child_process'
// 量取块操作手柄与所在文本行的对齐情况：直接找与手柄中心最近的文本行，不依赖块结构。
// 只创建测试文件，不删除文件。
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
const port = process.env.SHEEPTEXT_CDP_PORT || '9338'
// 手柄按需求整体向右下微调了 1.5px，因此期望中心比首行中心低 1.5px
const HANDLE_NUDGE_EXPECTED = 1.5
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
  // U07 起本地文件优先作为当前窗口的新标签，因此用真实拖放事件打开，
  // 才能让渲染层同步标签栏并切到该文稿（直调 openLocalFile 不会更新界面）。
  const dropPoint = await root.evaluate(`(() => { const r = document.querySelector('.cm-content, .ProseMirror').getBoundingClientRect(); return { x: r.x + 40, y: r.y + 30 } })()`)
  const dropData = { items: [], files: [file], dragOperationsMask: 1 }
  await root.send('Input.dispatchDragEvent', { type: 'dragEnter', ...dropPoint, data: dropData })
  await root.send('Input.dispatchDragEvent', { type: 'dragOver', ...dropPoint, data: dropData })
  await wait(150)
  await root.send('Input.dispatchDragEvent', { type: 'drop', ...dropPoint, data: dropData })
  await wait(1800)
  const page = (await pages())[0]
  const { send, evaluate } = await connect(page)
  await send('Page.bringToFront')
  // 手柄由鼠标移动驱动，需先把窗口置于前台，否则收不到输入事件
  try { execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'tests/runtime/show-window.ps1'], { stdio: 'ignore' }) } catch { /* 忽略 */ }
  await wait(500)
  const blocks = await evaluate(`[...document.querySelectorAll('.ProseMirror > p, .ProseMirror > h1, .ProseMirror > ul')].map(block => { const r = block.getBoundingClientRect(); return { tag: block.tagName, height: Math.round(r.height), x: Math.round(r.left + 60), y: Math.round(r.top + 12) } })`)
  const results = []
  // 先移到无关位置再移入：位置不变时 Chromium 不会派发新的 mousemove
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5, button: 'none', buttons: 0 })
  await wait(700)
  for (const block of blocks) {
    // 悬停到块内首行位置，确保选中的是目标块本身
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: block.x, y: block.y, button: 'none', buttons: 0 })
    await wait(450)
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
  // 期望：手柄中心比首行中心低 HANDLE_NUDGE_EXPECTED（视觉微调），偏差控制在 0.6px 内
  const deviations = results.filter(r => r.delta !== undefined && r.delta !== null).map(r => Math.abs(r.delta - HANDLE_NUDGE_EXPECTED))
  const worst = Math.max(...deviations)
  const gaps = results.filter(r => r.gapToText !== undefined).map(r => r.gapToText)
  const passed = results.length > 0 && worst <= 0.6
  console.log(JSON.stringify({ passed, expectedDelta: HANDLE_NUDGE_EXPECTED, worstDelta: worst, gapsToText: gaps, results }, null, 1))
  if (!passed) process.exitCode = 1
} finally { sockets.forEach(ws => ws.close()) }