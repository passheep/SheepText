// 多标签标题栏运行时验证：新建、切换、关闭、拖动排序与快捷键。只创建测试文件，不删除文件。
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
const port = process.env.SHEEPTEXT_CDP_PORT || '9340'
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
// 读取标签栏状态：标题、活动项、未保存圆点
const readTabs = `(() => {
  const tabs = [...document.querySelectorAll('.editor-tab')]
  return {
    count: tabs.length,
    titles: tabs.map(t => t.querySelector('.tab-title')?.textContent?.trim()),
    activeIndex: tabs.findIndex(t => t.classList.contains('is-active')),
    dirty: tabs.filter(t => t.classList.contains('is-dirty')).length
  }
})()`
try {
  const root = await connect((await pages())[0])
  const directory = resolve('.runtime-user-data', `tabs-fixtures-${Date.now()}`)
  await mkdir(directory, { recursive: true })
  const file = resolve(directory, '标签测试.md')
  await writeFile(file, '# 标签测试文档\n\n正文内容\n', 'utf8')
  // U07 起本地文件作为当前窗口的新标签：用真实拖放事件打开，渲染层才会同步标签栏。
  const dropPoint = await root.evaluate(`(() => { const r = document.querySelector('.cm-content, .ProseMirror').getBoundingClientRect(); return { x: r.x + 40, y: r.y + 30 } })()`)
  const dropData = { items: [], files: [file], dragOperationsMask: 1 }
  await root.send('Input.dispatchDragEvent', { type: 'dragEnter', ...dropPoint, data: dropData })
  await root.send('Input.dispatchDragEvent', { type: 'dragOver', ...dropPoint, data: dropData })
  await wait(150)
  await root.send('Input.dispatchDragEvent', { type: 'drop', ...dropPoint, data: dropData })
  await wait(2000)
  const page = (await pages())[0]
  const { send, evaluate } = await connect(page)
  await send('Page.bringToFront')
  await wait(400)
  // 打开文件后应作为标签出现在标题栏
  const initial = await evaluate(readTabs)
  assert.ok(initial.count >= 1, '标题栏存在标签')
  assert.ok(initial.titles.includes('标签测试.md'), '文件名标签可见: ' + JSON.stringify(initial.titles))
  // Ctrl+T 新建标签
  await send('Input.dispatchKeyEvent', { type: 'keyDown', modifiers: 2, key: 't', code: 'KeyT', windowsVirtualKeyCode: 84 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 2, key: 't', code: 'KeyT', windowsVirtualKeyCode: 84 })
  await wait(900)
  const afterNew = await evaluate(readTabs)
  assert.equal(afterNew.count, initial.count + 1, 'Ctrl+T 新建标签')
  assert.equal(afterNew.activeIndex, afterNew.count - 1, '新建标签后成为活动标签')
  // 编辑内容后，标签标题应随正文首行更新（U04 已移除未保存圆点，改为验证标题同步）
  await evaluate(`(()=>{const target=document.querySelector('.cm-content')||document.querySelector('.ProseMirror');target.focus();document.execCommand('insertText',false,'新标签内容');return true})()`)
  await wait(500)
  const editedState = await evaluate(readTabs)
  assert.equal(editedState.titles[editedState.activeIndex], '新标签内容', '标签标题随正文更新')
  // 点击第一个标签切回文件文稿
  await evaluate(`document.querySelectorAll('.editor-tab')[0].click(); true`)
  await wait(900)
  const afterSwitch = await evaluate(readTabs)
  assert.equal(afterSwitch.activeIndex, 0, '点击切换标签')
  // Ctrl+Tab 循环到下一个标签
  await send('Input.dispatchKeyEvent', { type: 'keyDown', modifiers: 2, key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 2, key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
  await wait(800)
  const afterCycle = await evaluate(readTabs)
  assert.notEqual(afterCycle.activeIndex, 0, 'Ctrl+Tab 切到下一个标签')
  // 拖动排序：把最后一项拖到最前
  const beforeDrag = await evaluate(readTabs)
  const order = await evaluate(`(() => {
    const tabs = [...document.querySelectorAll('.editor-tab')]
    const from = tabs[tabs.length - 1]
    const to = tabs[0]
    const dt = new DataTransfer()
    from.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }))
    const r = to.getBoundingClientRect()
    to.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + 2, clientY: r.top + r.height / 2 }))
    to.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }))
    from.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }))
    return true
  })()`)
  assert.equal(order, true)
  await wait(700)
  const afterReorder = await evaluate(readTabs)
  assert.equal(afterReorder.titles[0], beforeDrag.titles[beforeDrag.count - 1], '拖动后顺序变化: ' + JSON.stringify(afterReorder.titles))
  assert.equal(afterReorder.titles[1], beforeDrag.titles[0], '其余标签依次后移')
  // 中键关闭最后一个标签
  const closed = await evaluate(`(() => {
    const tabs = [...document.querySelectorAll('.editor-tab')]
    const target = tabs[tabs.length - 1]
    const before = tabs.length
    target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 1 }))
    return before
  })()`)
  await wait(900)
  const afterClose = await evaluate(readTabs)
  assert.equal(afterClose.count, closed - 1, '中键关闭标签')
  console.log(JSON.stringify({ passed: true, initial: initial.titles, afterNew: afterNew.titles, afterReorder: afterReorder.titles, afterClose: afterClose.titles, titleFollowsContent: true, cycle: true }, null, 1))
} finally { sockets.forEach(ws => ws.close()) }