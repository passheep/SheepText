// 使用隔离 Electron 实例验证五项界面反馈；只创建测试文件，不删除文件。
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
const port = process.env.SHEEPTEXT_CDP_PORT || '9336'
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
try {
  const root = await connect((await pages())[0])
  const directory = resolve('.runtime-user-data', `ui-fixtures-${Date.now()}`)
  await mkdir(directory, { recursive: true })
  const file = resolve(directory, '界面验收.md')
  await writeFile(file, '# 首标题\n\n1. 序号第一行\n2. 序号第二行\n\n- 圆点第一行\n\n' + Array.from({ length: 40 }, (_, i) => `## 标题${i}\n\n正文${i}\n\n`).join(''))
  const opened = await root.evaluate(`window.sheepText.openLocalFile(${JSON.stringify(file)})`)
  await wait(900)
  const page = (await pages()).find(p => p.url.includes(opened.windowId))
  const { send, evaluate } = await connect(page)
  await send('Page.bringToFront')
  assert.equal(await evaluate(`Boolean(document.querySelector('.floating-command-right'))`), false, '未设默认模型时场景区也隐藏')
  const before = await evaluate(`(()=>{const b=document.querySelector('.milkdown-outline-trigger');const r=b.getBoundingClientRect();b.click();document.querySelector('.milkdown-outline').dispatchEvent(new MouseEvent('mouseleave'));document.querySelector('.milkdown-editor-shell').scrollTop=900;return {top:r.top,right:r.right}})()`)
  await wait(400)
  const after = await evaluate(`(()=>{const b=document.querySelector('.milkdown-outline-trigger'),r=b.getBoundingClientRect();return {top:r.top,right:r.right,panel:!!document.querySelector('.milkdown-outline-panel'),pinned:b.getAttribute('aria-pressed')}})()`)
  assert.equal(after.panel, true); assert.equal(after.pinned, 'true')
  assert.equal(after.top, before.top); assert.equal(after.right, before.right)
  await evaluate(`document.querySelector('.milkdown-outline-trigger').click();document.querySelector('.milkdown-editor-shell').scrollTop=0;window.dispatchEvent(new KeyboardEvent('keydown',{key:'f',ctrlKey:true,bubbles:true,cancelable:true}));true`)
  await wait(200)
  await evaluate(`document.querySelector('.sheep-find-expand').click();true`)
  await wait(150)
  const widths = []
  for (const width of [860, 520]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 720, deviceScaleFactor: 1, mobile: false })
    await wait(200)
    const metrics = await evaluate(`(()=>{const w=document.querySelector('.milkdown-find-widget'),a=w.querySelector('.sheep-find-field input').getBoundingClientRect(),b=w.querySelector('.sheep-find-replace-row input').getBoundingClientRect();return {find:a.width,replace:b.width,buttonsInside:[...w.querySelectorAll('.sheep-find-replace-row button')].every(x=>x.getBoundingClientRect().right<=w.getBoundingClientRect().right)}})()`)
    assert.ok(Math.abs(metrics.find - metrics.replace) <= 1, JSON.stringify(metrics))
    assert.equal(metrics.buttonsInside, true)
    widths.push({ width, ...metrics })
  }
  const lists = await evaluate(`(()=>{return [...document.querySelectorAll('.milkdown-list-item-block li')].slice(0,3).map(li=>{const label=li.querySelector('.label-wrapper'),p=li.querySelector('.children p'),style=getComputedStyle(label.querySelector('.label'));return {labelHeight:label.getBoundingClientRect().height,textHeight:p.getBoundingClientRect().height,labelFont:style.fontSize,textFont:getComputedStyle(p).fontSize}})})() `)
  for (const item of lists) { assert.equal(item.labelFont, item.textFont); assert.ok(Math.abs(item.labelHeight - item.textHeight) < 1, JSON.stringify(item)) }
  console.log(JSON.stringify({ passed: true, sceneHidden: true, outlinePinnedAndStationary: true, widths, lists }, null, 2))
} finally { sockets.forEach(ws => ws.close()) }
