// 批次 A/B 回归：块操作图标居中、输入法提交后的撤销粒度（Markdown 与 TXT）。
// 每次都用 Ctrl+T 新建标签取得干净历史，避免上一轮编辑影响撤销步数统计。
// 用合成 compositionstart/compositionend 触发应用里的分段逻辑，文本用 Input.insertText 真实输入。
import { execFileSync } from 'node:child_process'
const port = process.env.SHEEPTEXT_CDP_PORT || '9346'
const wait = ms => new Promise(r => setTimeout(r, ms))
const pages = async () => (await (await fetch(`http://localhost:${port}/json/list`)).json()).filter(p => p.type === 'page')
const [page] = await pages()
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise(r => ws.addEventListener('open', r, { once: true }))
let id = 0
const pending = new Map()
ws.onmessage = e => { const m = JSON.parse(e.data); pending.get(m.id)?.(m); pending.delete(m.id) }
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const key = ++id
  const timer = setTimeout(() => reject(new Error(method + ' 超时')), 15000)
  pending.set(key, m => { clearTimeout(timer); m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result) })
  ws.send(JSON.stringify({ id: key, method, params }))
})
const evaluate = async expr => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
  return r.result.value
}
const key = async (modifiers, k, code, vk) => {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', modifiers, key: k, code, windowsVirtualKeyCode: vk })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers, key: k, code, windowsVirtualKeyCode: vk })
}
// 新建标签后切到指定模式，得到干净编辑器与干净历史
const freshTab = async (label) => {
  await focusWindow()
  await key(2, 't', 'KeyT', 84)
  await wait(1200)
  await evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()===${JSON.stringify(label)});if(b)b.click();return true})()`)
  await wait(1300)
  await evaluate(`(()=>{const el=document.querySelector('.ProseMirror')||document.querySelector('.cm-content');el.focus();return true})()`)
}
// 一次输入法提交：合成组合事件 + 真实插入文本
const compose = async (text) => {
  await evaluate(`(()=>{const el=document.querySelector('.ProseMirror')||document.querySelector('.cm-content');el.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));return true})()`)
  await send('Input.insertText', { text })
  await evaluate(`(()=>{const el=document.querySelector('.ProseMirror')||document.querySelector('.cm-content');el.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:${JSON.stringify(text)}}));return true})()`)
  await wait(220)
}
const editorText = () => evaluate(`(document.querySelector('.ProseMirror')||document.querySelector('.cm-content'))?.innerText?.trim() ?? null`)
const chunks = ['第一段中文', '继续输入', '再来几个', '收尾文字']
const results = {}
const problems = []
// 块操作手柄由鼠标移动驱动，需先把页面置于前台，否则收不到输入事件
const focusWindow = async () => {
  try { await send('Page.bringToFront') } catch { /* 忽略：失败时后续断言会报出 */ }
  try { execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'tests/runtime/show-window.ps1'], { stdio: 'ignore' }) } catch { /* 忽略 */ }
}

// ---------- U01：块操作图标在按钮内居中 ----------
await freshTab('Markdown')
await focusWindow()
await send('Input.insertText', { text: '图标居中测量' })
await wait(600)
const blockPoint = await evaluate(`(()=>{const p=document.querySelector('.ProseMirror p');const r=p.getBoundingClientRect();return {x:r.left+40,y:r.top+r.height/2}})()`)
// 先移到无关位置再移入：位置不变时 Chromium 不会派发新的 mousemove
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 300, button: 'none', buttons: 0 })
await wait(300)
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: blockPoint.x, y: blockPoint.y, button: 'none', buttons: 0 })
await wait(700)
results.handle = await evaluate(`(() => {
  const handle = document.querySelector('.milkdown-block-handle')
  if (!handle || handle.dataset.show !== 'true') return { shown: false }
  return { shown: true, items: [...handle.querySelectorAll('.operation-item')].map(item => {
    const box = item.getBoundingClientRect(), svg = item.querySelector('svg').getBoundingClientRect()
    return {
      dx: +((svg.x + svg.width / 2) - (box.x + box.width / 2)).toFixed(2),
      dy: +((svg.y + svg.height / 2) - (box.y + box.height / 2)).toFixed(2)
    }
  }) }
})()`)
if (!results.handle.shown || results.handle.items.some(it => Math.abs(it.dx) > 0.6 || Math.abs(it.dy) > 0.6)) {
  problems.push('块操作图标未在按钮内居中：' + JSON.stringify(results.handle))
}

// ---------- U02：一次输入法提交 = 一步撤销 ----------
for (const [mode, selector] of [['markdown', '.ProseMirror'], ['txt', '.cm-content']]) {
  await freshTab(mode === 'markdown' ? 'Markdown' : 'TXT')
  for (const chunk of chunks) await compose(chunk)
  const typed = await editorText()
  const steps = []
  for (let i = 0; i < chunks.length + 1; i += 1) {
    await key(2, 'z', 'KeyZ', 90)
    await wait(650)
    steps.push(await editorText())
  }
  results[mode] = { typed, steps }
  // 关闭本段自建的标签，避免标签持续堆积
  await key(2, 'w', 'KeyW', 87)
  await wait(900)
  // 期望：逐段回退，最后清空；绝不能一次撤销就清空整段
  const emptied = steps[chunks.length - 1] === '' || steps[chunks.length - 1] === '在这里输入、粘贴和整理文字……'
  if (!emptied) problems.push(`${mode} 撤销未能逐段回退到空：${JSON.stringify(steps)}`)
  for (let i = 0; i < chunks.length; i += 1) {
    const expected = chunks.slice(0, chunks.length - 1 - i).join('')
    const actual = steps[i] ?? ''
    const normalized = actual === '在这里输入、粘贴和整理文字……' ? '' : actual
    if (normalized !== expected) problems.push(`${mode} 第 ${i + 1} 次撤销结果不符：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
  }
}
console.log(JSON.stringify({ passed: problems.length === 0, problems, ...results }, null, 1))
ws.close()