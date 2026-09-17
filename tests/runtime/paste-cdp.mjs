// 驱动隔离数据的实际 Electron 应用，验证粘贴及格式清除。
const [page] = await (await fetch('http://localhost:9333/json/list')).json()
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise(resolve => { ws.onopen = resolve })
// 每轮重新加载，避免 Vue 热更新时保留旧的 Crepe 插件闭包。
ws.send(JSON.stringify({ id: 2, method: 'Page.reload' }))
await new Promise(resolve => setTimeout(resolve, 2500))
ws.onmessage = event => {
  const message = JSON.parse(event.data)
  if (message.id !== 1) return
  console.log(JSON.stringify(message.result, null, 2))
  ws.close()
  if (message.result.exceptionDetails || !message.result.result.value?.passed) process.exitCode = 1
}
async function testPaste() {
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
  const mode = [...document.querySelectorAll('button')].find(button => button.textContent === 'Markdown')
  mode.click()
  await wait(1200)
  const dom = document.querySelector('.ProseMirror')
  if (!dom) throw new Error('Milkdown 初始化失败')
  dom.focus()
  const selection = window.getSelection()
  const range = document.createRange()
  range.selectNodeContents(dom)
  selection.removeAllRanges()
  selection.addRange(range)
  await wait(100)
  const data = new DataTransfer()
  data.setData('text/plain', '### 标题\n\n**加粗**')
  dom.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
  await wait(500)
  const before = dom.innerHTML
  const notice = document.querySelector('.paste-notice')?.textContent
  const formatted = !!dom.querySelector('h3') && !!dom.querySelector('strong')
  const clear = [...document.querySelectorAll('.paste-notice button')].find(button => button.textContent === '清除格式')
  clear?.click()
  await wait(350)
  const after = dom.innerHTML
  const markdownPassed = formatted && !!clear && !dom.querySelector('h3,strong') && dom.textContent.includes('标题')
  // 真实快捷键撤销格式清除，检查格式可恢复。
  dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', code: 'KeyZ', ctrlKey: true, bubbles: true, cancelable: true }))
  await wait(300)
  const undoPassed = !!dom.querySelector('h3') && !!dom.querySelector('strong')
  dom.focus()
  range.selectNodeContents(dom)
  selection.removeAllRanges()
  selection.addRange(range)
  await wait(100)
  const htmlData = new DataTransfer()
  htmlData.setData('text/plain', '网页标题正文')
  htmlData.setData('text/html', '<h2>网页标题</h2><p><strong>正文</strong></p>')
  dom.dispatchEvent(new ClipboardEvent('paste', { clipboardData: htmlData, bubbles: true, cancelable: true }))
  await wait(500)
  const htmlNotice = document.querySelector('.paste-notice')?.textContent
  const htmlFormatted = !!dom.querySelector('h2') && !!dom.querySelector('strong')
  ;[...document.querySelectorAll('.paste-notice button')].find(button => button.textContent === '清除格式')?.click()
  await wait(300)
  const htmlAfter = dom.innerHTML
  const htmlPassed = htmlFormatted && !!htmlNotice && !dom.querySelector('h2,strong')
  dom.focus()
  dom.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
  await wait(500)
  const noticeBeforeEdit = !!document.querySelector('.paste-notice')
  dom.focus()
  const inserted = document.execCommand('insertText', false, '继续输入')
  await wait(300)
  // 后台窗口可能暂停退场动画；业务失效以 Vue 状态和编辑器范围为准。
  const component = document.querySelector('.milkdown-editor-shell').__vueParentComponent
  const noticeCleared = component.parent.setupState.pasteNotice === null
  const rangeInvalidated = component.setupState.lastPasteRange === null
  const invalidationPassed = noticeBeforeEdit && noticeCleared && rangeInvalidated
  return { passed: markdownPassed && htmlPassed && undoPassed && invalidationPassed, markdownPassed, htmlPassed, htmlFormatted, htmlNotice, htmlAfter, undoPassed, invalidationPassed, noticeCleared, rangeInvalidated, visibility: document.visibilityState, inserted, noticeBeforeEdit, edited: dom.textContent, remainingNotice: document.querySelector('.paste-notice')?.textContent, before, notice, after }
}
ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: `(${testPaste.toString()})()`, awaitPromise: true, returnByValue: true } }))
