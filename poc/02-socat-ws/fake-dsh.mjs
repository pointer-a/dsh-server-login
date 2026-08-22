// Minimal fake DSH for the socat-WS PoC: plain HTTP on 127.0.0.1:8080 plus a
// WebSocket echo (handshake + one text-frame round-trip) using only node built-ins.
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const acceptKey = (key) => createHash('sha1').update(key + GUID).digest('base64')

const server = createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' })
  res.end('fake-dsh\n')
})

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key']
  if (!key) {
    socket.destroy()
    return
  }
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`,
  )
  socket.on('data', (buf) => {
    const opcode = buf[0] & 0x0f
    if (opcode === 0x8) {
      socket.end()
      return
    }
    if (opcode !== 0x1 && opcode !== 0x2) return
    const masked = (buf[1] & 0x80) !== 0
    let len = buf[1] & 0x7f
    let offset = 2
    if (len === 126) {
      len = buf.readUInt16BE(2)
      offset = 4
    } else if (len === 127) {
      return // not exercised in the PoC
    }
    let maskKey
    if (masked) {
      maskKey = buf.subarray(offset, offset + 4)
      offset += 4
    }
    const payload = Buffer.from(buf.subarray(offset, offset + len))
    if (masked && maskKey) {
      for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i % 4]
    }
    // Echo back as an unmasked text frame.
    const out = Buffer.alloc(2 + payload.length)
    out[0] = 0x81
    out[1] = payload.length
    payload.copy(out, 2)
    socket.write(out)
  })
})

server.listen(8080, '127.0.0.1', () => console.log('fake-dsh listening on 127.0.0.1:8080'))
