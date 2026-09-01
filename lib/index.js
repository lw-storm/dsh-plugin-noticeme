/**
 * dsh-plugin-noticeme — host entry (persistent plugin form).
 *
 * Watches two "the user must act" signals and puts them into a short-lived
 * in-memory queue that the browser client drains:
 *
 *   1. approval/request  — an approval prompt is waiting for the user;
 *   2. tools/pre-execute — an ask_user_question call is about to dispatch, so
 *                          the question card is appearing and waiting.
 *
 * Endpoints (same-origin only):
 *   GET /dsh-noticeme/version — running plugin version.
 *   GET /dsh-noticeme/pending — drain the queue now (returns what is queued).
 *   GET /dsh-noticeme/wait    — long-poll: resolves immediately when items are
 *                               queued, otherwise within ~25 s. Browsers do not
 *                               throttle a pending fetch, so background tabs
 *                               keep receiving notifications (unlike timers).
 *   GET /dsh-noticeme/resolved?ids=a,b,c — which of the delivered call ids
 *                               have been settled (approval decided / question
 *                               answered) since they were handed to the client.
 *
 * Settlement tracking: an item already delivered to the client can still be
 * settled afterwards (the user approves on the visible page, then switches
 * away). `delivered` keeps the delivered call ids with their settlement flag,
 * so the client can ask before raising a deferred notification and drop
 * already-handled items — no spurious notifications for things the user
 * already dealt with.
 *
 * The queue is drained on read, so each item is notified at most once.
 * Everything here is defensive: unknown shapes degrade to generic text.
 */

export const name = 'dsh-plugin-noticeme'
export const inject = ['webServer']
export const VERSION = 'v12'

const MAX_PENDING = 50
const MAX_LEN = 140
const WAIT_TIMEOUT = 25000
const MAX_DELIVERED = 50

let pending = []
let seq = 0
let waiters = []
let resolved = [] // recently finished tool-call ids: their pending items are dropped on drain
let delivered = [] // delivered call ids with settlement flag, for client-side re-check

function isResolved(callId) {
  return callId !== undefined && callId !== null && resolved.includes(callId)
}

function markResolved(callId) {
  if (callId === undefined || callId === null) return
  if (!resolved.includes(callId)) {
    resolved.push(callId)
    if (resolved.length > 100) resolved.splice(0, resolved.length - 100)
  }
  for (const d of delivered) {
    if (d.callId === callId) d.resolved = true
  }
}

function clip(s, n) {
  s = String(s)
  return s.length > n ? s.slice(0, n - 3) + '...' : s
}

function pick(obj, keys) {
  if (!obj) return ''
  for (const k of keys) {
    try {
      const v = obj[k]
      if (typeof v === 'string' && v) return v
      if (typeof v === 'number') return String(v)
    } catch {
      /* next key */
    }
  }
  return ''
}

function drainItems() {
  const keep = pending.filter((it) => !isResolved(it.callId))
  pending = []
  for (const it of keep) {
    if (it.callId !== undefined && it.callId !== null) {
      delivered.push({ callId: it.callId, resolved: false })
      if (delivered.length > MAX_DELIVERED) delivered.shift()
    }
  }
  return keep
}

function wakeWaiters() {
  if (!waiters.length) return
  const ws = waiters
  waiters = []
  for (const w of ws) {
    try {
      w()
    } catch {
      /* ignore */
    }
  }
}

function push(item) {
  pending.push({ id: ++seq, at: Date.now(), ...item })
  if (pending.length > MAX_PENDING) pending.splice(0, pending.length - MAX_PENDING)
  wakeWaiters()
}

function summarizeApproval(req) {
  const tool = pick(req || {}, ['toolName', 'tool', 'name']) || '未知操作'
  const reason = pick(req || {}, ['reason', 'message', 'description']) || ''
  return {
    type: 'approval',
    title: 'DSH 需要你确认',
    body: clip('工具：' + tool + (reason ? ' · ' + reason : ''), MAX_LEN),
  }
}

