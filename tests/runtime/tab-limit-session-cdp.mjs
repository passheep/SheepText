// 批次 C 验证：U05 标签上限 8 个转新窗口、U06 会话恢复、U07 拖入文件作为新标签。
// 只创建测试用的临时文件，不删除任何文件。
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
const port = process.env.SHEEPTEXT_CDP_PORT || '9348'
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
  return { send, evaluate, key }
}
const tabTitles = `[...document.querySelectorAll('.editor-tab')].map(t => t.querySelector('.tab-title')?.textContent?.trim())`
const focusWindow = () => { try { execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'tests/runtime/show-window.ps1'], { stdio: 'ignore' }) } catch { /* 忽略 */ } }
const problems = []
try {
  const root = await connect((await pages())[0])
  await root.send('Page.bringToFront')
  focusWindow()
  await wait(400)
  const startTabs = await root.evaluate(tabTitles)

  // ---------- U07：拖入文件优先作为新标签（走真实拖放事件，覆盖渲染层同步逻辑） ----------
  const directory = resolve('.runtime-user-data', `drop-tab-${Date.now()}`)
  await mkdir(directory, { recursive: true })
  const dropFile = resolve(directory, '拖入标签.md')
  await writeFile(dropFile, '# 拖入标签测试\n\n正文\n', 'utf8')
  const dropPoint = await root.evaluate(`(() => { const r = document.querySelector('.cm-content, .ProseMirror').getBoundingClientRect(); return { x: r.x + 40, y: r.y + 30 } })()`)
  const beforeDrop = await root.evaluate(tabTitles)
  const dropData = { items: [], files: [dropFile], dragOperationsMask: 1 }
  await root.send('Input.dispatchDragEvent', { type: 'dragEnter', ...dropPoint, data: dropData })
  await root.send('Input.dispatchDragEvent', { type: 'dragOver', ...dropPoint, data: dropData })
  await wait(150)
  await root.send('Input.dispatchDragEvent', { type: 'drop', ...dropPoint, data: dropData })
  await wait(1600)
  const afterDrop = await root.evaluate(tabTitles)
  if (!afterDrop.includes('拖入标签.md')) problems.push('拖入文件的标签未出现：' + JSON.stringify(afterDrop))
  if (afterDrop.length !== beforeDrop.length + 1) problems.push(`拖入后标签数应 +1：${beforeDrop.length} → ${afterDrop.length}`)
  if ((await pages()).length !== 1) problems.push('未达上限时拖入文件不应新开窗口')

  // ---------- U05：连按 Ctrl+T 直到超过上限 ----------
  const windowCountBefore = (await pages()).length
  for (let i = 0; i < 14; i += 1) {
    await root.key(2, 't', 'KeyT', 84)
    await wait(850)
  }
  const afterNew = await root.evaluate(tabTitles)
  const windowCountAfter = (await pages()).length
  if (afterNew.length !== 8) problems.push(`标签上限应为 8，实际 ${afterNew.length}`)
  if (windowCountAfter <= windowCountBefore) problems.push(`超出上限后未开新窗口：${windowCountBefore} → ${windowCountAfter}`)
  // 已满时拖入文件应改开新窗口
  const dropFile2 = resolve(directory, '满额拖入.md')
  await writeFile(dropFile2, '# 满额拖入\n', 'utf8')
  const windowsBeforeFullDrop = (await pages()).length
  const fullData = { items: [], files: [dropFile2], dragOperationsMask: 1 }
  await root.send('Input.dispatchDragEvent', { type: 'dragEnter', ...dropPoint, data: fullData })
  await root.send('Input.dispatchDragEvent', { type: 'dragOver', ...dropPoint, data: fullData })
  await wait(150)
  await root.send('Input.dispatchDragEvent', { type: 'drop', ...dropPoint, data: fullData })
  await wait(1800)
  const afterFullDrop = await root.evaluate(tabTitles)
  if (afterFullDrop.length !== 8) problems.push(`满额拖入不应改变当前窗口标签数：${afterFullDrop.length}`)
  if ((await pages()).length <= windowsBeforeFullDrop) problems.push('标签已满时拖入文件应开新窗口')

  // ---------- U06：关闭最后一个窗口后仍可恢复会话 ----------
  // 记录当前会话（标签数、窗口数），随后由外部脚本重启实例核对
  const summary = {
    windowCount: windowCountAfter,
    tabs: afterFullDrop,
    activeTitle: await root.evaluate(`document.querySelector('.editor-tab.is-active .tab-title')?.textContent?.trim()`)
  }
  console.log(JSON.stringify({ passed: problems.length === 0, problems, startTabs, afterDrop, afterNew, afterFullDrop, summary }, null, 1))
  assert.equal(problems.length, 0, problems.join('；'))
} finally { sockets.forEach(ws => ws.close()) }