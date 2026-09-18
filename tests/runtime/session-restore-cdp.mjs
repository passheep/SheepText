// 批次 C 验证：U06 会话恢复。
// 用法：
//   node session-restore-cdp.mjs record      # 记录当前全部窗口的标签与活动项
//   node session-restore-cdp.mjs verify      # 重启后核对全部窗口与标签
//   node session-restore-cdp.mjs close-last  # 点击窗口关闭按钮关掉当前窗口（走应用真实关闭流程）
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
const port = process.env.SHEEPTEXT_CDP_PORT || '9348'
const mode = process.argv[2] || 'record'
const statePath = process.env.SHEEPTEXT_SESSION_STATE || '.runtime-user-data/session-state.json'
const wait = ms => new Promise(r => setTimeout(r, ms))
const pages = async () => (await (await fetch(`http://localhost:${port}/json/list`)).json()).filter(p => p.type === 'page')
async function connect(page) {
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise(r => ws.addEventListener('open', r, { once: true }))
  let id = 0
  const pending = new Map()
  ws.onmessage = event => { const m = JSON.parse(event.data); pending.get(m.id)?.(m); pending.delete(m.id) }
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const key = ++id
    const timer = setTimeout(() => reject(new Error(method + ' 超时')), 15000)
    pending.set(key, m => { clearTimeout(timer); m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result) })
    ws.send(JSON.stringify({ id: key, method, params }))
  })
  const evaluate = async expression => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
    return r.result.value
  }
  return { send, evaluate, close: () => ws.close() }
}
const readWindow = `(() => {
  const tabs = [...document.querySelectorAll('.editor-tab')]
  return {
    titles: tabs.map(t => t.querySelector('.tab-title')?.textContent?.trim()),
    activeIndex: tabs.findIndex(t => t.classList.contains('is-active'))
  }
})()`
const sortKey = (item) => (item.titles ?? []).join('|')

if (mode === 'record') {
  const snapshot = []
  for (const page of await pages()) {
    const client = await connect(page)
    snapshot.push(await client.evaluate(readWindow))
    client.close()
  }
  writeFileSync(statePath, JSON.stringify(snapshot, null, 1), 'utf8')
  console.log(JSON.stringify({ mode, windows: snapshot.length, snapshot }, null, 1))
} else if (mode === 'close-last') {
  const list = await pages()
  const client = await connect(list[0])
  await client.evaluate(`(() => {
    const button = [...document.querySelectorAll('button')].find(b => b.title === '关闭窗口')
    if (!button) return false
    button.click()
    return true
  })()`)
  client.close()
  await wait(1500)
  console.log(JSON.stringify({ mode, remainingWindows: (await pages()).length }, null, 1))
} else {
  const expected = JSON.parse(readFileSync(statePath, 'utf8'))
  const actual = []
  for (const page of await pages()) {
    const client = await connect(page)
    actual.push(await client.evaluate(readWindow))
    client.close()
  }
  const problems = []
  if (actual.length !== expected.length) problems.push(`窗口数不符：期望 ${expected.length}，实际 ${actual.length}`)
  const expectedSorted = [...expected].sort((a, b) => sortKey(a).localeCompare(sortKey(b)))
  const actualSorted = [...actual].sort((a, b) => sortKey(a).localeCompare(sortKey(b)))
  for (let i = 0; i < Math.min(expectedSorted.length, actualSorted.length); i += 1) {
    if (JSON.stringify(expectedSorted[i].titles) !== JSON.stringify(actualSorted[i].titles)) {
      problems.push(`窗口标签不符：期望 ${JSON.stringify(expectedSorted[i].titles)}，实际 ${JSON.stringify(actualSorted[i].titles)}`)
    }
    if (expectedSorted[i].activeIndex !== actualSorted[i].activeIndex) {
      problems.push(`活动标签不符：期望 ${expectedSorted[i].activeIndex}，实际 ${actualSorted[i].activeIndex}`)
    }
  }
  console.log(JSON.stringify({ passed: problems.length === 0, problems, expected, actual }, null, 1))
  assert.equal(problems.length, 0, problems.join('；'))
}