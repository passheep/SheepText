// 行内补全端到端验证：走真实键盘事件 → 渲染进程插件 → IPC → 主进程 FIM → 模拟服务。
// 用法：先启动 Electron（带 --remote-debugging-port），再运行本脚本。
import { DatabaseSync } from 'node:sqlite'
import { startMockFimServer } from './completion-mock-server.mjs'

const port = process.env.SHEEPTEXT_CDP_PORT || '9411'
const mockPort = Number(process.env.SHEEPTEXT_MOCK_PORT || 9410)
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const problems = []
const received = []
// 数据库路径：用于验证灰字期间没有触发自动保存（灰字绝不能进文档模型）
const dbPath = process.env.SHEEPTEXT_DB_PATH || ''
/** 读最近更新的文稿内容（测试用隔离实例，只有当前这一篇）。 */
const readDbDraftContent = () => {
  if (!dbPath) return null
  const db = new DatabaseSync(dbPath)
  try {
    const row = db.prepare('SELECT content FROM drafts ORDER BY updated_at DESC LIMIT 1').get()
    return row ? String(row.content) : null
  } finally {
    db.close()
  }
}

const mock = await startMockFimServer((info) => received.push(info))

const list = await (await fetch(`http://localhost:${port}/json/list`)).json()
const page = list.find((item) => item.type === 'page')
if (!page) throw new Error('未找到 Electron 页面，请确认已带 --remote-debugging-port 启动')
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r) => ws.addEventListener('open', r, { once: true }))
let id = 0
const pending = new Map()
ws.onmessage = (event) => {
  const message = JSON.parse(event.data)
  const cb = pending.get(message.id)
  if (cb) { pending.clear(); cb(message) }
}
const send = (method, params = {}) => new Promise((res, rej) => {
  const key = ++id
  const timer = setTimeout(() => rej(new Error(method + ' 超时')), 30000)
  pending.set(key, (message) => {
    clearTimeout(timer)
    message.error ? rej(new Error(JSON.stringify(message.error))) : res(message.result)
  })
  ws.send(JSON.stringify({ id: key, method, params }))
})
const evaluate = async (expression) => {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
  return result.result.value
}
// 真实按键：modifiers 1=Alt 2=Ctrl
const pressKey = async (key, code, vk, modifiers = 0) => {
  for (const type of ['rawKeyDown', 'keyUp']) {
    await send('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers })
  }
}
const typeText = async (text) => {
  for (const ch of text) {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, unmodifiedText: ch, key: ch })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch })
  }
}
// 生产构建下拿不到 Vue setupState，只能读 DOM
const readState = `(() => {
  const ghost = document.querySelector('.sheep-completion-ghost')
  const editor = document.querySelector('.milkdown-editor-shell .ProseMirror')
  return {
    ghost: ghost ? ghost.textContent : null,
    ghostCount: document.querySelectorAll('.sheep-completion-ghost').length,
    content: editor ? editor.textContent : null,
    dirty: Boolean(document.querySelector('.editor-tab .tab-dirty, .tab-unsaved, .tab-dot'))
  }
})()`

