// 批次 D 验证：U08 跨窗口移动标签（按位置插入 / 追加末尾 / 目标满额拒绝 / 源窗口被掏空则关闭）
// 与 U09 拖出成新窗口。
// 跨窗口 OS 拖放无法用 CDP 复现，这里直接驱动真实 IPC（beginTabDrag / dropTab / detachTab），
// 覆盖主进程转移链路；真实拖拽手感需用户实机确认。
// 只创建测试用临时文件，不删除任何文件。
import assert from 'node:assert/strict'
const port = process.env.SHEEPTEXT_CDP_PORT || '9351'
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
    const timer = setTimeout(() => reject(new Error(method + ' 超时')), 15000)
    pending.set(key, m => { clearTimeout(timer); m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result) })
    ws.send(JSON.stringify({ id: key, method, params }))
  })
  const evaluate = async expression => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
    return r.result.value
  }
  const key = async (modifiers, k, code, vk) => {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', modifiers, key: k, code, windowsVirtualKeyCode: vk })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers, key: k, code, windowsVirtualKeyCode: vk })
  }
  const bootstrap = () => evaluate(`window.sheepText.bootstrap(new URLSearchParams(location.search).get('windowId') || '')`)
  const tabTitles = () => evaluate(`[...document.querySelectorAll('.editor-tab')].map(t => t.querySelector('.tab-title')?.textContent?.trim())`)
  const draftIds = async () => (await bootstrap()).tabs.map(tab => tab.draftId)
  const focusEditor = () => evaluate(`(()=>{const el=document.querySelector('.cm-content, .ProseMirror');el.focus();return true})()`)
  return { send, evaluate, key, bootstrap, tabTitles, draftIds, focusEditor }
}

// 在目标窗口派发合成 drop 事件，走应用真实的跨窗口落点处理（不直接调 IPC）
const syntheticDrop = (client, selector, half) => client.evaluate(`(() => {
  const target = document.querySelector(${JSON.stringify(selector)})
  if (!target) return 'no-target'
  const rect = target.getBoundingClientRect()
  const dt = new DataTransfer()
  dt.setData('application/x-sheeptext-tab', 'cross')
  const x = ${half === 'left' ? 'rect.left + 2' : 'rect.left + rect.width - 2'}
  const event = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: rect.top + rect.height / 2 })
  target.dispatchEvent(event)
  return 'dispatched'
})()`)

