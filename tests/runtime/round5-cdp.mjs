// 第五轮验证：全部替换按钮溢出、编辑器字体选项、默认纹理、粘贴提示层级。
const port = process.env.SHEEPTEXT_CDP_PORT || '9373'
const wait = ms => new Promise(r => setTimeout(r, ms))
const list = await (await fetch(`http://localhost:${port}/json/list`)).json()
const page = list.find(p => p.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise(r => ws.addEventListener('open', r, { once: true }))
let id = 0
const pending = new Map()
ws.onmessage = e => { const m = JSON.parse(e.data); const cb = pending.get(m.id); if (cb) { pending.clear(); cb(m) } }
const send = (method, params = {}) => new Promise((res, rej) => {
  const k = ++id
  const timer = setTimeout(() => rej(new Error(method + ' 超时')), 30000)
  pending.set(k, m => { clearTimeout(timer); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result) })
  ws.send(JSON.stringify({ id: k, method, params }))
})
const ev = async expr => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
  return r.result.value
}
const problems = []
await send('Page.bringToFront')
await wait(600)

// ---------- F20 全部替换按钮不再溢出 ----------
const findCheck = async (mode, target) => {
  await ev(`(() => { const b = [...document.querySelectorAll('.mode-switch button, button')].find(x => x.textContent.trim() === ${JSON.stringify(mode)}); if (b) b.click(); return true })()`)
  await wait(2000)
  await ev(`document.querySelector(${JSON.stringify(target)})?.focus()`)
  await wait(300)
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', modifiers: 2, key: 'f', code: 'KeyF', windowsVirtualKeyCode: 70, nativeVirtualKeyCode: 70 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 2, key: 'f', code: 'KeyF', windowsVirtualKeyCode: 70, nativeVirtualKeyCode: 70 })
  await wait(900)
  await ev(`(() => {
    const toggle = [...document.querySelectorAll('.sheep-find-widget button')].find(b => /替换/.test(b.getAttribute('title') || ''))
    if (toggle) toggle.click()
    return Boolean(toggle)
  })()`)
  await wait(700)
  const data = await ev(`(() => {
    const widget = document.querySelector('.sheep-find-widget')
    if (!widget) return { ok: false }
    const buttons = [...widget.querySelectorAll('.sheep-find-text-button')].map(b => ({
      text: b.textContent.trim(),
      w: +b.getBoundingClientRect().width.toFixed(1),
      scrollW: b.scrollWidth,
      clientW: b.clientWidth,
      overflowX: b.scrollWidth - b.clientWidth
    }))
    const inputs = [...widget.querySelectorAll('input')].map(i => +i.getBoundingClientRect().width.toFixed(1))
    return { ok: true, cols: getComputedStyle(document.querySelector('.sheep-find-replace-row')).gridTemplateColumns, buttons, inputs }
  })()`)
  // 关闭查找
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 })
  await wait(600)
  return { mode, ...data }
}

const findResults = [await findCheck('TXT', '.cm-content'), await findCheck('Markdown', '.ProseMirror')]
for (const r of findResults) {
  if (!r.ok) { problems.push(`${r.mode}: 查找浮层未出现`); continue }
  for (const b of r.buttons) {
    if (b.overflowX > 0) problems.push(`${r.mode}: ${b.text} 按钮文字溢出 ${b.overflowX}px（宽 ${b.w}，内容需 ${b.scrollW}）`)
  }
  if (r.inputs.length >= 2 && Math.abs(r.inputs[0] - r.inputs[1]) > 1) {
    problems.push(`${r.mode}: 查找与替换输入框宽度不一致 ${r.inputs[0]} / ${r.inputs[1]}`)
  }
}

// ---------- F21 设置中的编辑器字体 ----------
await ev(`(() => { const b = [...document.querySelectorAll('button')].find(el => el.getAttribute('title') === '设置'); if (b) b.click(); return true })()`)
await wait(2000)
const fontState = await ev(`(() => {
  const fields = [...document.querySelectorAll('.field-block')]
  const field = fields.find(f => f.querySelector('span')?.textContent.includes('编辑器字体'))
  if (!field) return { found: false }
  const trigger = field.querySelector('.select-trigger .select-value')
  const preview = field.querySelector('.font-preview')
  return {
    found: true,
    current: trigger?.textContent.trim() ?? null,
    previewText: preview?.textContent.trim() ?? null,
    previewFont: preview ? getComputedStyle(preview).fontFamily : null,
    searchable: Boolean(field.querySelector('.select-trigger'))
  }
})()`)
if (!fontState.found) problems.push('设置面板未找到「编辑器字体」字段')

