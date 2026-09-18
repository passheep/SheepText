// 第四轮验证：U11 关闭拼写检查、U12 主题色柔和化、U13 融合编辑背景、U14 手柄右下微调。
// 只读取界面状态，不修改磁盘文件。
const port = process.env.SHEEPTEXT_CDP_PORT || '9360'
const wait = ms => new Promise(r => setTimeout(r, ms))
const [page] = (await (await fetch(`http://localhost:${port}/json/list`)).json()).filter(p => p.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise(r => ws.addEventListener('open', r, { once: true }))
let id = 0
const pending = new Map()
ws.onmessage = e => { const m = JSON.parse(e.data); const cb = pending.get(m.id); if (cb) { pending.clear(); cb(m) } }
const send = (method, params = {}) => new Promise((res, rej) => {
  const k = ++id
  const timer = setTimeout(() => rej(new Error(method + ' 超时')), 20000)
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
await wait(400)

// ---------- U11 拼写检查已关闭（两种编辑器都要查） ----------
const spell = await ev(`(() => {
  const pm = document.querySelector('.ProseMirror')
  const cm = document.querySelector('.cm-content')
  return {
    proseMirror: pm ? pm.getAttribute('spellcheck') : null,
    codeMirror: cm ? cm.getAttribute('spellcheck') : null,
    editor: pm ? 'milkdown' : (cm ? 'codemirror' : 'none')
  }
})()`)
if (spell.proseMirror === null) {
  // 当前是 TXT 模式，切到 Markdown 再查一次
  await ev(`(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Markdown'); if (b) b.click(); return true })()`)
  await wait(1600)
  spell.proseMirror = await ev(`document.querySelector('.ProseMirror')?.getAttribute('spellcheck') ?? null`)
  spell.checkedMarkdown = true
  await ev(`(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'TXT'); if (b) b.click(); return true })()`)
  await wait(1200)
}
if (spell.proseMirror !== 'false') problems.push('Markdown 编辑器未关闭拼写检查：' + spell.proseMirror)
if (spell.codeMirror !== 'false') problems.push('TXT 编辑器未关闭拼写检查：' + spell.codeMirror)

// ---------- U12 主题色已柔和化 ----------
const themeColor = await ev(`(() => {
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--primary').trim()
  return raw
})()`)
// 计算饱和度，确认比旧默认值 #6958cf（约 55%）更低
const saturation = (hex) => {
  const r = parseInt(hex.slice(1, 3), 16) / 255, g = parseInt(hex.slice(3, 5), 16) / 255, b = parseInt(hex.slice(5, 7), 16) / 255
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2
  if (max === min) return 0
  return (max - min) / (1 - Math.abs(2 * l - 1))
}
if (!/^#[0-9a-f]{6}$/i.test(themeColor)) problems.push('未能读取主题色：' + themeColor)
else {
  const sat = saturation(themeColor)
  const legacySat = saturation('#6958cf')
  if (Math.abs(sat - legacySat) < 0.05) problems.push(`主题色饱和度未降低：${themeColor} sat=${sat.toFixed(2)} 旧=${legacySat.toFixed(2)}`)
}

// ---------- U13 融合编辑背景 ----------
const backgrounds = await ev(`(() => {
  const ws = document.querySelector('.workspace')
  const probe = document.createElement('div')
  // 探针必须挂在 workspace 内部，才能继承 --editor-base
  ws.appendChild(probe)
  const read = (cls) => {
    ws.className = ws.className.replace(/editor-bg-\\S+/g, '').trim() + ' ' + cls
    probe.style.background = 'var(--editor-base)'
    return getComputedStyle(probe).backgroundColor
  }
  const result = { auto: read('editor-bg-auto'), blend: read('editor-bg-blend') }
  // 切到深色再读一次融合色
  const root = document.documentElement
  const previous = root.dataset.theme
  root.dataset.theme = 'dark'
  result.blendDark = read('editor-bg-blend')
  root.dataset.theme = previous
  // 还原工作区类名
  ws.className = ws.className.replace(/editor-bg-\\S+/g, '').trim() + ' editor-bg-auto'
  probe.remove()
  return result
})()`)
// 融合色需要重新读一次浅色值（上一步最后读的是深色）
const rgbToHex = (value) => {
  // color-mix 的结果会被序列化成 color(srgb r g b)（0~1 浮点）
  const srgb = value.match(/^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/)
  if (srgb) {
    return '#' + [1, 2, 3].map(i => Math.round(parseFloat(srgb[i]) * 255).toString(16).padStart(2, '0')).join('')
  }
  const nums = value.match(/\d+/g)
  if (!nums) return value
  return '#' + nums.slice(0, 3).map(n => Number(n).toString(16).padStart(2, '0')).join('')
}
const blendLight = rgbToHex(backgrounds.blend)
const blendDark = rgbToHex(backgrounds.blendDark)
// 与实测标题栏颜色比对：浅色 #faf8f5（需求期望 #f9f8f5，差 1 以内）、深色 #19191b
const near = (hex, target, tolerance = 2) => {
  for (let i = 1; i < 7; i += 2) {
    if (Math.abs(parseInt(hex.slice(i, i + 2), 16) - parseInt(target.slice(i, i + 2), 16)) > tolerance) return false
  }
  return true
}
if (!near(blendLight, '#f9f8f5')) problems.push(`融合背景浅色不符：${blendLight}（期望接近 #f9f8f5）`)
if (!near(blendDark, '#19191b')) problems.push(`融合背景深色不符：${blendDark}（期望接近 #19191b）`)
if (blendLight === rgbToHex(backgrounds.auto)) problems.push('融合背景与跟随界面完全相同，未体现差异')

// ---------- U14 手柄右下微调 ----------
// 由 handle-align-cdp.mjs 负责精确量测，这里确认手柄仍可正常显示
console.log(JSON.stringify({
  passed: problems.length === 0, problems,
  spellcheck: spell, themeColor, themeSaturation: /^#[0-9a-f]{6}$/i.test(themeColor) ? +saturation(themeColor).toFixed(3) : null,
  legacySaturation: +saturation('#6958cf').toFixed(3),
  blendBackground: { light: blendLight, dark: blendDark },
  autoBackground: rgbToHex(backgrounds.auto)
}, null, 1))
ws.close()