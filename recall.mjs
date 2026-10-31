// ============================================================================
// dsh-memory-layer · 触发式召回（recall.mjs，v2 / v0.11 增强）
//
// 输入当前会话的"信号"（工作目录 + 最近工具调用），输出该注入的内容：
//   - 命中 trigger 的记忆：按类型优先级 workflow > error > decision > fact，同类按最近访问
//   - 命中 trigger 的工作流链：优先注入（整条链）
//   - 偏好/决定通道（v0.11）：不依赖 trigger，独立小预算
//   - 冷启动兜底（v0.11）：库里还没攒出 trigger 关联时不至于颗粒无收
//   - 注入预算：最多 maxItems 条 / maxChars 字符（超了按优先级截断）
//
// 不靠模型判断、不靠向量：命中就注入，没命中就什么都不注入（宁缺毋滥，预算优先）。
//
// ⚠️ 计数语义（v0.11 修正）：这里的"注入"只刷新 last_accessed（**被看到**），
//    不计 hits、不写 last_used。真实使用由 queryEntries 的关键词命中与
//    `memory action=used` 推进。旧实现两者混为一谈：每组装一次提示词就 hits+1
//    并刷新同一列 → 只要被想起过一次就永远"最近使用过"，compact 的 30/90 天
//    规则事实上永不触发（自反馈污染）。
// ============================================================================

import * as db from './db.mjs'
import { triggersFromText, triggersFromToolCalls, priorityOf } from './trigger.mjs'
import { CFG, projectRealm } from './shared.mjs'

export const BUDGET = { maxItems: 8, maxChars: 1200 }

/** 组装本次触发命中内容。返回 { text, items, triggers, chars } */
export function recallBySignals({ cwd, toolCalls = [] } = {}, budget = BUDGET) {
  const triggers = [...new Set([...triggersFromToolCalls(toolCalls), ...triggersFromText(cwd || '')])].filter(Boolean)
  if (!triggers.length) return { text: '', items: [], triggers: [], chars: 0 }
  const realm = projectRealm(cwd)
  const hits = db.byTrigger(triggers, { realm })
  hits.sort((a, b) => priorityOf(a.mtype) - priorityOf(b.mtype) || String(b.last_accessed || b.created_at || '').localeCompare(String(a.last_accessed || a.created_at || '')))
  const chains = triggers.map((t) => db.chainGet(t)).filter(Boolean)
  const lines = []
  let chars = 0
  const items = []
  const push = (line, item) => {
    if (items.length >= budget.maxItems) return false
    if (chars + line.length > budget.maxChars) return false
    lines.push(line)
    chars += line.length
    items.push(item)
    return true
  }
  for (const c of chains) {
    if (!push(`- [链] 当 ${c.trigger} 时：${(c.steps || []).join(' → ')}`, { kind: 'chain', trigger: c.trigger })) break
  }
  for (const e of hits) {
    if (!push(`- [${e.mtype || 'fact'}] ${e.text}`, { kind: 'memory', fp: e.fp })) break
  }
  if (!lines.length) return { text: '', items: [], triggers, chars: 0 }
  // 只记「被注入」：刷新 last_accessed，不推进 hits / last_used（见文件头说明）
  const fps = new Set(items.filter((i) => i.fp).map((i) => i.fp))
  for (const fp of fps) db.touchEntry(fp, { accessed: true })
  for (const i of items) if (i.kind === 'chain') db.chainTouched(i.trigger)
  return { text: lines.join('\n'), items, triggers, chars }
}

/**
 * 偏好/决定通道（v0.11）。
 *
 * 触发式召回只能命中含文件名/错误代号的记忆，而"偏好/决定"是纯自然语言——
 * 实测 8 条典型偏好里 6 条没有任何 trigger，它们唯一的出场方式是挤进常驻快照，
 * 并随记忆增长被挤出预算。这里给它们一条**独立小预算**：不与触发召回抢 1200 字符，
 * 也不参与 touch（注入本身不算使用）。
 */
export function decisionChannel({ realm = 'user' } = {}, budget = null) {
  const maxItems = budget?.maxItems ?? Number(CFG.decisionChannelMax ?? 3)
  const maxChars = budget?.maxChars ?? Number(CFG.decisionChannelChars ?? 400)
  if (!(maxItems > 0) || !(maxChars > 0)) return { text: '', items: [], chars: 0 }
  const picked = db.allEntries().filter((e) => (
    e.mtype === 'decision'
    || e.fragment_type === 'preference'
    || e.memory_class === 'user_decision'
    || e.memory_class === 'user_preference'
  ))
  // 同 realm 优先 → 权重高优先 → 最近使用优先
  picked.sort((a, b) =>
    ((b.realm === realm) - (a.realm === realm))
    || (Number(b.weight) || 0) - (Number(a.weight) || 0)
    || String(b.last_used || b.created_at || '').localeCompare(String(a.last_used || a.created_at || '')))
  const lines = []
  const items = []
  let chars = 0
  for (const e of picked) {
    if (items.length >= maxItems) break
    const line = `- [${e.mtype || 'decision'}] ${e.text}`
    if (chars + line.length > maxChars) break
    lines.push(line)
    chars += line.length
    items.push({ kind: 'decision', fp: e.fp })
  }
  return { text: lines.join('\n'), items, chars }
}

