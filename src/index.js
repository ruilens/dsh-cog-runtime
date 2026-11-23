// dsh-cog-runtime — v0.1 认知运行时（单 agent）
//
// 三个持久对象（工作区下的 .cog/）：
//   task.json       任务图：节点必带可机检验收条件
//   evidence.jsonl  证据账：每条完成必须指向真实产物
//   decisions.jsonl 决策账：计划、失败、重规划、阻塞
//
// 三个强制机制（代码执行，不靠提示词）：
//   1. 没有验收条件的节点不能进计划
//   2. 没有可核验证据的节点不能标记完成
//   3. 同一节点失败两次后，必须先重规划，否则不能完成
//
// 目标：让"假装完成"成为不可能的状态。
import fs from 'node:fs'
import path from 'node:path'

export const name = 'dsh-cog-runtime'
export const inject = ['tools']

const DIR = '.cog'
const TASK = 'task.json'
const EVID = 'evidence.jsonl'
const DECI = 'decisions.jsonl'

const now = () => new Date().toISOString()
const dirOf = cwd => path.join(cwd, DIR)
const taskPath = cwd => path.join(dirOf(cwd), TASK)
const evidPath = cwd => path.join(dirOf(cwd), EVID)
const deciPath = cwd => path.join(dirOf(cwd), DECI)

// ---------------- 存储 ----------------

function readState(cwd) {
  try {
    const s = JSON.parse(fs.readFileSync(taskPath(cwd), 'utf8'))
    if (!s || !Array.isArray(s.nodes)) throw new Error('bad state')
    return s
  } catch {
    return null
  }
}

function writeState(cwd, state) {
  fs.mkdirSync(dirOf(cwd), { recursive: true })
  fs.writeFileSync(taskPath(cwd), JSON.stringify(state, null, 2))
}

function appendLine(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.appendFileSync(file, JSON.stringify(obj) + '\n')
}

function loadState(cwd) {
  const s = readState(cwd)
  if (!s) throw new Error('cog: no plan yet — call cog_plan first')
  return s
}

function findNode(state, id) {
  const n = state.nodes.find(x => x.id === id)
  if (!n) throw new Error(`cog: unknown node ${id}`)
  return n
}

function summary(state) {
  const by = { open: 0, done: 0, blocked: 0 }
  for (const n of state.nodes) by[n.status] = (by[n.status] || 0) + 1
  return { total: state.nodes.length, ...by }
}

// ---------------- 证据校验 ----------------

function inside(cwd, p) {
  const abs = path.resolve(cwd, p)
  const root = path.resolve(cwd)
  const rel = path.relative(root, abs)
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel)
}

function checkEvidence(cwd, ev) {
  if (!ev || typeof ev !== 'object') throw new Error('cog_done: evidence items must be objects')
  const type = String(ev.type || '')
  if (!['file', 'command', 'test'].includes(type)) {
    throw new Error(`cog_done: evidence.type must be file|command|test, got "${type}"`)
  }
  const ref = String(ev.ref || '').trim()
  if (!ref) throw new Error('cog_done: evidence.ref is required')
  if (type === 'file') {
    if (!inside(cwd, ref)) throw new Error(`cog_done: file evidence must be inside the workspace: ${ref}`)
    if (!fs.existsSync(path.resolve(cwd, ref))) {
      throw new Error(`cog_done: evidence file does not exist: ${ref}`)
    }
    return { type, ref, exitCode: 0, note: String(ev.note || '') }
  }
  if (Number(ev.exitCode) !== 0) {
    throw new Error(`cog_done: ${type} evidence requires exitCode 0, got ${ev.exitCode}`)
  }
  return { type, ref, exitCode: 0, note: String(ev.note || '') }
}

// ---------------- 核心操作（可单元测试） ----------------

