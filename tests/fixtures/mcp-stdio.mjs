import { createInterface } from 'node:readline'

// 独立子进程用于验证真实 stdio 协议、cwd、环境变量、动态工具和进程退出。
let changed = false
const send = value => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...value })}\n`)
createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line)
  if (request.id === undefined) return
  let result
  if (request.method === 'initialize') result = { protocolVersion: '2025-11-25', capabilities: { tools: { listChanged: true } }, serverInfo: { name: 'fixture', version: '1' } }
  else if (request.method === 'tools/list') result = { tools: [{ name: changed ? 'updated' : 'echo', description: 'Read process context', inputSchema: { type: 'object', properties: {} } }] }
  else if (request.method === 'tools/call') {
    result = { content: [{ type: 'text', text: JSON.stringify({ pid: process.pid, cwd: process.cwd(), secret: process.env.MCP_TEST_SECRET }) }] }
    changed = true
  } else result = {}
  send({ id: request.id, result })
  if (request.method === 'tools/call') send({ method: 'notifications/tools/list_changed' })
})