/**
 * 冷启动兜底（v0.11）：库里还没攒出 trigger 关联时（新装插件的头几周），
 * 触发召回恒为零命中，用户会以为插件没用。活跃条目不多时回落为"最近写入的几条"。
 * 仍受预算约束，且库一大就自动让位给触发召回。
 */
export function coldStartFallback({ realm = 'user' } = {}, budget = null) {
  const maxItems = budget?.maxItems ?? Number(CFG.coldStartFallbackMax ?? 3)
  if (!(maxItems > 0)) return { text: '', items: [], chars: 0 }
  const all = db.allEntries()
  if (all.length > Math.max(20, maxItems * 5)) return { text: '', items: [], chars: 0 }
  const picked = all
    .slice()
    .sort((a, b) =>
      ((b.realm === realm) - (a.realm === realm))
      || String(b.created_at || '').localeCompare(String(a.created_at || '')))
    .slice(0, maxItems)
  const lines = picked.map((e) => `- [${e.mtype || 'fact'}] ${e.text}`)
  return { text: lines.join('\n'), items: picked.map((e) => ({ kind: 'cold', fp: e.fp })), chars: lines.join('\n').length }
}

/** 组装完整的"本次会话该注入什么"（触发命中 + 偏好通道 + 冷启动兜底）。
 *  index.mjs 的 systemPrompt.context 与 `/memory preview` 共用同一入口。 */
export function buildInjection({ cwd, toolCalls = [] } = {}) {
  const realm = projectRealm(cwd)
  const trig = recallBySignals({ cwd, toolCalls })
  const dec = decisionChannel({ realm })
  const cold = trig.items.length ? { text: '', items: [] } : coldStartFallback({ realm })
  const parts = []
  if (dec.text) parts.push('【偏好/决定】\n' + dec.text)
  if (trig.text) parts.push('【触发命中】\n' + trig.text)
  if (cold.text) parts.push('【最近记忆（冷启动）】\n' + cold.text)
  return {
    text: parts.join('\n\n'),
    realm,
    triggers: trig.triggers,
    items: [...dec.items, ...trig.items, ...cold.items],
    triggerItems: trig.items,
    decisionItems: dec.items,
    coldItems: cold.items,
    chars: trig.chars + dec.chars + cold.chars,
  }
}

/** 解释一条记忆为什么（不）会被注入（`/memory why`） */
export function explain(fp, { cwd, toolCalls = [] } = {}) {
  const e = db.getByFp(fp)
  if (!e) return { ok: false, error: `未找到 [fp:${fp}]` }
  const reasons = []
  if (e.status !== 'active') reasons.push(`当前状态 ${e.status}：非 active，不参与注入与检索`)
  const realm = projectRealm(cwd)
  const signals = [...new Set([...triggersFromToolCalls(toolCalls || []), ...triggersFromText(cwd || '')])].filter(Boolean)
  if (e.trigger && signals.includes(e.trigger)) reasons.push(`命中触发信号 ${e.trigger}（本次会话信号之一）`)
  else if (e.trigger) reasons.push(`挂了触发串 ${e.trigger}，本次会话信号里没有它（信号：${signals.join(' ') || '无'}）`)
  else reasons.push('没有任何 trigger —— 只能靠偏好/决定通道或常驻快照出场')
  if (e.mtype === 'decision' || e.fragment_type === 'preference' || e.memory_class === 'user_decision' || e.memory_class === 'user_preference') {
    reasons.push('属于偏好/决定通道：不依赖 trigger，独立预算')
  }
  if (e.trigger && db.chainGet(e.trigger)) reasons.push(`触发串 ${e.trigger} 已形成工作流链，链会整条注入`)
  reasons.push(`realm=${e.realm || 'user'}（本次会话 realm=${realm}）`)
  reasons.push(`类型 ${e.mtype || 'fact'}，优先级 ${priorityOf(e.mtype)}（0=最高）`)
  reasons.push(`真实使用 ${Number(e.hits || 0)} 次，最近使用 ${e.last_used || '从未'}，最近被注入 ${e.last_accessed || '从未'}`)
  return { ok: true, fp, reasons }
}
