// ============================================================================
// dsh-memory-layer · 会话沉淀状态（session-state.mjs，v0.6 / v0.11 多会话）
//
// 会话结束自动沉淀的轻量状态：由 snapshot 模块写入（turn/end 时标记），
// store 模块在 writeEntry 成功后清除（模型完成沉淀）。独立成最小模块，
// 避免 store ↔ snapshot 循环依赖。
//
// v0.11：改为**按会话分桶**。旧实现是一个布尔量全局共享，多会话并行时
// A 会话写入会把 B 会话的待沉淀标记一起清掉（B 因此不再被提示沉淀），
// 反过来 A 没沉淀也会让 B 反复被催促。
// ============================================================================

const _lastTurnEnd = new Map() // sessionId -> 时间戳
const _summaryPending = new Set() // 处于"待沉淀"的 sessionId

export function markSummaryPending(sid) {
  if (sid) _summaryPending.add(sid)
}

export function clearSummaryPending(sid) {
  if (!sid) { _summaryPending.clear(); return }
  if (_summaryPending.has(sid)) { _summaryPending.delete(sid); return }
  // id 体系不一致时（写入方拿 agent.id、事件方拿 session.id）无法精确匹配；
  // 此时退化为清全局，否则用户"刚沉淀完还一直被催促"。
  _summaryPending.clear()
}

/** 无 sid 时表示"是否存在任一会话待沉淀"（提示词注入拿不到 session 上下文时的兜底） */
export function isSummaryPending(sid) {
  return sid ? _summaryPending.has(sid) : _summaryPending.size > 0
}

export function setLastTurnEnd(ts, sid) {
  _lastTurnEnd.set(sid || '', ts)
}

export function getLastTurnEnd(sid) {
  if (sid && _lastTurnEnd.has(sid)) return _lastTurnEnd.get(sid) || 0
  if (sid) return 0
  let max = 0
  for (const v of _lastTurnEnd.values()) if (Number(v) > max) max = Number(v)
  return max
}

/** 当前待沉淀的会话数（`/memory stats` 用） */
export function pendingCount() {
  return _summaryPending.size
}
