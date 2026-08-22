// Target "DSH" for the NetworkPolicy PoC: HTTP 200 on 0.0.0.0:8081.
import { createServer } from 'node:http'

createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' })
  res.end('dsh-ok\n')
}).listen(8081, '0.0.0.0', () => console.log('target listening on 0.0.0.0:8081'))