// 打开字体下拉，检查是否可搜索且列出本机字体
await ev(`(() => {
  const field = [...document.querySelectorAll('.field-block')].find(f => f.querySelector('span')?.textContent.includes('编辑器字体'))
  field?.querySelector('.select-trigger')?.click()
  return true
})()`)
await wait(1400)
const dropdown = await ev(`(() => {
  const popover = document.querySelector('.select-popover')
  if (!popover) return { open: false }
  const search = popover.querySelector('.select-search input')
  const options = [...popover.querySelectorAll('.select-option .option-copy strong')].map(el => el.textContent.trim())
  return { open: true, hasSearch: Boolean(search), total: options.length, first: options.slice(0, 4) }
})()`)
if (!dropdown.open) problems.push('字体下拉未打开')
else {
  if (!dropdown.hasSearch) problems.push('字体下拉缺少搜索框')
  if (dropdown.total < 10) problems.push(`字体列表过少：${dropdown.total}`)
}
// 用搜索筛选并选中一个必定存在的西文字体（中文名在不同系统下可能以英文注册）
const picked = await ev(`(async () => {
  const popover = document.querySelector('.select-popover')
  const input = popover?.querySelector('.select-search input')
  if (!input) return null
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
  setter.call(input, 'Arial')
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await new Promise(r => setTimeout(r, 500))
  const options = [...popover.querySelectorAll('.select-option')]
  const target = options.find(o => o.querySelector('strong')?.textContent.trim() === 'Arial') || options[0]
  if (!target) return null
  const label = target.querySelector('strong')?.textContent.trim() ?? target.textContent.trim()
  target.click()
  return label
})()`)
await wait(700)
if (!picked) problems.push('未能通过搜索选中字体')

// 保存并确认 CSS 变量已应用
await ev(`(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.includes('保存偏好')); if (b) b.click(); return true })()`)
await wait(1600)
const applied = await ev(`(() => ({
  declared: document.documentElement.style.getPropertyValue('--font-editor'),
  resolved: getComputedStyle(document.documentElement).getPropertyValue('--font-editor').trim(),
  editorFont: getComputedStyle(document.querySelector('.cm-scroller') || document.querySelector('.ProseMirror') || document.body).fontFamily,
  previewFont: document.querySelector('.font-preview') ? getComputedStyle(document.querySelector('.font-preview')).fontFamily : null
}))()`)
// 选择字体后，声明值应带上回退字体栈
if (picked && !applied.declared.includes('var(--font-editor-default)')) {
  problems.push('字体变量未包含回退字体栈：' + applied.declared)
}
if (picked && !applied.editorFont.toLowerCase().includes(String(picked).toLowerCase())) {
  problems.push(`编辑器未使用所选字体：期望 ${picked}，实际 ${applied.editorFont}`)
}

// ---------- F22 默认背景纹理为“无纹理” ----------
const pattern = await ev(`(() => {
  const field = [...document.querySelectorAll('.field-block')].find(f => f.querySelector('span')?.textContent.includes('背景纹理'))
  return field?.querySelector('.select-value')?.textContent.trim() ?? null
})()`)
if (pattern !== '无纹理') problems.push(`背景纹理默认值不是“无纹理”：${pattern}`)

// ---------- F23 粘贴提示层级 ----------
await ev(`(() => { const b = [...document.querySelectorAll('button')].find(el => el.getAttribute('title') === '关闭'); if (b) b.click(); else document.querySelector('.settings-backdrop')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); return true })()`)
await wait(900)
const noticeZ = await ev(`(() => {
  const el = document.querySelector('.paste-notice')
  return el ? getComputedStyle(el).zIndex : null
})()`)

console.log(JSON.stringify({
  passed: problems.length === 0,
  problems,
  find: findResults,
  font: { ...fontState, dropdown, picked, applied },
  pattern,
  noticeZIndexWhenVisible: noticeZ
}, null, 1))
ws.close()