export function cogPlan(cwd, nodes) {
  if (!Array.isArray(nodes) || nodes.length === 0) {
    throw new Error('cog_plan: nodes must be a non-empty array')
  }
  const state = readState(cwd) || { version: 1, createdAt: now(), nodes: [] }
  const added = []
  for (const raw of nodes) {
    const id = String(raw?.id || '').trim()
    const goal = String(raw?.goal || '').trim()
    const accept = String(raw?.accept || '').trim()
    if (!id) throw new Error('cog_plan: every node needs an id')
    if (!goal) throw new Error(`cog_plan: node ${id} needs a goal`)
    if (!accept) {
      throw new Error(`cog_plan: node ${id} has no acceptance criterion — refused (a node must be checkable)`)
    }
    if (state.nodes.some(n => n.id === id)) throw new Error(`cog_plan: duplicate node ${id}`)
    state.nodes.push({
      id, goal, accept,
      status: 'open',
      owner: null,
      failures: 0,
      strategyChangeRequired: false,
      replans: 0,
      evidence: [],
      createdAt: now(),
    })
    added.push(id)
  }
  writeState(cwd, state)
  appendLine(deciPath(cwd), { at: now(), action: 'plan', nodes: added })
  return `planned ${added.length} node(s): ${added.join(', ')} | ${JSON.stringify(summary(state))}`
}

export function cogStatus(cwd) {
  const state = readState(cwd)
  if (!state) return 'no plan yet — call cog_plan first'
  const lines = state.nodes.map(n =>
    `${n.id} [${n.status}] failures=${n.failures}${n.strategyChangeRequired ? ' REPLAN_REQUIRED' : ''} — ${n.goal}`,
  )
  return `${JSON.stringify(summary(state))}\n${lines.join('\n')}`
}

export function cogDone(cwd, id, evidence) {
  const state = loadState(cwd)
  const node = findNode(state, String(id || ''))
  if (node.status !== 'open') throw new Error(`cog_done: node ${node.id} is ${node.status}`)
  if (node.strategyChangeRequired) {
    throw new Error(`cog_done: node ${node.id} failed twice — call cog_replan or cog_block first`)
  }
  if (!Array.isArray(evidence) || evidence.length === 0) {
    throw new Error('cog_done: evidence must be a non-empty array (no evidence, no completion)')
  }
  const checked = evidence.map(ev => checkEvidence(cwd, ev))
  node.status = 'done'
  node.evidence = checked
  node.doneAt = now()
  writeState(cwd, state)
  for (const ev of checked) appendLine(evidPath(cwd), { at: now(), node: node.id, ...ev })
  appendLine(deciPath(cwd), { at: now(), action: 'done', node: node.id, evidence: checked.length })
  return `done ${node.id} (${checked.length} evidence item(s)) | ${JSON.stringify(summary(state))}`
}

export function cogFail(cwd, id, reason) {
  const state = loadState(cwd)
  const node = findNode(state, String(id || ''))
  if (node.status !== 'open') throw new Error(`cog_fail: node ${node.id} is ${node.status}`)
  const why = String(reason || '').trim()
  if (!why) throw new Error('cog_fail: reason is required')
  node.failures += 1
  if (node.failures >= 2) node.strategyChangeRequired = true
  writeState(cwd, state)
  appendLine(deciPath(cwd), { at: now(), action: 'fail', node: node.id, failures: node.failures, reason: why })
  return node.strategyChangeRequired
    ? `fail ${node.id} (${node.failures}) — REPLAN REQUIRED: call cog_replan with a different approach, or cog_block`
    : `fail ${node.id} (${node.failures}) — one more failure will require a strategy change`
}

export function cogReplan(cwd, id, approach) {
  const state = loadState(cwd)
  const node = findNode(state, String(id || ''))
  const how = String(approach || '').trim()
  if (!how) throw new Error('cog_replan: approach is required')
  node.strategyChangeRequired = false
  node.replans += 1
  writeState(cwd, state)
  appendLine(deciPath(cwd), { at: now(), action: 'replan', node: node.id, approach: how })
  return `replanned ${node.id} (#${node.replans}) — you may attempt cog_done again`
}

