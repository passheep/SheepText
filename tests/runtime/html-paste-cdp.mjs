// 独立验证 HTML 粘贴，不混入 Markdown 粘贴、撤销或热更新状态。
const [page] = await (await fetch('http://localhost:9333/json/list')).json()
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise(resolve => { ws.onopen = resolve })
let sequence = 0
const pending = new Map()
ws.onmessage = event => {
  const message = JSON.parse(event.data)
  pending.get(message.id)?.(message)
}
const send = (method, params = {}) => new Promise(resolve => {
  const id = ++sequence
  pending.set(id, resolve)
  ws.send(JSON.stringify({ id, method, params }))
})
await send('Page.reload', { ignoreCache: true })
await new Promise(resolve => setTimeout(resolve, 2500))
async function isolateHtml() {
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
  ;[...document.querySelectorAll('button')].find(button => button.textContent === 'Markdown').click()
  await wait(1000)
  const dom = document.querySelector('.ProseMirror')
  dom.focus()
  document.execCommand('selectAll')
  await wait(100)
  // 仅在测试窗口包装回调，记录原始剪贴板、解析后的 Slice 与派发时序。
  const trace = []
  const started = performance.now()
  const record = (kind, details) => trace.push({ kind, ms: Math.round(performance.now() - started), ...details })
  dom.addEventListener('paste', event => record('clipboard', {
    html: event.clipboardData.getData('text/html'),
    items: [...event.clipboardData.items].map(item => ({ kind: item.kind, type: item.type }))
  }), { capture: true, once: true })
  const owner = document.querySelector('.milkdown-editor-shell').__vueParentComponent
  const view = owner?.setupState?.editorView
  if (!view) throw new Error('未能取得测试窗口的 ProseMirror View')
  const originalDispatch = view.dispatch
  view.dispatch = function (transaction) {
    record('dispatch', { changed: transaction.docChanged, steps: transaction.steps.map(step => step.toJSON()) })
    return originalDispatch.call(this, transaction)
  }
  const wrapped = []
  for (const plugin of view.state.plugins) {
    const original = plugin.props.handlePaste
    if (!original) continue
    plugin.props.handlePaste = function (currentView, event, slice) {
      record('handlePaste', { key: plugin.key, slice: slice.toJSON() })
      return original.call(this, currentView, event, slice)
    }
    wrapped.push(() => { plugin.props.handlePaste = original })
  }
  const data = new DataTransfer()
  data.setData('text/html', '<h2>独立标题</h2><p><strong>独立正文</strong></p>')
  const event = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })
  dom.dispatchEvent(event)
  await wait(700)
  const before = dom.innerHTML
  const notice = document.querySelector('.paste-notice')?.textContent
  const button = [...document.querySelectorAll('.paste-notice button')].find(button => button.textContent === '清除格式')
  button?.click()
  await wait(700)
  view.dispatch = originalDispatch
  wrapped.forEach(restore => restore())
  return {
    trace,
    expected: { before: '<h2>独立标题</h2><p><strong>独立正文</strong></p>', notice: '粘贴：保留原格式清除格式', after: '<p>独立标题</p><p>独立正文</p>' },
    actual: { before, notice, after: dom.innerHTML, defaultPrevented: event.defaultPrevented },
    passed: !!button && !dom.querySelector('h2,strong') && dom.textContent === '独立标题独立正文'
  }
}
const result = await send('Runtime.evaluate', { expression: `(${isolateHtml.toString()})()`, awaitPromise: true, returnByValue: true })
console.log(JSON.stringify(result, null, 2))
ws.close()
if (!result.result?.result?.value?.passed) process.exitCode = 1
