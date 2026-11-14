/**
 * Builds the page the Windows app shows: vendors the hand-tracking runtime
 * and runs the normal production build into dist/.
 *
 * --if-needed skips the build when dist/ is newer than every source file, so
 * `npm start` costs nothing extra when nothing has changed.
 */
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

function newest(path) {
  const st = statSync(path)
  if (!st.isDirectory()) return st.mtimeMs
  let t = st.mtimeMs
  for (const name of readdirSync(path)) {
    if (name === 'mediapipe') continue // vendored copy, not a source
    t = Math.max(t, newest(join(path, name)))
  }
  return t
}

if (process.argv.includes('--if-needed') && existsSync('dist/index.html')) {
  const sources = ['src', 'public', 'index.html', 'vite.config.ts', 'package.json', '.env.local']
  const changed = Math.max(...sources.filter((p) => existsSync(p)).map(newest))
  if (changed < statSync('dist/index.html').mtimeMs) process.exit(0)
  console.log('the interface has changed — rebuilding it first.')
}

const from = 'node_modules/@mediapipe/tasks-vision/wasm'
const to = 'public/mediapipe'
if (existsSync(from) && !existsSync(`${to}/vision_wasm_internal.wasm`)) {
  mkdirSync(to, { recursive: true })
  cpSync(from, to, { recursive: true })
  console.log('vendored the hand-tracking runtime into public/mediapipe.')
}

const r = spawnSync('npm', ['run', 'build'], { stdio: 'inherit', shell: true })
process.exit(r.status ?? 1)
