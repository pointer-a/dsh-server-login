// Stand-in for a real `dsh` process used by smoke-dsh. It binds the loopback
// port passed via DSH_SERVER_LOGIN_PORT and serves a marker page, so the
// orchestrator's spawn → status → proxy → stop lifecycle can be exercised
// without the real harness.
import { createServer } from 'node:http'

const port = Number(process.env.DSH_SERVER_LOGIN_PORT ?? '3080')
const cwd = process.cwd()
const server = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain' })
  res.end(`fake-dsh pid=${process.pid} port=${port} cwd=${cwd} url=${req.url}`)
})
server.listen(port, '127.0.0.1', () => {
  console.log(`fake-dsh listening on ${port}`)
})
