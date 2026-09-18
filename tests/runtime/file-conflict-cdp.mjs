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
  return async expression => {
    const response = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text)
    return response.result.value
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
async function fileWindow(source, path) {
  const result = await source(`window.sheepText.openLocalFile(${JSON.stringify(path)})`)
  for (let i = 0; i < 50; i++) {
    const page = (await pages()).find(p => p.url.includes(result.windowId))
    if (page) { const evaluate = await connect(page); await wait(500); return evaluate }
    await wait(100)
  }
  throw new Error('文件窗口未就绪')
}
try {
  const source = await connect((await pages())[0])
  const evaluate = await fileWindow(source, file)
  assert.equal(await evaluate('document.title'), '中文冲突测试.txt - SheepText', '初次打开系统窗口标题')
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
