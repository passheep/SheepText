// 第一批修复的单次自包含验证：恢复默认模型 → F11 显示态 → F12 悬停 → F13 替换行布局。
const [page] = await (await fetch('http://localhost:9333/json/list')).json()
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
const inject = await send('Runtime.evaluate', { expression: `window.__testDone = false; window.__testResult = null; (${async function inner() {
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
  const clickTitle = text => [...document.querySelectorAll('button')].find(button => (button.title || '').includes(text) || button.textContent?.includes(text))?.click()
  const result = {}
  try {
    // —— 0. 若设置面板还开着先关闭 ——
    if (document.querySelector('.settings-panel')) {
      ;[...document.querySelectorAll('.settings-panel button')].find(button => (button.title || button.textContent || '').includes('关闭设置'))?.click()
      await wait(600)
    }
    // —— 1. 恢复默认模型：打开设置 → 模型页 → 选第一个模型 → 保存 → 关闭 ——
    result.enhanceButtonsWhenNone = document.querySelectorAll('.enhance-icon-button').length
    clickTitle('设置')
    await wait(1000)
    ;[...document.querySelectorAll('button')].find(button => button.textContent?.trim() === '模型')?.click()
    await wait(700)
    document.querySelector('.field-block .select-trigger')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await wait(700)
    const options = [...document.querySelectorAll('.select-option')]
    const first = options.find(node => !node.textContent?.includes('不设默认模型'))
    result.restoredModel = first?.textContent?.trim().slice(0, 24)
    first?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await wait(700)
    ;[...document.querySelectorAll('.settings-panel button')].find(button => button.textContent?.includes('保存') || button.textContent?.includes('应用'))?.click()
    await wait(800)
    ;[...document.querySelectorAll('.settings-panel button')].find(button => (button.title || '').includes('关闭设置'))?.click()
    await wait(800)
    result.enhanceButtonsWhenSet = document.querySelectorAll('.enhance-icon-button').length
    result.f11Passed = result.enhanceButtonsWhenNone === 0 && result.enhanceButtonsWhenSet === 2
    // —— 2. F12：新建菜单悬停链路 ——
    const group = document.querySelector('.new-draft-group')
    const menuButton = group?.querySelector('.quick-new-menu')
    const r = {}
    menuButton?.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }))
    await wait(300)
    r.shown = !!document.querySelector('.new-menu')
    // 模拟鼠标穿向菜单：先离开 group，再进入菜单面板（应保持打开）
    group?.dispatchEvent(new MouseEvent('mouseleave', { bubbles: false }))
    await wait(80)
    const menu = document.querySelector('.new-menu')
    r.stillOpenAfterGap = !!menu
    menu?.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }))
    await wait(300)
    r.stillOpenOnMenu = !!document.querySelector('.new-menu')
    // 真正离开：group 和菜单都离开后应延迟关闭
    document.body.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    await wait(900)
    r.closedAfterLeave = !document.querySelector('.new-menu')
    result.newMenu = r
    result.f12Passed = r.shown && r.stillOpenAfterGap && r.stillOpenOnMenu && r.closedAfterLeave
    // —— 3. F13：查找替换行布局 ——
    const cmContent = document.querySelector('.cm-content')
    if (cmContent) {
      cmContent.focus()
      document.execCommand('insertText', false, '苹果 香蕉 橙子')
      await wait(300)
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true, cancelable: true }))
      await wait(500)
    }
    const toggle = document.querySelector('.sheep-find-expand')
    toggle?.click()
    await wait(500)
    const widget = document.querySelector('.sheep-find-widget')
    const replaceRow = document.querySelector('.sheep-find-replace-row')
    if (widget && replaceRow) {
      const widgetRect = widget.getBoundingClientRect()
      const input = replaceRow.querySelector('input')
      const searchInput = document.querySelector('.sheep-find-search-row input')
      const buttons = [...replaceRow.querySelectorAll('button')]
      const find = {}
      find.widgetWidth = Math.round(widgetRect.width)
      find.replaceInputWidth = Math.round(input.getBoundingClientRect().width)
      find.searchInputWidth = Math.round(searchInput.getBoundingClientRect().width)
      find.buttonsInside = buttons.every(button => {
        const rect = button.getBoundingClientRect()
        return rect.width > 0 && rect.right <= widgetRect.right + 1
      })
      find.buttonLabels = buttons.map(button => button.textContent?.trim())
      result.findReplace = find
      result.f13Passed = find.buttonsInside && Math.abs(find.replaceInputWidth - find.searchInputWidth) <= 4
    } else {
      result.f13Passed = false
      result.f13Error = widget ? '替换行未出现' : '查找浮层未出现'
    }
    // 关闭查找浮层
    document.querySelector('.sheep-find-close')?.click()
    await wait(300)
    result.passed = result.f11Passed && result.f12Passed && result.f13Passed
  } catch (error) {
    result.passed = false
    result.error = String(error?.message ?? error)
  }
  window.__testResult = result
  window.__testDone = true
}.toString()})()` })
if (inject.result?.exceptionDetails) { console.error('注入失败', JSON.stringify(inject.result.exceptionDetails, null, 2)); process.exit(2) }
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
console.error('轮询超时')
process.exit(2)