const problems = []
try {
  // 甲窗口：3 个可辨识标签
  const first = await connect((await pages())[0])
  await first.send('Page.bringToFront')
  await first.focusEditor()
  await first.send('Input.insertText', { text: '甲窗口一' })
  await wait(800)
  for (const text of ['甲窗口二', '甲窗口三']) {
    await first.key(2, 't', 'KeyT', 84)
    await wait(900)
    await first.focusEditor()
    await first.send('Input.insertText', { text })
    await wait(800)
  }
  // 乙窗口：另开一个窗口，2 个标签
  const firstId = (await first.bootstrap()).windowId
  const pagesBefore = (await pages()).length
  await first.evaluate(`window.sheepText.newWindow()`)
  // 轮询直到出现另一个窗口，并按 windowId 定位（页面顺序不可靠）
  let second = null
  let secondUrl = ''
  for (let i = 0; i < 30 && !second; i += 1) {
    await wait(500)
    const list = await pages()
    if (list.length <= pagesBefore) continue
    for (const candidate of list) {
      const client = await connect(candidate)
      const id = (await client.bootstrap()).windowId
      if (id !== firstId) { second = client; secondUrl = candidate.url; break }
    }
  }
  if (!second) throw new Error('未能创建第二个窗口')
  await second.send('Page.bringToFront')
  await second.focusEditor()
  await second.send('Input.insertText', { text: '乙窗口一' })
  await wait(800)
  await second.key(2, 't', 'KeyT', 84)
  await wait(900)
  await second.focusEditor()
  await second.send('Input.insertText', { text: '乙窗口二' })
  await wait(800)

  const secondId = (await second.bootstrap()).windowId
  const firstTabs = await first.tabTitles()
  const secondTabs = await second.tabTitles()

  // ---------- 按位置插入：甲窗口第 2 个标签插到乙窗口首位 ----------
  const movingId = (await first.draftIds())[1]
  const movingTitle = firstTabs[1]
  await first.evaluate(`window.sheepText.beginTabDrag(${JSON.stringify(firstId)}, ${JSON.stringify(movingId)})`)
  const dispatched = await syntheticDrop(second, '.editor-tab', 'left')
  await wait(1400)
  const secondAfter = await second.tabTitles()
  const firstAfter = await first.tabTitles()
  if (dispatched !== 'dispatched') problems.push('未能派发落点事件：' + dispatched)
  if (secondAfter[0] !== movingTitle) problems.push(`未按位置插入首位：期望 ${movingTitle}，实际 ${JSON.stringify(secondAfter)}`)
  if (firstAfter.includes(movingTitle)) problems.push('来源窗口仍保留被移走的标签')

  // ---------- 追加到末尾（拖到正文区域） ----------
  const appendTitle = firstAfter[0]
  const appendId = (await first.draftIds())[0]
  await first.evaluate(`window.sheepText.beginTabDrag(${JSON.stringify(firstId)}, ${JSON.stringify(appendId)})`)
  const appendDispatched = await syntheticDrop(second, '.workspace', 'right')
  await wait(1400)
  const secondAppended = await second.tabTitles()
  if (appendDispatched !== 'dispatched') problems.push('未能派发正文区落点事件：' + appendDispatched)
  if (secondAppended[secondAppended.length - 1] !== appendTitle) problems.push(`未追加到末尾：${JSON.stringify(secondAppended)}`)

  // ---------- 源窗口被掏空后关闭 ----------
  const windowsBefore = (await pages()).length
  const lastId = (await first.draftIds())[0]
  const lastTitle = (await first.tabTitles())[0]
  await first.evaluate(`window.sheepText.beginTabDrag(${JSON.stringify(firstId)}, ${JSON.stringify(lastId)})`)
  await syntheticDrop(second, '.workspace', 'right')
  await wait(2200)
  const windowsAfter = (await pages()).length
  if (windowsAfter >= windowsBefore) problems.push(`来源窗口被掏空后未关闭：${windowsBefore} → ${windowsAfter}`)

  // ---------- U09：拖出成新窗口 ----------
  const detachTitle = (await second.tabTitles())[0]
  const detachId = (await second.draftIds())[0]
  const beforeDetach = (await pages()).length
  await second.evaluate(`window.sheepText.beginTabDrag(${JSON.stringify(secondId)}, ${JSON.stringify(detachId)})`)
  const detached = await second.evaluate(`window.sheepText.detachTab(${JSON.stringify(secondId)})`)
  await wait(3000)
  const afterDetach = (await pages()).length
  const secondAfterDetach = await second.tabTitles()
  if (!detached.detached) problems.push('拖出成新窗口未被接受')
  if (afterDetach <= beforeDetach) problems.push(`拖出后未新增窗口：${beforeDetach} → ${afterDetach}`)
  if (secondAfterDetach.includes(detachTitle)) problems.push('拖出后来源窗口仍保留该标签')

  // ---------- 目标窗口满额拒绝 ----------
  for (let i = 0; i < 9; i += 1) { await second.key(2, 't', 'KeyT', 84); await wait(800) }
  const fullTabs = await second.tabTitles()
  if (fullTabs.length !== 8) problems.push(`目标窗口应停在 8 个标签，实际 ${fullTabs.length}`)
  const otherPage = (await pages()).find((p) => p.url !== secondUrl)
  const other = await connect(otherPage)
  const otherId = (await other.bootstrap()).windowId
  const otherDraftId = (await other.draftIds())[0]
  await other.evaluate(`window.sheepText.beginTabDrag(${JSON.stringify(otherId)}, ${JSON.stringify(otherDraftId)})`)
  const rejected = await second.evaluate(`window.sheepText.dropTab(${JSON.stringify(secondId)}, 0)`)
  const afterReject = await second.tabTitles()
  if (rejected.moved) problems.push('目标窗口已满时仍接受了标签')
  if (afterReject.length !== 8) problems.push(`拒绝后目标窗口标签数变化：${afterReject.length}`)

  console.log(JSON.stringify({
    passed: problems.length === 0, problems,
    firstTabs, secondTabs, secondAfter, secondAppended, lastTitle,
    windowsBefore, windowsAfter, beforeDetach, afterDetach, fullTabs
  }, null, 1))
  assert.equal(problems.length, 0, problems.join('；'))
} finally { sockets.forEach(ws => ws.close()) }