// 行内补全的 FIM 模拟服务：让主进程真去请求一个本地端点，验证整条链路。
// 只用于运行时测试，不参与打包。
import { createServer } from 'node:http'

const PORT = Number(process.env.SHEEPTEXT_MOCK_PORT || 19876)
const DEFAULT_COMPLETION = '这是模型续写出来的一句话。'

export function startMockFimServer(onRequest) {
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', () => {
      if (req.method !== 'POST') {
        res.writeHead(404).end('{}')
        return
      }
      let body = {}
      try { body = JSON.parse(raw) } catch { body = {} }
      const path = req.url ?? ''
      if (typeof onRequest === 'function') onRequest({ path, body, headers: req.headers })
      if (path.includes('fail')) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { message: '模拟服务故障' } }))
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        choices: [{ text: DEFAULT_COMPLETION }],
        usage: {
          prompt_tokens: 42,
          completion_tokens: 9,
          prompt_cache_hit_tokens: 30,
          prompt_cache_miss_tokens: 12
        }
      }))
    })
  })
  return new Promise((resolve) => {
    server.listen(PORT, '127.0.0.1', () => resolve(server))
  })
}

// 允许直接以脚本方式启动（bash 里做种子数据时用）
if (process.argv[1] && process.argv[1].endsWith('completion-mock-server.mjs')) {
  startMockFimServer(({ path, body }) => {
    console.log('[mock]', path, 'model=' + body.model, 'prompt长度=' + String(body.prompt ?? '').length, 'suffix长度=' + String(body.suffix ?? '').length)
  }).then(() => console.log(`FIM 模拟服务已启动：http://127.0.0.1:${PORT}`))
}