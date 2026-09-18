// 使用真实磁盘文件和 Chromium 拖放事件验证，不直接调用打开文件 IPC。
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const port = process.env.SHEEPTEXT_CDP_PORT || '9334'
const directory = resolve('.runtime-user-data', `drop-fixtures-${Date.now()}`)
await mkdir(directory, { recursive: true })
const files = [resolve(directory, '拖放测试.txt'), resolve(directory, '拖放测试.md')]
await writeFile(files[0], '拖放 TXT 正文', 'utf8')
await writeFile(files[1], '# 拖放 Markdown\n\n正文', 'utf8')
const pages = async () => (await (await fetch(`http://localhost:${port}/json/list`)).json()).filter(p => p.type === 'page')
const wait = ms => new Promise(r => setTimeout(r, ms))
const page = (await pages())[0]
assert.ok(page, '需要先启动隔离测试实例')
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise(r => ws.addEventListener('open', r, { once: true }))
let id = 0
const pending = new Map()
ws.addEventListener('message', event => {
  const message = JSON.parse(event.data)
  const callback = pending.get(message.id)
  if (callback) { pending.delete(message.id); callback(message) }
})
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const requestId = ++id
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`${method} 超时`)) }, 15000)
    pending.set(requestId, message => { clearTimeout(timer); message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result) })
    ws.send(JSON.stringify({ id: requestId, method, params }))
  })
}
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
  return result.result.value
}
const bootstrap = `window.sheepText.bootstrap(new URLSearchParams(location.search).get('windowId'))`
try {
  await send('Page.bringToFront')
  await send('Page.reload')
  await wait(1200)
  const markdown = process.env.SHEEPTEXT_DROP_MODE === 'markdown'
  await evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent?.trim() === ${JSON.stringify(markdown ? 'Markdown' : 'TXT')})?.click()`)
  await wait(800)
  assert.equal(await evaluate(`Boolean(document.querySelector(${JSON.stringify(markdown ? '.ProseMirror' : '.cm-content')}))`), true, '切换到指定编辑区')
  const before = await evaluate(bootstrap)
  const initialPages = (await pages()).length
  const point = await evaluate(`(() => { const r = document.querySelector('.cm-content, .ProseMirror').getBoundingClientRect(); return { x: r.x + 40, y: r.y + 30 } })()`)
  async function drop(paths) {
    const data = { items: [], files: paths, dragOperationsMask: 1 }
    await send('Input.dispatchDragEvent', { type: 'dragEnter', ...point, data })
    await send('Input.dispatchDragEvent', { type: 'dragOver', ...point, data })
    await wait(150)
    assert.equal(await evaluate(`Boolean(document.querySelector('.drag-file-overlay'))`), true, '拖入时显示提示')
    await send('Input.dispatchDragEvent', { type: 'drop', ...point, data })
  }
  // U07：拖入的文件优先作为当前窗口的新标签，未达上限时不再开新窗口。
  await drop(files)
  await wait(2200)
  assert.equal((await pages()).length, initialPages, '未达标签上限时拖入文件不新开窗口')
  const tabTitles = await evaluate(`[...document.querySelectorAll('.editor-tab')].map(t => t.querySelector('.tab-title')?.textContent?.trim())`)
  for (const file of files) {
    const name = file.replaceAll('\\', '/').split('/').pop()
    assert.ok(tabTitles.includes(name), '拖入文件作为标签出现：' + name + ' / ' + JSON.stringify(tabTitles))
  }
  const history = await evaluate(`window.sheepText.searchHistory({currentDraftId:${JSON.stringify(before.draft.id)}, search:'',limit:100})`)
  for (const file of files) assert.ok(history.items.some(item => item.filePath?.replaceAll('\\', '/').toLowerCase() === file.replaceAll('\\', '/').toLowerCase()), '历史记录包含真实文件路径')
  // 重复拖入已打开的文件：不新增窗口也不重复建标签
  const tabsBeforeDuplicate = tabTitles.length
  await drop([files[0]])
  await wait(1400)
  assert.equal((await pages()).length, initialPages, '重复拖入不开新窗口')
  assert.equal(await evaluate(`document.querySelectorAll('.editor-tab').length`), tabsBeforeDuplicate, '重复拖入不重复建标签')
  const unsupported = resolve(directory, '不支持.csv')
  await writeFile(unsupported, '甲,乙', 'utf8')
  await drop([unsupported])
  await wait(900)
  assert.equal((await pages()).length, initialPages, '不支持的类型不能新开窗口')
  assert.equal(await evaluate(`document.querySelectorAll('.editor-tab').length`), tabsBeforeDuplicate, '不支持的类型不新增标签')
  assert.ok(await evaluate(`document.body.textContent.includes('仅支持打开 TXT 或 Markdown 文件')`), '显示不支持类型提示')
  console.log(JSON.stringify({ passed: true, mode: before.draft.displayMode, openedAsTabs: files.length, originalUnchanged: true, historyPaths: true, duplicateReused: true, unsupportedRejected: true }, null, 2))
} finally { ws.close() }
// 测试文件保留在隔离数据目录，不进行自动删除。
