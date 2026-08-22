// Minimal WebSocket client: handshake + one masked text frame + echo check.
// Usage: node ws-client.mjs <host>:<port>
import { connect } from 'node:net'
import { createHash, randomBytes } from 'node:crypto'

const [host, portStr] = process.argv[2].split(':')
const port = Number(portStr)
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const key = randomBytes(16).toString('base64')

const socket = connect({ host, port }, () => {
  socket.write(
    'GET / HTTP/1.1\r\n' +
      `Host: ${host}:${port}\r\n` +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Key: ${key}\r\n` +
      'Sec-WebSocket-Version: 13\r\n\r\n',
  )
})

let headBuf = Buffer.alloc(0)
let echoBuf = Buffer.alloc(0)
let phase = 'handshake'

socket.on('data', (chunk) => {
  if (phase === 'handshake') {
    headBuf = Buffer.concat([headBuf, chunk])
    const idx = headBuf.indexOf('\r\n\r\n')
    if (idx === -1) return
    const head = headBuf.subarray(0, idx).toString()
    if (!/^HTTP\/1\.1 101/.test(head)) return fail(`no 101 (${head.split('\r\n')[0]})`)
    const m = head.match(/sec-websocket-accept:\s*(\S+)/i)
    const expected = createHash('sha1').update(key + GUID).digest('base64')
    if (!m || m[1] !== expected) return fail('bad Sec-WebSocket-Accept')
    console.log('PASS: 101 handshake + Sec-WebSocket-Accept')
    phase = 'echo'
    const payload = Buffer.from('ping')
    const frame = Buffer.alloc(2 + 4 + payload.length)
    frame[0] = 0x81
    frame[1] = 0x80 | payload.length
    const mask = Buffer.from([0x12, 0x34, 0x56, 0x78])
    mask.copy(frame, 2)
    for (let i = 0; i < payload.length; i++) frame[2 + 4 + i] = payload[i] ^ mask[i % 4]
    socket.write(frame)
    return
  }
  echoBuf = Buffer.concat([echoBuf, chunk])
  // Echoed unmasked text frame: b0=0x81, b1=len, then payload.
  if (echoBuf.length < 2) return
  const len = echoBuf[1] & 0x7f
  if (echoBuf.length < 2 + len) return
  const text = echoBuf.subarray(2, 2 + len).toString()
  if (text !== 'ping') return fail(`echo mismatch (${text})`)
  console.log('PASS: echo round-trip through socat')
  process.exit(0)
})

function fail(msg) {
  console.error('FAIL: ' + msg)
  process.exit(1)
}
socket.on('error', (e) => fail(e.message))
setTimeout(() => fail('timeout'), 10000)