function summarizeQuestion(exec) {
  let q = ''
  try {
    const args = exec && exec.arguments
    if (args) {
      if (typeof args.question === 'string' && args.question) q = args.question
      else if (Array.isArray(args.questions) && args.questions.length) {
        const first = args.questions[0]
        q = (first && typeof first.question === 'string' && first.question) || ''
      }
    }
  } catch {
    /* ignore */
  }
  return {
    type: 'question',
    title: 'DSH 提问等你回答',
    body: clip(q || 'AI 提出了问题，等待你回答', MAX_LEN),
  }
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

function sameOrigin(req) {
  const origin = req.headers.origin
  if (origin === undefined) return true
  const host = req.headers.host
  if (typeof origin !== 'string' || typeof host !== 'string') return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

async function waitForItems() {
  if (pending.length) return
  await new Promise((resolve) => {
    let done = false
    const finish = () => {
      if (done) return
      done = true
      resolve()
    }
    const timer = setTimeout(finish, WAIT_TIMEOUT)
    waiters.push(() => {
      clearTimeout(timer)
      finish()
    })
  })
}

export function apply(ctx) {
  ctx.on('approval/request', (req, next) => {
    try {
      push({ ...summarizeApproval(req), callId: req && req.callId })
    } catch {
      /* never block approval flow */
    }
    return next()
  })

  ctx.on('tools/pre-execute', (exec, next) => {
    try {
      if (exec && exec.name === 'ask_user_question') push({ ...summarizeQuestion(exec), callId: exec.callId })
    } catch {
      /* observer only */
    }
    return next()
  })

  ctx.on('tools/result', (exec) => {
    try {
      // A finished tool call means the approval was decided / question answered:
      // mark it settled so deferred notifications are suppressed.
      if (exec && exec.callId) markResolved(exec.callId)
    } catch {
      /* observer only */
    }
  })

  ctx.effect(() => {
    const disposers = [
      ctx.webServer.register({
        kind: 'exact',
        path: '/dsh-noticeme/version',
        handler: async (req, res) => {
          try {
            if (!sameOrigin(req)) return sendJson(res, 403, { ok: false, error: 'untrusted origin' })
            sendJson(res, 200, { ok: true, version: VERSION })
          } catch (e) {
            sendJson(res, 500, { ok: false, error: (e && e.message) || String(e) })
          }
        },
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: '/dsh-noticeme/pending',
        handler: async (req, res) => {
          try {
            if (!sameOrigin(req)) return sendJson(res, 403, { ok: false, error: 'untrusted origin' })
            sendJson(res, 200, { ok: true, items: drainItems() })
          } catch (e) {
            sendJson(res, 500, { ok: false, error: (e && e.message) || String(e) })
          }
        },
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: '/dsh-noticeme/resolved',
        handler: async (req, res) => {
          try {
            if (!sameOrigin(req)) return sendJson(res, 403, { ok: false, error: 'untrusted origin' })
            const url = new URL(req.url, 'http://localhost')
            const ids = (url.searchParams.get('ids') || '').split(',').filter(Boolean)
            const settled = []
            for (const d of delivered) {
              if (d.resolved && ids.includes(d.callId)) settled.push(d.callId)
            }
            sendJson(res, 200, { ok: true, resolved: settled })
          } catch (e) {
            sendJson(res, 500, { ok: false, error: (e && e.message) || String(e) })
          }
        },
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: '/dsh-noticeme/wait',
        handler: async (req, res) => {
          try {
            if (!sameOrigin(req)) return sendJson(res, 403, { ok: false, error: 'untrusted origin' })
            await waitForItems()
            sendJson(res, 200, { ok: true, items: drainItems() })
          } catch (e) {
            sendJson(res, 500, { ok: false, error: (e && e.message) || String(e) })
          }
        },
      }),
    ]
    return () => {
      for (const d of disposers) d()
    }
  }, 'dsh-plugin-noticeme: http routes')
}
