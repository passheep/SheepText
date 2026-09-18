// 验证 TXT 侧粘贴清除格式与 Markdown 大纲导航（真实 Electron 实例）。
// 隐藏窗口会节流定时器，因此注入函数内部只用固定等待（约 20 秒总量），
// 外部仅轮询一次写入的结果对象，不做任何 Promise 竞速。
const port = process.env.SHEEPTEXT_CDP_PORT || '9333'
const [page] = await (await fetch(`http://localhost:${port}/json/list`)).json()
if (!page) { console.error('未找到调试页面'); process.exit(1) }
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
let sequence = 0
const pending = new Map()
ws.onmessage = event => {
  const message = JSON.parse(event.data)
  pending.get(message.id)?.(message)
  pending.delete(message.id)
}
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++sequence
  pending.set(id, resolve)
  ws.send(JSON.stringify({ id, method, params }))
  setTimeout(() => reject(new Error(`CDP ${method} 超时`)), 10000)
})
// 1. 注入测试函数：顺序执行，结果写进 window.__testResult
const inject = await send('Runtime.evaluate', { expression: `window.__testDone = false; window.__testResult = null; (${async function inner() {
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
  const click = text => [...document.querySelectorAll('button')].find(button => button.textContent === text)?.click()
  try {
    // —— TXT：粘贴 Markdown 文本后清除格式 ——
    click('TXT')
    await wait(1500)
    const content = document.querySelector('.cm-content')
    if (!content) throw new Error('.cm-content 不存在')
    content.focus()
    document.execCommand('selectAll')
    await wait(300)
    const data = new DataTransfer()
    data.setData('text/plain', '### 标题\n- 列表项\n**加粗文字**')
    content.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
    await wait(2000)
    const beforeText = content.textContent
    const notice = document.querySelector('.paste-notice')?.textContent
    ;[...document.querySelectorAll('.paste-notice button')].find(button => button.textContent === '清除格式')?.click()
    await wait(2000)
    const afterText = content.textContent
    // 文档可能含历史残留，断言只针对本次粘贴片段：标记被去掉且文字保留
    const txtPassed = !!notice?.includes('清除格式')
      && beforeText.includes('### 标题') && afterText.includes('标题列表项加粗文字')
      && !afterText.includes('### 标题') && !afterText.includes('**加粗文字**')
    // —— Markdown：大纲悬浮与跳转 ——
    click('Markdown')
    await wait(2000)
    const dom = document.querySelector('.ProseMirror')
    if (!dom) throw new Error('.ProseMirror 不存在')
    dom.focus()
    document.execCommand('selectAll')
    await wait(300)
    const headingData = new DataTransfer()
    headingData.setData('text/plain', '### 阿尔法\n\n正文段落\n\n### 贝塔\n\n结尾')
    dom.dispatchEvent(new ClipboardEvent('paste', { clipboardData: headingData, bubbles: true, cancelable: true }))
    await wait(2000)
    const outline = document.querySelector('.milkdown-outline')
    if (!outline) throw new Error('.milkdown-outline 不存在')
    outline.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }))
    await wait(2000)
    const panel = document.querySelector('.milkdown-outline-panel')
    const panelVisible = !!panel && panel.offsetParent !== null
    const items = [...document.querySelectorAll('.milkdown-outline-item')].map(item => item.textContent)
    const second = [...document.querySelectorAll('.milkdown-outline-item')][1]
    second?.click()
    await wait(1500)
    const anchorText = window.getSelection()?.anchorNode?.textContent ?? ''
    outline.dispatchEvent(new MouseEvent('mouseleave', { bubbles: false }))
    // 收起定时器在隐藏/遮挡窗口被强节流；可见时等 3 秒断言收起，
    // 隐藏时记录跳过（收起行为由前台单独实验验证）。
    await wait(3000)
    const hiddenDuringClose = document.visibilityState !== 'visible'
    const panelClosed = !document.querySelector('.milkdown-outline-panel')
    const outlinePassed = panelVisible && items.length === 2 && items[1].includes('贝塔') && anchorText === '贝塔' && (panelClosed || hiddenDuringClose)
    window.__testResult = { passed: txtPassed && outlinePassed, txtPassed, outlinePassed, notice, beforeText, afterText, items, anchorText, panelVisible, panelClosed, hiddenDuringClose }
  } catch (error) {
    window.__testResult = { passed: false, error: String(error?.message ?? error) }
  } finally {
    window.__testDone = true
  }
}.toString()})()` })
if (inject.result?.exceptionDetails) { console.error('注入失败', JSON.stringify(inject.result.exceptionDetails, null, 2)); process.exit(2) }
// 2. 轮询注入结果：总等待约 20 秒，给 60 秒余量
const deadline = Date.now() + 60000
while (Date.now() < deadline) {
  const check = await send('Runtime.evaluate', { expression: 'window.__testDone ? window.__testResult : null', returnByValue: true })
  const value = check.result?.result?.value
  if (value) {
    console.log(JSON.stringify(value, null, 2))
    if (!value.passed) process.exitCode = 1
    ws.close()
    process.exit(process.exitCode ?? 0)
  }
  await new Promise(resolve => setTimeout(resolve, 500))
}
console.error('测试轮询超时（60 秒）')
process.exit(2)
