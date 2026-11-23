// v0.1 验收测试：不启动 dsh，直接测核心机制。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert'
import { cogPlan, cogStatus, cogDone, cogFail, cogReplan, cogBlock, _internal } from '../src/index.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cog-smoke-'))
let pass = 0
const ok = (name, fn) => {
  try { fn(); pass++; console.log('PASS', name) }
  catch (e) { console.log('FAIL', name, '—', e.message); process.exitCode = 1 }
}

// 1. 无验收条件 → 拒绝
ok('plan rejects node without accept', () => {
  assert.throws(() => cogPlan(dir, [{ id: 'a', goal: 'do something' }]), /no acceptance criterion/)
})

// 2. 正常计划
ok('plan accepts checkable node', () => {
  const out = cogPlan(dir, [{ id: 'n1', goal: 'write report', accept: 'out/report.md exists' }])
  assert.match(out, /planned 1 node/)
  assert.ok(fs.existsSync(_internal.taskPath(dir)))
})

// 3. 无证据 → 拒绝完成
ok('done rejects empty evidence', () => {
  assert.throws(() => cogDone(dir, 'n1', []), /no evidence/)
})

// 4. 文件不存在 → 拒绝
ok('done rejects missing file', () => {
  assert.throws(() => cogDone(dir, 'n1', [{ type: 'file', ref: 'out/report.md' }]), /does not exist/)
})

// 5. 路径越界 → 拒绝
ok('done rejects path outside workspace', () => {
  assert.throws(() => cogDone(dir, 'n1', [{ type: 'file', ref: '../outside.txt' }]), /inside the workspace/)
})

// 6. 产物存在 → 完成
ok('done accepts existing file', () => {
  fs.mkdirSync(path.join(dir, 'out'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'out/report.md'), '# ok')
  const out = cogDone(dir, 'n1', [{ type: 'file', ref: 'out/report.md' }])
  assert.match(out, /done n1/)
})

// 7. 两次失败 → 必须换方法
ok('two failures require replan', () => {
  cogPlan(dir, [{ id: 'n2', goal: 'fix bug', accept: 'test passes' }])
  cogFail(dir, 'n2', 'first attempt failed')
  const out = cogFail(dir, 'n2', 'second attempt failed')
  assert.match(out, /REPLAN REQUIRED/)
  assert.throws(() => cogDone(dir, 'n2', [{ type: 'command', ref: 'npm test', exitCode: 0 }]), /failed twice/)
  cogReplan(dir, 'n2', 'use a different algorithm')
  const okOut = cogDone(dir, 'n2', [{ type: 'command', ref: 'npm test', exitCode: 0 }])
  assert.match(okOut, /done n2/)
})

// 8. 命令证据要求 exitCode 0
ok('command evidence requires exitCode 0', () => {
  cogPlan(dir, [{ id: 'n3', goal: 'run check', accept: 'exit 0' }])
  assert.throws(() => cogDone(dir, 'n3', [{ type: 'command', ref: 'false', exitCode: 1 }]), /exitCode 0/)
})

// 9. 阻塞
ok('block marks node blocked', () => {
  const out = cogBlock(dir, 'n3', 'acceptance cannot be met')
  assert.match(out, /blocked n3/)
  assert.match(cogStatus(dir), /n3 \[blocked\]/)
})

// 10. 账本落盘
ok('evidence and decisions are persisted', () => {
  const ev = fs.readFileSync(_internal.evidPath(dir), 'utf8').trim().split('\n')
  const de = fs.readFileSync(_internal.deciPath(dir), 'utf8').trim().split('\n')
  assert.ok(ev.length >= 2, 'evidence lines')
  assert.ok(de.some(l => l.includes('"action":"fail"')), 'decision log has fail')
  assert.ok(de.some(l => l.includes('"action":"block"')), 'decision log has block')
})

fs.rmSync(dir, { recursive: true, force: true })
console.log(`\n${pass}/10 passed`)
