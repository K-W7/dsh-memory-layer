// ============================================================================
// dsh-memory-layer · 审批门与自检（gate.mjs，v0.6 架构升级）
//
//   - gateWrite：分级审批门（重要 ask / 普通 auto；审批不可用按 approvalFallback 降级）
//   - selfHeal：SQLite 完整性自检，损坏时从最近备份恢复
// 从 index.mjs 拆出；依赖 shared / db。
// ============================================================================

import * as db from './db.mjs'
import { CFG, isImportant, TOOL_NAME, REQUEST_MARKER, dbgLog } from './shared.mjs'

// ---------- 审批门（分级：重要 ask / 普通 auto；审批不可用按 approvalFallback 降级） ----------

/** DSH 运行时实际返回值（0.1.5-rc.1：dsh-user-approval ApprovalOutcome =
 *  'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'；仅 'allowed-once' 是授予）。
 *  宽松匹配：大小写/下划线/连字符差异均归一，但不放宽授予语义——未知词一律拒绝。 */
export function isApprovalGranted(outcome) {
  const v = String(outcome ?? '').trim().toLowerCase().replace(/[_\s]+/g, '-')
  if (v === 'allowed-once' || v === 'allowed' || v === 'allow' || v === 'granted' || v === 'approved' || v === 'allow-once') return true
  if (v === 'rejected' || v === 'cancelled' || v === 'canceled' || v === 'unavailable' || v === 'deny' || v === 'denied') return false
  // 不认识的词：不是本运行时契约的授予值 → fail-closed。
  // v0.11：此处原有一个空的 `if (v) {}`（注释说"记审计"，但审计已在 v0.10.0 移除），
  // 删掉空块；识别不了的值直接落到下面的 return false，行为不变。
  return false
}

const _warned = new Set()
function warnOnce(key, msg) {
  if (_warned.has(key)) return
  _warned.add(key)
  try { console.warn(`[dsh-memory-layer] ${msg}`) } catch { /* 日志失败不影响主流程 */ }
}

export async function gateWrite(ctx, { track, text, agent, callId, signal }) {
  const important = isImportant(text, track)
  if (!important) {
    return { approved: true, mode: 'auto' }
  }
  const failClosed = CFG.approvalFallback !== 'auto' // 默认 'deny'：审批缺失/异常 → 拒绝（fail-closed）
  const fallback = (why, outcome) => {
    return failClosed
      ? { approved: false, mode: 'ask', outcome: outcome ?? 'unavailable' }
      : { approved: true, mode: 'fallback', outcome: outcome ?? 'unavailable' }
  }
  const approval = ctx.get('approval')
  if (!approval) {
    // v0.11：拿不到审批服务时给一次性可见提示。这一路在默认 approvalFallback=deny 下
    // 会让所有"重要记忆"写入失败，而模型只回一句"写入未获批准"，用户无从判断是宿主
    // 没提供审批、还是自己拒绝了。这里提示排查方向（配置 approvalFallback=auto 或检查宿主版本）。
    warnOnce('approval-missing', '未拿到审批服务（ctx.get("approval") 为空）：重要记忆将按 approvalFallback 处理（默认 deny=拒绝写入）。若宿主未提供审批通道，可设 approvalFallback=auto。')
    return fallback('service-missing')
  }
  // v0.7.1 修：官方契约（dsh-user-approval 0.1.5-rc.2 实测源码）request(req) 第一行就是
  // `const session = req.agent.session`，且要求该会话有未闭合的 turn；dsh-tools 的官方调用
  // 形态是 `{ agent, toolName, callId, reason, signal }`，没有 agent 时官方自己返回 deny
  // （fail-closed），不是崩。此处旧代码只传 toolName/reason → req.agent 为 undefined →
  // 抛 `Cannot read properties of undefined (reading 'session')`，所有重要写入一律失败。
  if (!agent) return fallback('no-agent')
  let outcome
  try {
    outcome = await approval.request({
      agent,
      toolName: TOOL_NAME,
      ...callId !== undefined ? { callId } : {},
      reason: `${REQUEST_MARKER} add ${track}\n${text}`,
      ...signal !== undefined ? { signal } : {},
    })
  } catch (err) {
    // v0.6.5：异常不再静默吞掉——记审计后再按 fallback 策略处理
    return fallback('request-threw', err instanceof Error ? err.message : String(err))
  }
  if (isApprovalGranted(outcome)) return { approved: true, mode: 'ask' }
  // 策略 never / 被拒 / 取消 / unavailable：按 fallback 策略决定（审计会标记）
  return failClosed
    ? { approved: false, mode: 'ask', outcome }
    : { approved: true, mode: 'fallback', outcome }
}

// ---------- 启动自检：主文件解析失败 → 回滚最近备份 ----------

export function selfHeal() {
  // v0.5：SQLite 完整性自检——数据库损坏（如 SQLITE_CORRUPT）时从最近备份恢复
  try {
    db.openDb()
    db.stats() // 触发一次全表读，损坏会抛
  } catch {
    // v0.11：自愈逻辑**绝不能把异常抛出去**——selfHeal 在 apply() 里被调用，
    // 一旦恢复过程抛错（备份损坏、权限不足、磁盘满）就会让整个插件加载失败。
    // 旧实现在这里直接调 restoreLatestBackup() 且没有内层保护。
    try {
      const bk = db.listBackups()
      if (bk.length) {
        const restored = db.restoreLatestBackup()
        dbgLog(`self-heal: restored from ${restored}`)
      }
    } catch (err) {
      try { console.warn(`[dsh-memory-layer] self-heal 恢复失败：${err instanceof Error ? err.message : String(err)}`) } catch { /* ignore */ }
    }
  }
}