export function cogBlock(cwd, id, reason) {
  const state = loadState(cwd)
  const node = findNode(state, String(id || ''))
  const why = String(reason || '').trim()
  if (!why) throw new Error('cog_block: reason is required')
  node.status = 'blocked'
  node.blockedAt = now()
  writeState(cwd, state)
  appendLine(deciPath(cwd), { at: now(), action: 'block', node: node.id, reason: why })
  return `blocked ${node.id} | ${JSON.stringify(summary(state))}`
}

// ---------------- dsh 接线 ----------------

function cwdOf(exec) {
  try {
    const h = exec?.agent?.session?.header?.cwd
    if (typeof h === 'string' && h) return h
  } catch {}
  try {
    const h2 = exec?.session?.header?.cwd
    if (typeof h2 === 'string' && h2) return h2
  } catch {}
  try {
    if (typeof exec?.cwd === 'string' && exec.cwd) return exec.cwd
  } catch {}
  return process.cwd()
}

const textOutput = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: String(value) }],
}

export function apply(ctx) {
  ctx.tools.register({
    name: 'cog_plan',
    description:
      'Create or extend the task graph. Every node MUST carry a machine-checkable acceptance criterion (accept); nodes without one are rejected. Call this before doing work.',
    parameters: {
      nodes: { type: 'array', required: true, description: 'Array of {id, goal, accept}.' },
    },
    output: textOutput,
    async execute(args, exec) {
      return cogPlan(cwdOf(exec), args?.nodes)
    },
  })

  ctx.tools.register({
    name: 'cog_status',
    description: 'Show the task graph: node id, status, failures, and whether a strategy change is required.',
    parameters: {},
    output: textOutput,
    async execute(_args, exec) {
      return cogStatus(cwdOf(exec))
    },
  })

  ctx.tools.register({
    name: 'cog_done',
    description:
      'Mark a node done. Requires at least one verifiable evidence item: a file that exists inside the workspace, or a command/test with exitCode 0. Rejected if the node demands a strategy change.',
    parameters: {
      id: { type: 'string', required: true, description: 'Node id.' },
      evidence: { type: 'array', required: true, description: 'Array of {type, ref, exitCode?, note?}.' },
    },
    output: textOutput,
    async execute(args, exec) {
      return cogDone(cwdOf(exec), args?.id, args?.evidence)
    },
  })

  ctx.tools.register({
    name: 'cog_fail',
    description:
      'Record a failed attempt. After two failures the node requires a strategy change: cog_done is refused until cog_replan or cog_block.',
    parameters: {
      id: { type: 'string', required: true, description: 'Node id.' },
      reason: { type: 'string', required: true, description: 'What failed and why.' },
    },
    output: textOutput,
    async execute(args, exec) {
      return cogFail(cwdOf(exec), args?.id, args?.reason)
    },
  })

  ctx.tools.register({
    name: 'cog_replan',
    description:
      'Record a different approach for a node that failed twice. Clears the strategy-change requirement and allows cog_done again.',
    parameters: {
      id: { type: 'string', required: true, description: 'Node id.' },
      approach: { type: 'string', required: true, description: 'The different approach, concretely.' },
    },
    output: textOutput,
    async execute(args, exec) {
      return cogReplan(cwdOf(exec), args?.id, args?.approach)
    },
  })

  ctx.tools.register({
    name: 'cog_block',
    description:
      'Mark a node blocked and hand it back honestly. Use this instead of pretending completion when the acceptance criterion cannot be met.',
    parameters: {
      id: { type: 'string', required: true, description: 'Node id.' },
      reason: { type: 'string', required: true, description: 'Why it cannot be completed.' },
    },
    output: textOutput,
    async execute(args, exec) {
      return cogBlock(cwdOf(exec), args?.id, args?.reason)
    },
  })
}

export const _internal = {
  readState, writeState, loadState, findNode, inside, checkEvidence, summary,
  taskPath, evidPath, deciPath,
}
