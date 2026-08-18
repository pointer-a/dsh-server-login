// Stand-in for a real `dsh` process used by the smoke tests. It is role-aware
// via DSH_SERVER_LOGIN_ROLE:
//   - main: bind the loopback port and serve a marker page; /crash exits 1.
//   - watchdog: headless; polls the handoff file and records what it "executes".
import { createServer } from 'node:http'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const role = process.env.DSH_SERVER_LOGIN_ROLE ?? 'main'
const port = Number(process.env.DSH_SERVER_LOGIN_PORT ?? '3080')
const cwd = process.cwd()

if (role === 'watchdog') {
  const handoffPath = process.env.DSH_SERVER_LOGIN_HANDOFF_PATH
  console.log(`fake-watchdog running cwd=${cwd}`)
  setInterval(() => {
    if (handoffPath === undefined || !existsSync(handoffPath)) return
    const content = readFileSync(handoffPath, 'utf8').trim()
    if (content === '') return
    let command = content
    try {
      command = JSON.parse(content).command ?? content
    } catch {
      // treat as a raw command
    }
    console.log(`fake-watchdog executing: ${command}`)
    const executedPath = join(dirname(handoffPath), 'watchdog-executed.json')
    writeFileSync(executedPath, JSON.stringify({ command, at: Date.now() }))
    writeFileSync(handoffPath, '')
  }, 300)
} else {
  const server = createServer((req, res) => {
    if (req.url === '/crash') {
      res.writeHead(500, { 'content-type': 'text/plain' })
      res.end('crashing')
      setTimeout(() => process.exit(1), 10)
      return
    }
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end(
      `fake-dsh pid=${process.pid} port=${port} cwd=${cwd} url=${req.url} argv=${process.argv.slice(2).join(' ')}`,
    )
  })
  server.listen(port, '127.0.0.1', () => {
    console.log(`fake-dsh listening on ${port}`)
  })
}
