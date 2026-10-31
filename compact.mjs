// ============================================================================
// dsh-memory-layer · 清理层（compact.mjs，v2）
//
// 五条可解释规则，唯一执行入口是 compact()；每次淘汰都写 <MEMORY_ROOT>/compact.log。
//   1. 同 realm+type+key 覆盖 —— 写入时已把旧条目标墓碑（store.writeEntry），此处不重复
//   2. fact —— last_used 超过 30 天且 use_count ≤1 → 墓碑
//   3. workflow/error/decision —— 不设 TTL；last_used 超过 90 天且 use_count ≤1 → 权重减半
//   4. error/decision —— 默认永久保留（本实现不自动淘汰）
//   5. 每条淘汰/降权都写 compact.log（时间 / fp / 规则 / 摘要）
//
// 规则之外不再有别的清理逻辑——多加一条就回到"逻辑复杂、维护困难"的老路。
// ============================================================================

import fs from 'node:fs'
import path from 'node:path'
import * as db from './db.mjs'
import { MEMORY_ROOT } from './shared.mjs'

export const RULES = {
  factTtlDays: 30,
  staleDays: 90,
  minUseCount: 1,
}

function ageDays(ts, now) {
  if (!ts) return Infinity
  const t = Date.parse(ts)
  if (!Number.isFinite(t)) return Infinity
  return (now.getTime() - t) / 86400000
}

function logPath() { return path.join(MEMORY_ROOT, 'compact.log') }

/** dump 导出保留份数（超出从最旧开始删） */
export const MAX_DUMPS = 10

function appendLog(lines) {
  if (!lines.length) return
  try {
    fs.mkdirSync(MEMORY_ROOT, { recursive: true })
    fs.appendFileSync(logPath(), lines.join('\n') + '\n', 'utf-8')
  } catch { /* 日志失败不影响清理结果 */ }
}

/** 执行五条规则。dryRun=true 只算不落库、不写日志。写库路径不产生备份副本（见函数尾部说明） */
export function compact({ now = new Date(), dryRun = false, rules = RULES } = {}) {
  const all = db.allEntries()
  const log = []
  let tombstoned = 0
  let decayed = 0
  let skippedPinned = 0
  for (const e of all) {
    // v0.10.1 修：锁定（pinned）条目豁免全部清理规则。
    // 旧实现无视 pinned —— 实测把 3 条已锁定的核心条目（插件全景 / DSH web 三项契约 /
    // 用词与合规化方向）按 fact-ttl>30d 判了墓碑，与「锁定=不遗忘」的语义直接矛盾。
    if (e.pinned) {
      skippedPinned++
      continue
    }
    // v0.11：判据改用 last_used（**真实被使用**）而非 last_accessed。
    // last_accessed 由"被注入"推进，而触发召回每次组装提示词都会注入一次 →
    // 只要命中过一次就天天刷新，30/90 天规则形同虚设。真实使用只来自
    // query 关键词命中与 memory action=used。
    const used = e.last_used || e.created_at
    const age = ageDays(used, now)
    const hits = Number(e.hits || 0)
    const mtype = e.mtype || 'fact'
    // 规则 2：fact 过期且没人用
    if (mtype === 'fact' && age > rules.factTtlDays && hits <= rules.minUseCount) {
      if (!dryRun) db.setStatus(e.fp, 'deleted')
      tombstoned++
      log.push(`${db.isoNow()} TOMBSTONE rule=fact-ttl>${rules.factTtlDays}d fp=${e.fp} age=${age.toFixed(1)}d use=${hits} :: ${String(e.text).slice(0, 60)}`)
      continue
    }
    // 规则 3：workflow/error/decision 久未使用 → 降权（不删）
    if (mtype !== 'fact' && age > rules.staleDays && hits <= rules.minUseCount) {
      const from = Number(e.weight || 10)
      const to = Math.max(1, Math.round(from / 2))
      if (to < from) {
        if (!dryRun) db.upsertEntry({ fp: e.fp, weight: to })
        decayed++
        log.push(`${db.isoNow()} DECAY rule=stale>${rules.staleDays}d fp=${e.fp} ${from}->${to} age=${age.toFixed(1)}d use=${hits} :: ${String(e.text).slice(0, 60)}`)
      }
    }
    // 规则 4：error / decision 永不自动淘汰（显式标记已解决由使用者 update 处理）
  }
  // 口径统一：**任何写库路径都不自动生成备份副本**（compact / purge / 指纹迁移一致）。
  // 理由：compact 只是把 status 改成 deleted，行还在库里，`restore` 能直接翻回来，
  // 备份对它是纯冗余；而唯一真删库的 purge 恰恰不能备份（备份会把该消失的内容留下）。
  // 需要事前快照就手工 `/memory dump` 或自己拷库——插件不替使用者做这件事。
  if (!dryRun) appendLog(log)
  return { scanned: all.length, tombstoned, decayed, skippedPinned, dryRun, backup: null, log }
}

/** 可读导出（dump）：把活跃记忆按类型写一份 Markdown，返回文件路径与计数 */
export function dump({ dir = MEMORY_ROOT, now = new Date() } = {}) {
  const all = db.allEntries()
  const byType = { workflow: [], error: [], decision: [], fact: [], 其它: [] }
  for (const e of all) (byType[e.mtype] || byType['其它']).push(e)
  const lines = [`# 记忆导出（${db.isoNow()}）`, '', `共 ${all.length} 条活动记忆（墓碑不计）`, '']
  for (const [t, arr] of Object.entries(byType)) {
    if (!arr.length) continue
    lines.push(`## ${t}（${arr.length}）`, '')
    for (const e of arr.sort((a, b) => String(b.last_accessed || '').localeCompare(String(a.last_accessed || '')))) {
      const meta = [`fp:${e.fp}`, e.realm || 'user', e.trigger || '-', `use:${e.hits || 0}`].join(' ')
      lines.push(`- [${meta}] ${e.text}`)
    }
    lines.push('')
  }
  const chains = db.chainAll()
  if (chains.length) {
    lines.push(`## 工作流链（${chains.length}）`, '')
    for (const c of chains) lines.push(`- 当 ${c.trigger} 时：${(c.steps || []).join(' → ')}`)
    lines.push('')
  }
  const file = path.join(dir, `dump-${now.toISOString().slice(0, 19).replace(/[:T]/g, '')}.md`)
  if (dir === MEMORY_ROOT) fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(file, lines.join('\n'), 'utf-8')
  // v0.11：dump 文件轮转——旧实现每次导出都留一个新 md、从不清理，久了会堆一目录。
  try {
    const dumps = fs.readdirSync(dir).filter((f) => /^dump-.*\.md$/.test(f)).sort()
    while (dumps.length > MAX_DUMPS) fs.unlinkSync(path.join(dir, dumps.shift()))
  } catch { /* 清理失败不影响导出结果 */ }
  return { ok: true, file, total: all.length, byType: Object.fromEntries(Object.entries(byType).map(([k, v]) => [k, v.length])), chains: chains.length }
}
