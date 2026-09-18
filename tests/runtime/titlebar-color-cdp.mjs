// 量测标题栏实际渲染色，用于给「融合」编辑背景取准颜色。
// 通过 CDP 截图并采样标题栏中部像素（避开图标与标签）。
const port = process.env.SHEEPTEXT_CDP_PORT || '9359'
const theme = process.env.SHEEPTEXT_THEME || 'light'
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
// 切到指定明暗主题
await ev(`(() => {
  const root = document.documentElement
  root.dataset.theme = ${JSON.stringify(theme)}
  return root.dataset.theme
})()`)
await wait(600)
// 采样点：标题栏右侧空白拖动区（避开按钮与标签）
const point = await ev(`(() => {
  const bar = document.querySelector('.titlebar-drag') || document.querySelector('.titlebar')
  const r = bar.getBoundingClientRect()
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
})()`)
const shot = await send('Page.captureScreenshot', { format: 'png' })
const buffer = Buffer.from(shot.data, 'base64')
// 用最小 PNG 解码：交由 Node 内置 zlib 处理，仅取单像素
const { inflateSync } = await import('node:zlib')
function readPng(buffer) {
  let offset = 8
  let width = 0, height = 0, bitDepth = 0, colorType = 0
  const idat = []
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('ascii', offset + 4, offset + 8)
    const data = buffer.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); bitDepth = data[8]; colorType = data[9] }
    else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    offset += 12 + length
  }
  const raw = inflateSync(Buffer.concat(idat))
  const channels = colorType === 6 ? 4 : 3
  const stride = width * channels
  const out = Buffer.alloc(height * stride)
  let pos = 0
  for (let y = 0; y < height; y += 1) {
    const filter = raw[pos]; pos += 1
    const line = raw.subarray(pos, pos + stride); pos += stride
    const prev = y === 0 ? Buffer.alloc(stride) : out.subarray((y - 1) * stride, y * stride)
    const cur = out.subarray(y * stride, (y + 1) * stride)
    for (let i = 0; i < stride; i += 1) {
      const a = i >= channels ? cur[i - channels] : 0
      const b = prev[i]
      const c = i >= channels ? prev[i - channels] : 0
      let value = line[i]
      if (filter === 1) value += a
      else if (filter === 2) value += b
      else if (filter === 3) value += (a + b) >> 1
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
        value += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c)
      }
      cur[i] = value & 0xff
    }
  }
  return { width, height, channels, data: out }
}
const image = readPng(buffer)
const px = (x, y) => {
  const i = (y * image.width + x) * image.channels
  return { r: image.data[i], g: image.data[i + 1], b: image.data[i + 2] }
}
// 取采样点附近 5 个像素求平均，降低抗锯齿影响
const samples = [px(point.x, point.y), px(point.x + 4, point.y), px(point.x - 4, point.y), px(point.x, point.y + 2), px(point.x + 8, point.y)]
const avg = samples.reduce((acc, s) => ({ r: acc.r + s.r / samples.length, g: acc.g + s.g / samples.length, b: acc.b + s.b / samples.length }), { r: 0, g: 0, b: 0 })
const hex = '#' + [avg.r, avg.g, avg.b].map(v => Math.round(v).toString(16).padStart(2, '0')).join('')
console.log(JSON.stringify({ theme, point, samples, average: hex }, null, 1))
ws.close()