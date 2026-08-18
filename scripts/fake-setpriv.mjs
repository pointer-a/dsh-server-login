// Stand-in for a setuid wrapper (e.g. `setpriv --reuid`). Logs the uid it was
// given, then execs the remaining argv (the real DSH command) so the smoke test
// can verify the account-level uid was passed while still running the child.
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'

const uidIdx = process.argv.indexOf('--uid')
const uid = uidIdx >= 0 ? process.argv[uidIdx + 1] : 'unknown'
writeFileSync('setpriv-uid.txt', String(uid))
const rest = process.argv.slice(uidIdx >= 0 ? uidIdx + 2 : 2)
if (rest.length > 0) {
  const child = spawn(rest[0], rest.slice(1), { stdio: 'inherit' })
  child.on('exit', (code) => process.exit(code ?? 0))
} else {
  process.exit(0)
}