try {
  await send('Page.bringToFront')
  await send('Emulation.setDeviceMetricsOverride', { width: 1000, height: 720, deviceScaleFactor: 1, mobile: false })
  await wait(1500)

  // 准备：先开一个全新标签页，保证编辑区是空的（脚本可重复运行）
  await pressKey('t', 'KeyT', 84, 2)
  await wait(2000)
  // 切到 Markdown，写一段前置文字，把光标放到句末
  await evaluate(`(() => {
    const markdown = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Markdown')
    if (markdown) markdown.click()
    return Boolean(markdown)
  })()`)
  await wait(2200)
  const editorRect = await evaluate(`(() => {
    const el = document.querySelector('.milkdown-editor-shell .ProseMirror')
    if (!el) return null
    el.focus()
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.x + 40), y: Math.round(r.y + 30) }
  })()`)
  if (!editorRect) throw new Error('未进入 Markdown 编辑区')
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: editorRect.x, y: editorRect.y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: editorRect.x, y: editorRect.y, button: 'left', clickCount: 1 })
  await wait(400)
  await typeText('今天天气不错，我打算')
  await wait(700)

  const before = await evaluate(readState)
  if (!before.content?.includes('今天天气不错')) problems.push(`前置文字未写入：${before.content}`)

  // ① 触发补全：Alt+→
  await pressKey('ArrowRight', 'ArrowRight', 39, 1)
  await wait(2500)
  const triggered = await evaluate(readState)
  if (triggered.ghostCount === 0) problems.push(`Alt+→ 未出现灰字（当前内容：${triggered.content}）`)
  else if (triggered.ghost !== '这是模型续写出来的一句话。') problems.push(`灰字内容不符：${triggered.ghost}`)
  // 灰字渲染在 ProseMirror DOM 内，textContent 必然包含它；
  // 要证明「没进文档模型」得看两处：数据库没被自动保存写入，以及清除后正文里没有它。
  await wait(3500)
  const dbContent = readDbDraftContent()
  if (dbContent && dbContent.includes('这是模型续写出来的一句话')) {
    problems.push('灰字进入了文档模型并触发了自动保存（数据库里出现了补全文本）')
  }
  console.log('数据库中的文稿内容：', dbContent)
  if (received.length === 0) problems.push('模拟 FIM 服务没有收到请求')
  else {
    const last = received[received.length - 1]
    if (!last.path.includes('/completions')) problems.push(`请求路径不是补全端点：${last.path}`)
    if (!String(last.body.prompt ?? '').includes('今天天气不错')) problems.push('prompt 未包含光标前文本')
    if (last.body.suffix === undefined) problems.push('请求缺少 suffix 字段')
    if (last.body.stream !== false) problems.push('请求未显式关闭流式')
  }

  // ② 接受补全：→
  await pressKey('ArrowRight', 'ArrowRight', 39, 0)
  await wait(900)
  const accepted = await evaluate(readState)
  if (accepted.ghostCount !== 0) problems.push('接受后灰字未消失')
  if (!accepted.content?.includes('这是模型续写出来的一句话。')) problems.push(`接受后正文未插入补全文本：${accepted.content}`)
  // 阳性对照：接受是真实内容变更，应当被自动保存写进数据库；
  // 若这一步没写进去，上面「灰字未入库」的结论就不成立。
  await wait(3500)
  const dbAfterAccept = readDbDraftContent()
  console.log('接受并自动保存后的数据库内容：', dbAfterAccept)
  if (!dbAfterAccept?.includes('这是模型续写出来的一句话')) {
    problems.push('阳性对照失败：接受补全后数据库未写入（无法据此判断灰字是否入库）')
  }

  // ③ 撤销：补全作为一次普通事务，应可被 Ctrl+Z 撤销
  await pressKey('z', 'KeyZ', 90, 2)
  await wait(900)
  const undone = await evaluate(readState)
  if (undone.content?.includes('这是模型续写出来的一句话。')) problems.push('Ctrl+Z 未能撤销补全插入')

  // ④ 其它按键清除灰字
  await pressKey('ArrowRight', 'ArrowRight', 39, 1)
  await wait(2500)
  const again = await evaluate(readState)
  if (again.ghostCount === 0) problems.push('第二次 Alt+→ 未出现灰字')
  await typeText('继')
  await wait(900)
  const typed = await evaluate(readState)
  if (typed.ghostCount !== 0) problems.push('输入其它字符后灰字未清除')
  if (!typed.content?.includes('继')) problems.push('输入的字符没有正常写入')

  // ⑤ Esc 清除灰字
  await pressKey('ArrowRight', 'ArrowRight', 39, 1)
  await wait(2500)
  const third = await evaluate(readState)
  if (third.ghostCount === 0) problems.push('第三次 Alt+→ 未出现灰字')
  await pressKey('Escape', 'Escape', 27, 0)
  await wait(800)
  const escaped = await evaluate(readState)
  if (escaped.ghostCount !== 0) problems.push('Esc 未清除灰字')
  if (escaped.content?.includes('这是模型续写出来的一句话。')) problems.push('Esc 清除后正文里仍残留补全文本（说明灰字进了文档模型）')

  // ⑥ 打开查找浮层应清除灰字（F10）
  await pressKey('ArrowRight', 'ArrowRight', 39, 1)
  await wait(2500)
  const fourth = await evaluate(readState)
  if (fourth.ghostCount === 0) problems.push('第四次 Alt+→ 未出现灰字')
  await pressKey('f', 'KeyF', 70, 2)
  await wait(1200)
  const searched = await evaluate(readState)
  if (searched.ghostCount !== 0) problems.push('打开查找浮层后灰字未清除')
  await pressKey('Escape', 'Escape', 27, 0)
  await wait(600)

  console.log('模拟服务收到的补全请求数：', received.length)
  console.log('请求体样例：', JSON.stringify({
    path: received[0]?.path,
    model: received[0]?.body?.model,
    prompt: String(received[0]?.body?.prompt ?? '').slice(-20),
    suffix: received[0]?.body?.suffix,
    max_tokens: received[0]?.body?.max_tokens
  }))
  console.log('灰字内容：', triggered.ghost)
  console.log('接受后正文：', accepted.content)
  console.log('problems =', JSON.stringify(problems))
  console.log('passed =', problems.length === 0)
} finally {
  mock.close()
  await send('Emulation.clearDeviceMetricsOverride').catch(() => {})
  ws.close()
}