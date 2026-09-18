// 本地文件收尾回归：隔离实例内验证外部冲突、内存正文、编码提示与标题。
// 仅创建/读写本脚本新建的测试文件，不删除任何文件。
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const port = process.env.SHEEPTEXT_CDP_PORT || '9335'
const wait = ms => new Promise(r => setTimeout(r, ms))
const pages = async () => (await (await fetch(`http://localhost:${port}/json/list`)).json()).filter(p => p.type === 'page')
const directory = resolve('.runtime-user-data', `conflict-fixtures-${Date.now()}`)
await mkdir(directory, { recursive: true })
const file = resolve(directory, '中文冲突测试.txt')
const gbkFile = resolve(directory, '编码转换.txt')
await writeFile(file, '最初的磁盘内容', 'utf8')
await writeFile(gbkFile, Buffer.from([0xc4, 0xe3, 0xba, 0xc3]))
const connections = []
async function connect(page) {
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise(r => ws.addEventListener('open', r, { once: true }))
  connections.push(ws)
  let id = 0
  const pending = new Map()
  ws.addEventListener('message', event => {
    const message = JSON.parse(event.data)
    const callback = pending.get(message.id)
    if (callback) { pending.delete(message.id); callback(message) }
  })
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const requestId = ++id
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`${method} 超时`)) }, 15000)
    pending.set(requestId, message => { clearTimeout(timer); message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result) })
    ws.send(JSON.stringify({ id: requestId, method, params }))
  })
  return {
    send,
    evaluate: async expression => {
      const response = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
      if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text)
      return response.result.value
    }
  }
}
const boot = `window.sheepText.bootstrap(new URLSearchParams(location.search).get('windowId'))`
// 通过编辑器 DOM 输入与页面按钮操作，不依赖生产构建移除的 Vue setupState。
function typeText(text) {
  return `(()=>{const editor=document.querySelector('.cm-content'); editor.focus(); document.execCommand('selectAll'); return document.execCommand('insertText',false,${JSON.stringify(text)})})()`
}
function clickAction(label) {
  return `(()=>{const button=[...document.querySelectorAll('.external-conflict-dialog button')].find(b=>b.textContent.includes(${JSON.stringify(label)})); if(!button)throw new Error('未找到冲突操作按钮'); button.click(); return true})()`
}
// U07 起本地文件优先作为当前窗口的新标签：用真实拖放事件打开，
// 渲染层才会同步标签栏并切到该文稿（直调 openLocalFile 不会更新界面）。
async function fileWindow(source, path) {
  const point = await source.evaluate(`(() => { const r = document.querySelector('.cm-content, .ProseMirror').getBoundingClientRect(); return { x: r.x + 40, y: r.y + 30 } })()`)
  const data = { items: [], files: [path], dragOperationsMask: 1 }
  await source.send('Input.dispatchDragEvent', { type: 'dragEnter', ...point, data })
  await source.send('Input.dispatchDragEvent', { type: 'dragOver', ...point, data })
  await wait(150)
  await source.send('Input.dispatchDragEvent', { type: 'drop', ...point, data })
  await wait(1800)
  return source.evaluate
}
try {
  const source = await connect((await pages())[0])
  const evaluate = await fileWindow(source, file)
  // 标题由主进程按活动文稿设置（另由 tests/runtime/list-windows.ps1 核对系统窗口标题），
  // 这里验证渲染层可见的文件名标签。
  const initialTab = await evaluate(`(()=>{const tab=document.querySelector('.editor-tab.is-active');return {title:tab?.querySelector('.tab-title')?.textContent?.trim(),file:tab?.title}})()`)
  assert.equal(initialTab.title, '中文冲突测试.txt', '初次打开显示文件名标签')
  assert.ok(initialTab.file?.endsWith('中文冲突测试.txt'), '标签悬浮提示带完整路径')
  // 先改磁盘，再模拟尚未落盘的窗口编辑，立即触发正常自动保存入口。
  await writeFile(file, '外部编辑器版本', 'utf8')
  assert.equal(await evaluate(typeText('窗口尚未保存的新正文')), true)
  await wait(1500)
  assert.equal(await readFile(file, 'utf8'), '外部编辑器版本', '外部内容不得提前覆盖')
  assert.equal(await evaluate(`Boolean(document.querySelector('.external-conflict-dialog'))`), true, '冲突对话框可见')
  await evaluate(clickAction('保留我的版本'))
  await wait(800)
  assert.equal(await readFile(file, 'utf8'), '窗口尚未保存的新正文', '保留我的版本必须使用内存正文')
  assert.equal((await evaluate(boot)).draft.content, '窗口尚未保存的新正文', '数据库与保存内容一致')
  // 二次外部修改，确认重新加载和版本同步。
  await writeFile(file, '第二次外部修改', 'utf8')
  await evaluate(`window.dispatchEvent(new Event('focus')); true`)
  await wait(500)
  await evaluate(clickAction('重新加载'))
  await wait(800)
  assert.equal((await evaluate(boot)).draft.content, '第二次外部修改', '重新加载更新数据库')
  await evaluate(typeText('重新加载后继续编辑'))
  await wait(1200)
  assert.equal(await readFile(file, 'utf8'), '重新加载后继续编辑', '重新加载后版本递增可继续保存')
  const gbk = await fileWindow(source, gbkFile)
  await gbk(`window.__fileToasts=[]; window.sheepText.onToast(t=>window.__fileToasts.push(t)); true`)
  await gbk(typeText('你好，保存为 UTF-8'))
  await wait(1200)
  assert.equal(await readFile(gbkFile, 'utf8'), '你好，保存为 UTF-8')
  assert.ok((await gbk('window.__fileToasts')).some(t => t.message.includes('UTF-8')), '保存成功通知编码转换')
  const newest = (await evaluate(boot)).draft
  assert.equal(await evaluate(`window.sheepText.saveDraft(${JSON.stringify({ ...newest, content: '过期写入不能落盘', version: newest.version - 1 })}).then(()=>false,()=>true)`), true, '旧版本请求应被拒绝')
  assert.equal(await readFile(file, 'utf8'), '重新加载后继续编辑', '旧版本保存不能改磁盘')
  console.log(JSON.stringify({ passed: true, initialTitle: true, autosaveConflictBlocked: true, keepUsesUnsavedMemory: true, reloadThenSave: true, encodingToast: true, staleSaveBlocked: true }, null, 2))
} finally { connections.forEach(ws => ws.close()) }
