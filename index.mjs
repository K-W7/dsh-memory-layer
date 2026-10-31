// ============================================================================
// dsh-memory-layer v0.10.0 — 记忆层（DSH 宿主插件）：本地单文件 SQLite · 触发式召回 · 五条可解释清理规则 · 工作流链
//
// v0.6 架构升级：index.mjs 为「接线层」——只保留插件装配（工具/命令/Web API/
// apply），业务逻辑已拆分至：
//   shared.mjs       配置/常量/基础工具/指纹与相似度
//   store.mjs        记忆写入/钉/删/回滚/巩固/迁移
//   retrieve.mjs     查询/召回
//   snapshot.mjs     冻结快照/会话沉淀
//   gate.mjs         审批门/自检
//   session-state.mjs 会话沉淀状态
//   db.mjs            SQLite 数据层
//
// 目标运行时：@deepseek-ai/dsh-* 0.2.x（v0.11 修正：旧注释写的是 0.1.x，与 package.json
// 的 peerDependencies `>=0.2.0-rc.2 <0.3.0-0` 不符）。
// ============================================================================

import fs from 'node:fs'
import path from 'node:path'
import * as db from './db.mjs'

// ---------- 分组导入（shared/store/retrieve/snapshot/gate/compact/recall） ----------
import {
  CFG, DEFAULTS, PATHS, setConfig,
  loadConfig, saveConfig,
  ensureDirs, dbgLog, MEMORY_ROOT, projectRealm,
  fingerprint, isImportant, estimateTokens, zhBigrams,
} from './shared.mjs'
import {
  parseEntryLine, formatEntryLine, readEntries, scanAllFiles,
  migrateMarkdownToDb, migrateFingerprints, writeEntry, setPin,
  consolidateHits, removeEntry, purgeEntry, restoreEntry, entryStatus, updateEntryText,
  markUsed, unarchiveEntry,
} from './store.mjs'
import { queryEntries, tokenize } from './retrieve.mjs'
import { renderSnapshot, sessionSummarySectionText, handleSessionEvent } from './snapshot.mjs'
import { gateWrite, selfHeal } from './gate.mjs'
import { compact, dump } from './compact.mjs'
import { recallBySignals, buildInjection, explain } from './recall.mjs'
import { markSummaryPending, clearSummaryPending, isSummaryPending } from './session-state.mjs'

export const inject = ['tools', 'systemPrompt']

// ---------- 触发式召回的会话信号（工作目录 + 最近工具调用） ----------
// v0.11：改为**按会话分桶**。旧实现是一个模块级单例，多会话并行时 A 会话打开的文件
// 会被当成 B 会话的信号（cwd 还会被最后活跃的会话覆盖），召回结果互相串味。
//
// ⚠️ 宿主限制：systemPrompt.context 只给一个**无参**求值函数，拿不到当前 session，
// 因此注入时只能用「最近活跃的那一个会话」的信号——这已比全局混合准确得多。
// 若哪天宿主支持 text(session)，这里可以直接按 session 取桶。
const SIGNALS = new Map() // sessionId -> { cwd, toolCalls }
const MAX_TOOL_CALLS = 12
let _activeSession = ''
let _sawSessionEvent = false

function sessionKeyOf(session) {
  return String((session && (session.id ?? session.key)) || '_default')
}

function noteSignal(session, rawEvent) {
  try {
    const key = sessionKeyOf(session)
    _activeSession = key
    _sawSessionEvent = true
    let s = SIGNALS.get(key)
    if (!s) { s = { cwd: '', toolCalls: [] }; SIGNALS.set(key, s) }
    if (session && session.cwd) s.cwd = session.cwd
    if (rawEvent && rawEvent.type === 'tool/call') {
      s.toolCalls.push({ name: rawEvent.name, arguments: rawEvent.arguments })
      if (s.toolCalls.length > MAX_TOOL_CALLS) s.toolCalls.splice(0, s.toolCalls.length - MAX_TOOL_CALLS)
    }
  } catch { /* 信号采集失败不影响主流程 */ }
}

function currentSignal() {
  const s = SIGNALS.get(_activeSession)
  return { cwd: (s && s.cwd) || '', toolCalls: (s && s.toolCalls) || [] }
}

/** 写入时推断 realm：优先用当前会话的工作目录（v0.11：旧实现写入路径从不落 realm，
 *  于是全部记忆都是 'user'，README 宣称的 project 隔离维度实际不存在） */
function realmFor(sessionId) {
  const s = SIGNALS.get(String(sessionId || '')) || SIGNALS.get(_activeSession)
  return projectRealm(s && s.cwd)
}

const _warned = new Set()
function warnOnce(key, msg) {
  if (_warned.has(key)) return
  _warned.add(key)
  try { console.warn(`[dsh-memory-layer] ${msg}`) } catch { /* ignore */ }
}

function recallSectionText() {
  try {
    // v0.11：从未收到过 session/event → 触发式召回与自动沉淀都不会生效。
    // 旧实现把这条链路的失败完全静默（catch 里什么都不做），用户只会觉得"记忆想不起来"。
    if (!_sawSessionEvent) {
      warnOnce('no-session-event', '未收到任何 session/event：触发式召回与会话自动沉淀不会生效（信号来自该事件）。请确认宿主版本暴露了 session/event，并用 /memory preview 检查。')
    }
    const r = buildInjection(currentSignal())
    if (!r.text) return ''
    const meta = [`注入 ${r.items.length} 条 · ${r.chars} 字符 · realm=${r.realm}`]
    if (r.triggers.length) meta.push(`命中信号 ${r.triggers.join(' ')}`)
    return `## 记忆召回（触发命中 + 偏好/决定）\n${r.text}\n\n> ${meta.join('｜')}`
  } catch { return '' }
}

// ---------- 本地 HTTP 端点的来源校验（v0.11） ----------
// 端点默认只接受「非浏览器直连且 Host 指向本机」或「Origin 指向本机」的请求。
// 旧实现完全不校验：任何能访问 DSH 本地端口的进程或恶意网页（DNS rebinding）都能
// 读全部记忆、把 approvalFallback 改成 auto、删条目。
function isLocalHost(host) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '').split(':')[0]
  return h === '' || h === 'localhost' || h === '127.0.0.1' || h === '::1'
}
function requestAllowed(req) {
  if (process.env.DSH_MEMORY_API_NOAUTH === '1') return true
  const allow = String(process.env.DSH_MEMORY_API_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean)
  const origin = req && req.headers ? req.headers.origin : undefined
  if (!origin) return isLocalHost(req?.headers?.host) // 非浏览器直连：至少确认 Host 是本机
  if (allow.includes(origin)) return true
  try { return isLocalHost(new URL(origin).host) } catch { return false }
}

// v0.8.1：按需抽取持有的宿主服务上下文（在 ctx.inject(['sessions','llm']) 的回调里赋值）

// ---------- 读取请求体（Web API 用） ----------
// v0.8.0：加大小上限（默认 1 MiB，可用 DSH_BIOMEMORY_BODY_LIMIT 覆盖）——旧实现无限缓冲，
// 本机任何进程都能用超大 body 把插件内存打满。
const BODY_LIMIT = Number(process.env.DSH_BIOMEMORY_BODY_LIMIT) > 0 ? Number(process.env.DSH_BIOMEMORY_BODY_LIMIT) : 1024 * 1024
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > BODY_LIMIT) {
        reject(new Error(`请求体超过上限 ${BODY_LIMIT} 字节`))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
    req.on('error', reject)
  })
}

// ---------- 工具定义（官方 ToolDefinition：parameters + output + execute） ----------

function makeMemoryTool(ctx) {
  return {
    name: 'memory',
    // v0.11：描述从 14 行压到 7 行。工具 description 每轮对话都会进 system prompt，
    // 300+ token 的固定开销对一个以"省 token"为卖点的插件很不合算；完整用法见 /memory help。
    description: [
      '跨会话记忆：保存/查询值得记住的偏好、决定与教训。查询≠注入（检索到不代表已采用）。',
      'action=add text="..." [track=user|agent] —— 保存（重要项走审批；与已有条目高度相似时会合并，或提示改用 update）',
      'action=query text="关键词" [topK=10] [includeArchived=false] —— 查询（关键词命中会记一次"真实使用"）',
      'action=used fp="指纹" —— 标记"这条刚才真的用上了"（推进 last_used；与"被注入"区分开）',
      'action=update fp="..." text="新内容" / remove fp（墓碑，可 restore）/ purge fp（物理删除，不可逆）',
      'action=list | pin fp | unpin fp | compact [dryRun=true] | dump',
      '保存原则：偏好/纠正/决策/教训要存；琐事、一次性路径、可从代码重新推导的事实不存。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'query', 'update', 'remove', 'purge', 'restore', 'list', 'pin', 'unpin', 'used', 'compact', 'dump'], description: '操作' },
        text: { type: 'string', description: 'add 的内容、query 的关键词、update 的新内容' },
        track: { type: 'string', enum: ['user', 'agent'], description: 'user=用户偏好/知识；agent=行为/教训（默认 agent）' },
        source: { type: 'string', description: 'add 时信息来源说明（如「用户原话」「文档 x 第 3 节」）；不填则记录会话 ID（source_ref 字段）' },
        fp: { type: 'string', description: 'update/remove/restore/pin/unpin 时按指纹' },
        projectId: { type: 'string', description: 'query 限定项目范围' },
        topK: { type: 'number', description: 'query 返回结果数量上限' },
        minWeight: { type: 'number', description: 'query 最低权重阈值' },
        fragmentTypes: { type: 'string', description: 'query 限定片段类型（逗号分隔：decision,preference,fact,event,note）' },
        includeArchived: { type: 'boolean', description: 'query 是否包含冷归档记忆' },
        dryRun: { type: 'boolean', description: 'compact 预览：不落库、不写日志' },
      },
      required: ['action'],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          error: { type: 'string' },
          skipped: { type: 'boolean' },
          reason: { type: 'string' },
          fp: { type: 'string' },
          mode: { type: 'string' },
          note: { type: 'string' },
          entries: {
            type: 'array',
            items: { type: 'object', properties: { layer: { type: 'string' }, text: { type: 'string' } }, additionalProperties: true },
          },
        },
        required: ['ok'],
      },
      render(args, value) {
        if (!value.ok) return [{ type: 'text', text: value.error || 'memory 操作失败' }]
        if (Array.isArray(value.entries)) {
          if (!value.entries.length) return [{ type: 'text', text: '（无匹配记忆）' }]
          return [{ type: 'text', text: value.entries.map((e) => `- [${e.layer}]${e.memory_class ? `[${e.memory_class}]` : ''} ${e.text}`).join('\n') }]
        }
        if (value.skipped) return [{ type: 'text', text: '重复记忆，已跳过' }]
        if (value.note) return [{ type: 'text', text: value.note }]
        return [{ type: 'text', text: `已保存 [fp:${value.fp}]（${value.mode || 'auto'}）` }]
      },
    },
    presentCall(args) {
      return { card: 'generic', title: `记忆：${args?.action || ''}`, kind: 'other', rawInput: args }
    },
    async execute(args, exec) {
      const { action, text = '', track = 'agent', fp, type, sinceDays, projectId, topK, minWeight, fragmentTypes, includeArchived, dryRun, source } = args || {}
      const sessionId = exec.agent?.id
      if (action === 'add') {
        if (!text.trim()) return { ok: false, error: 'text 必填' }
        const g = await gateWrite(ctx, { track, text: text.trim(), agent: exec.agent, callId: exec.callId, signal: exec.signal })
        if (!g.approved) return { ok: false, error: `写入未获批准（${g.outcome || 'denied'}）——重要记忆需人工审批（可设置 approvalFallback=auto 自动保存）` }
        const r = writeEntry({ track, text: text.trim(), sessionId, approved: g.mode === 'ask', mode: g.mode, source, realm: realmFor(sessionId) })
        // v0.8.0：近似重复（写入去重）——已自动合并进已有条目，或（skip 模式）只提示不写
        if (r.merged) {
          return {
            ok: true,
            ...r,
            mode: g.mode,
            note: `已合并进已有条目 [fp:${r.fp}]（相似度 ${r.similar.score}，追加「补充·日期」并提权）——未新增碎片条目。`,
          }
        }
        if (r.skipped && r.reason === 'near-duplicate') {
          return {
            ok: true,
            ...r,
            mode: g.mode,
            note: `未新增：与已有条目 [fp:${r.similar.fp}] 高度相似（${r.similar.score}）。请改用 memory action=update fp="${r.similar.fp}" text="合并后的完整内容"，避免同一件事留下多条碎片记忆。`,
          }
        }
        return { ok: true, ...r, mode: g.mode }
      }
      if (action === 'query') {
        const fts = typeof fragmentTypes === 'string' && fragmentTypes.trim()
          ? fragmentTypes.split(',').map((s) => s.trim()).filter(Boolean)
          : undefined
        return { ok: true, entries: await queryEntries(text, topK || CFG.maxQueryResults, { projectId, topK: topK || CFG.maxQueryResults, minWeight, fragmentTypes: fts, includeArchived }) }
      }
      if (action === 'list') return { ok: true, entries: await queryEntries('', topK || 200) }
      if (action === 'update') {
        if (!fp || !String(text ?? '').trim()) return { ok: false, error: 'fp 与 text 必填（先 list/query 找到指纹）' }
        const r = updateEntryText(fp, String(text).trim())
        return r.ok ? { ok: true, note: r.note || `已更新 [fp:${fp}]`, fp } : r
      }
      if (action === 'remove') {
        if (!fp) return { ok: false, error: 'fp 必填（先 query 找到指纹）' }
        const r = removeEntry(fp)
        // v0.11：remove 现在是墓碑（行还在库里），不再依赖备份文件回滚
        return r.ok ? { ok: true, note: `已删除 [fp:${fp}]（墓碑，未物理删除；/memory undo ${fp} 或 memory action=restore 可回滚；确需抹除用 purge）` } : r
      }
      if (action === 'purge') {
        if (!fp) return { ok: false, error: 'fp 必填（先 query 找到指纹）' }
        const r = purgeEntry(fp)
        return r.ok ? { ok: true, note: `已物理删除 [fp:${fp}]（不可逆；不留备份副本，需要事前快照请先 dump）` } : r
      }
      if (action === 'used') {
        if (!fp) return { ok: false, error: 'fp 必填' }
        const r = markUsed(fp)
        return r.ok ? { ok: true, note: `已记一次真实使用 [fp:${fp}]（累计 ${r.hits} 次）` } : r
      }
      if (action === 'restore') {
        if (!fp) return { ok: false, error: 'fp 必填' }
        const r = restoreEntry(fp)
        return r.ok ? { ok: true, note: r.note || `已回滚 [fp:${fp}]（来源备份：${r.backup}）` } : r
      }
      if (action === 'pin' || action === 'unpin') {
        if (!fp) return { ok: false, error: 'fp 必填（先 query 找到指纹）' }
        const r = setPin(fp, action === 'pin')
        return r.ok ? { ok: true, note: `已${action === 'pin' ? '锁定' : '解锁'} [fp:${fp}]` } : r
      }
      if (action === 'compact') {
        const r = compact({ dryRun: dryRun === true })
        const head = `${dryRun === true ? '【预览】' : ''}扫描 ${r.scanned} 条：墓碑 ${r.tombstoned} · 降权 ${r.decayed} · 锁定豁免 ${r.skippedPinned}${r.backup ? ` · 备份 ${r.backup}` : ''}`
        return { ok: true, note: r.log.length ? `${head}\n${r.log.slice(0, 15).join('\n')}` : head }
      }
      if (action === 'dump') {
        const r = dump()
        return { ok: true, note: `已导出 ${r.total} 条到 ${r.file}（工作流链 ${r.chains} 条）` }
      }
      return { ok: false, error: '未知 action' }
    },
  }
}

function makeRecallTool() {
  return {
    name: 'memory_recall',
    description: '跨会话记忆召回：查询长期记忆体与项目档案（与 memory query 相同，语义上用于"你还记得…吗"场景）',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string', description: '查询关键词' } },
      required: ['text'],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          entries: {
            type: 'array',
            items: { type: 'object', properties: { layer: { type: 'string' }, text: { type: 'string' } }, additionalProperties: true },
          },
        },
        required: ['ok'],
      },
      render(args, value) {
        if (!Array.isArray(value.entries) || !value.entries.length) return [{ type: 'text', text: '（无匹配记忆）' }]
        return [{ type: 'text', text: value.entries.map((e) => `- [${e.layer}]${e.memory_class ? `[${e.memory_class}]` : ''} ${e.text}`).join('\n') }]
      },
    },
    presentCall(args) {
      return { card: 'generic', title: '记忆召回', kind: 'other', rawInput: args }
    },
    async execute(args) {
      return { ok: true, entries: queryEntries((args || {}).text || '') }
    },
  }
}

// ---------- 命令（官方可选服务模式：ctx.inject(['commands'], child => ...)） ----------

function registerMemoryCommand(ctx) {
  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.commands.register({
      name: 'memory',
      description: '记忆管理：list / query <词> / add <内容> / edit <fp> <新内容> / remove <fp> / purge <fp> / undo <fp> / used <fp> / pin <fp> / unpin <fp> / unarchive <fp> / entries [词] / stats / why <fp> / preview / compact [--dry-run] / dump / help',
      handler(invocation) {
        const { rawInput, agent } = invocation
        const tokens = (rawInput || '').trim().split(/\s+/)
        const verb = tokens[0]
        const rest = tokens.slice(1)
        const sessionId = agent?.id
        if (verb === 'list') {
          const es = queryEntries('')
          return { kind: 'success', text: es.length ? es.map((e) => `- [${e.layer}]${e.memory_class ? `[${e.memory_class}]` : ''} ${e.text}`).join('\n') : '（记忆为空）' }
        }
        if (verb === 'query') {
          const q = rest.join(' ')
          const es = queryEntries(q)
          return { kind: 'success', text: es.length ? es.map((e) => `- [${e.layer}]${e.memory_class ? `[${e.memory_class}]` : ''} ${e.text}`).join('\n') : `（无匹配：${q}）` }
        }
        if (verb === 'add') {
          if (!rest.length) return { kind: 'success', text: '用法: /memory add <内容>' }
          const q = rest.join(' ')
          const r = writeEntry({ track: 'agent', text: q, sessionId, approved: true })
          return { kind: 'success', text: r.skipped ? '重复，已跳过' : `已保存 [fp:${r.fp}]（人类发起）` }
        }
        if (verb === 'edit') {
          const fp = rest[0]
          const content = rest.slice(1).join(' ')
          if (!fp || !content) return { kind: 'success', text: '用法: /memory edit <fp> <新内容>' }
          const r = updateEntryText(fp, content)
          return { kind: 'success', text: r.ok ? (r.note || `已更新 [fp:${fp}]`) : r.error }
        }
        if (verb === 'remove') {
          const fp = rest[0]
          if (!fp) return { kind: 'success', text: '用法: /memory remove <fp>' }
          const r = removeEntry(fp)
          return { kind: 'success', text: r.ok ? `已删除 [fp:${fp}]（墓碑，未物理删除；/memory undo ${fp} 可回滚；确需抹除用 /memory purge ${fp}）` : r.error }
        }
        if (verb === 'purge') {
          const fp = rest[0]
          if (!fp) return { kind: 'success', text: '用法: /memory purge <fp>（物理删除，不可逆）' }
          const r = purgeEntry(fp)
          return { kind: 'success', text: r.ok ? `已物理删除 [fp:${fp}]（不可逆；不留备份副本）` : r.error }
        }
        if (verb === 'used') {
          const fp = rest[0]
          if (!fp) return { kind: 'success', text: '用法: /memory used <fp>' }
          const r = markUsed(fp)
          return { kind: 'success', text: r.ok ? `已记一次真实使用 [fp:${fp}]（累计 ${r.hits} 次）` : r.error }
        }
        if (verb === 'unarchive') {
          const fp = rest[0]
          if (!fp) return { kind: 'success', text: '用法: /memory unarchive <fp>' }
          const r = unarchiveEntry(fp)
          return { kind: 'success', text: r.ok ? `已取消归档 [fp:${fp}]` : r.error }
        }
        // ---- v0.11：可观测性三件套（记忆类产品的一切问题最终都是信任问题） ----
        if (verb === 'stats') {
          const h = db.health()
          const s = db.stats()
          const fmt = (o) => Object.entries(o).map(([k, v]) => `${k}:${v}`).join(' ') || '无'
          return {
            kind: 'success',
            text: [
              `活跃记忆 ${h.active} 条（锁定 ${h.pinned}）· 墓碑 ${h.tombstoned} · 归档 ${h.archived} · 工作流链 ${h.chains}`,
              `trigger 覆盖率 ${h.triggerCoverage}% —— ${h.active - h.noTrigger} 条可被触发召回命中；**${h.noTrigger} 条没有任何 trigger**，只能靠偏好/决定通道或常驻快照出场`,
              `类型分布：${fmt(h.byType)}`,
              `realm 分布：${fmt(h.byRealm)}`,
              `库文件：${s.dbPath}`,
            ].join('\n'),
          }
        }
        if (verb === 'why') {
          const fp = rest[0]
          if (!fp) return { kind: 'success', text: '用法: /memory why <fp>' }
          const r = explain(fp, currentSignal())
          return { kind: 'success', text: r.ok ? r.reasons.map((x, i) => `${i + 1}. ${x}`).join('\n') : r.error }
        }
        if (verb === 'preview') {
          const r = buildInjection(currentSignal())
          if (!r.text) return { kind: 'success', text: '（本次会话信号没有命中任何记忆，也不会注入任何内容）' }
          return {
            kind: 'success',
            text: [
              r.text,
              '',
              `> realm=${r.realm} · 共 ${r.items.length} 条 / ${r.chars} 字符（偏好通道 ${r.decisionItems.length} · 触发命中 ${r.triggerItems.length} · 冷启动 ${r.coldItems.length}）`,
              r.triggers.length ? `> 命中信号：${r.triggers.join(' ')}` : '> 命中信号：无',
            ].join('\n'),
          }
        }
        if (verb === 'help') {
          return { kind: 'success', text: [
            '/memory list —— 列出全部活跃记忆',
            '/memory query <词> —— 关键词查询（命中会记一次真实使用）',
            '/memory add <内容> —— 写入一条',
            '/memory edit <fp> <新内容> / entries [词] —— 编辑 / 带元数据浏览',
            '/memory remove <fp> —— 标墓碑（可 undo 回滚）',
            '/memory purge <fp> —— **物理删除**（不可逆，不留备份副本）',
            '/memory undo <fp> / unarchive <fp> —— 回滚墓碑 / 取消归档',
            '/memory used <fp> —— 标记"这条刚才真的用上了"（推进 last_used）',
            '/memory pin <fp> / unpin <fp> —— 锁定（不遗忘、豁免清理）/ 解锁',
            '/memory stats —— 健康度（含 trigger 覆盖率）',
            '/memory why <fp> —— 这条记忆为什么（不）会被注入',
            '/memory preview —— 预览本次会话会注入什么',
            '/memory compact [--dry-run] / dump —— 清理 / 导出 Markdown',
          ].join('\n') }
        }
        if (verb === 'undo') {
          const fp = rest[0]
          if (!fp) return { kind: 'success', text: '用法: /memory undo <fp>' }
          const r = restoreEntry(fp)
          return { kind: 'success', text: r.ok ? `已回滚 [fp:${fp}]（来源备份：${r.backup}）` : r.error }
        }
        if (verb === 'entries') {
          const q = rest.join(' ')
          const es = queryEntries(q, 50).map((e) => {
            const meta = []
            if (e.weight !== undefined) meta.push(`w${e.weight}`)
            if (e.hits !== undefined) meta.push(`h${e.hits}`)
            if (e.ts) meta.push(e.ts)
            if (e.pinned) meta.push('PIN')
            return `- [${e.layer}] [${meta.join(' ')}] ${e.text}`
          })
          return { kind: 'success', text: es.length ? es.join('\n') : (q ? `（无匹配：${q}）` : '（记忆为空）') }
        }
        if (verb === 'pin' || verb === 'unpin') {
          const fp = rest[0]
          if (!fp) return { kind: 'success', text: `用法: /memory ${verb} <fp>` }
          const r = setPin(fp, verb === 'pin')
          return { kind: 'success', text: r.ok ? `已${verb === 'pin' ? '锁定' : '解锁'} [fp:${fp}]` : r.error }
        }
        if (verb === 'compact') {
          const dry = rest.includes('--dry-run')
          const r = compact({ dryRun: dry })
          const head = `${dry ? '【预览】' : ''}扫描 ${r.scanned} 条：墓碑 ${r.tombstoned} · 降权 ${r.decayed} · 锁定豁免 ${r.skippedPinned}${r.backup ? ` · 备份 ${r.backup}` : ''}`
          return { kind: 'success', text: r.log.length ? `${head}\n${r.log.slice(0, 15).join('\n')}` : head }
        }
        if (verb === 'dump') {
          const r = dump()
          return { kind: 'success', text: `已导出 ${r.total} 条到 ${r.file}（工作流链 ${r.chains} 条）` }
        }
        return { kind: 'success', text: '用法: /memory help（查看全部子命令）｜常用：list / query <词> / add <内容> / remove <fp> / stats / why <fp> / preview / compact' }
      },
    })
  })
}

// ---------- 按需抽取（v0.8.1，用户拍板：按钮触发、不做后台自动抽取以省 token） ----------
// 数据来源走官方契约：ctx.sessions.get(id).deriveMessages()（模型可见历史，不碰会话日志文件）；
// 模型调用走官方 LLM 服务 ctx.llm.stream({provider, model, messages})（复用 DSH 现有提供方）。
// 提取到的候选交给 store.writeEntry —— 与手工写入共用同一套指纹去重、近重复合并与审计。

// ---------- 插件挂载 ----------

export function apply(ctx, config = {}) {
  ensureDirs()
  // v0.5：SQLite 初始化 + Markdown 一次性迁移（meta 幂等）
  let migrateResult = null
  try {
    migrateResult = migrateMarkdownToDb()
    if (migrateResult.migrated) dbgLog(`migrate: imported=${migrateResult.imported}`)
  } catch (err) {
    dbgLog(`migrate failed: ${String(err && err.message || err)}`)
  }
  // v0.11：指纹算法升级（前 20 字 → 全文 sha1）后的一次性重算，只跑一次。
  // 不重算的话，旧库里那些因前 20 字撞车而"看起来重复"的条目会一直保持坏 fp。
  try {
    const fpMigrate = migrateFingerprints()
    if (fpMigrate.migrated) dbgLog(`fingerprint migration: changed=${fpMigrate.changed} deduped=${fpMigrate.deduped}`)
  } catch (err) {
    dbgLog(`fingerprint migration failed: ${String(err && err.message || err)}`)
  }
  // 配置优先级：bundle 传入 config > 持久化 biomemory.config.json > 默认值
  const persisted = loadConfig()
  setConfig({ ...DEFAULTS, ...persisted, ...(typeof config === 'object' && config ? config : {}) })
  selfHeal()
  dbgLog('=== apply 执行 ===')

  // v0.8.1：按需抽取要用到的宿主服务——懒注入，服务缺失时接口返回明确错误而不是崩

  // 1. 动态记忆上下文（每次对话/新会话组装提示词时自动重新求值 → 最新记忆同步）
  ctx.systemPrompt.context({
    name: 'memory:snapshot',
    order: -50,
    text: () => renderSnapshot(),
  })

  // 1.2 v2 触发式召回：本次会话的信号命中了才注入，没命中不占 token
  ctx.systemPrompt.context({
    name: 'memory:triggered',
    order: -40,
    text: () => recallSectionText(),
  })

  // 1.5 会话结束自动沉淀（v0.6）：turn/end(completed) 后注入总结指令
  // v0.11：这里的 catch 是**静默**的——一旦宿主不暴露 session/event，触发式召回与自动沉淀
  // 会一起失效且毫无提示。补偿手段放在 recallSectionText()：从未收到事件时 warn 一次，
  // 用户可用 /memory preview 与 /memory stats 自查。
  try {
    ctx.on('session/event', (session, rawEvent) => {
      handleSessionEvent(session, rawEvent)
      noteSignal(session, rawEvent)
    }, { global: true })
    ctx.systemPrompt.section({
      name: 'memory:session-summary',
      order: 200,
      text: () => sessionSummarySectionText(),
    })
  } catch {
    // 会话事件/提示词注入不可用则静默降级（不影响记忆读写）
  }

  // 2. memory 工具 + memory_recall 工具
  ctx.tools.register(makeMemoryTool(ctx))
  ctx.tools.register(makeRecallTool())

  // 3. /memory 命令（可选服务，commands 缺失自动跳过）
  registerMemoryCommand(ctx)

  // 4. 设置页 Web API（官方契约：ctx.webServer.register，kind=prefix；webServer 缺失时自动跳过）
  ctx.inject(['webServer'], (httpCtx) => {
    httpCtx.effect(() => httpCtx.webServer.register({
      kind: 'prefix',
      path: '/biomemory/api',
      handler: async (req, res) => {
        const url = new URL(req.url ?? '/', 'https://dsh.invalid')
        const p = url.pathname.replace(/^\/biomemory\/api/, '') || '/'
        res.setHeader('content-type', 'application/json; charset=utf-8')
        const send = (code, body) => {
          res.statusCode = code
          res.end(JSON.stringify(body))
        }
        try {
          // v0.11：来源校验。端点默认不接受跨站请求（详见 requestAllowed 注释）。
          if (!requestAllowed(req)) {
            return send(403, { ok: false, error: 'forbidden: 跨站请求被拒绝。如需放开请设置 DSH_MEMORY_API_ORIGINS，或 DSH_MEMORY_API_NOAUTH=1 关闭校验。' })
          }
          if (req.method === 'GET' && p === '/status') {
            const s = db.stats()
            const conn = db.openDb()
            const byType = conn.prepare('SELECT fragment_type AS k, COUNT(*) AS c FROM entries GROUP BY fragment_type ORDER BY c DESC').all().map((r) => ({ key: r.k, count: r.c }))
            const byWeight = conn.prepare("SELECT CASE WHEN weight >= 10 THEN '10+' WHEN weight >= 5 THEN '5-9' WHEN weight >= 3 THEN '3-4' ELSE '<3' END AS k, COUNT(*) AS c FROM entries GROUP BY k ORDER BY c DESC").all().map((r) => ({ key: r.k, count: r.c }))
            return send(200, { ok: true, stats: { total: s.total, pinned: s.pinned, layers: s.layers, status: s.status, memoryRoot: MEMORY_ROOT, dbPath: s.dbPath, migration: db.migrationStatus(), byType, byWeight }, health: db.health(), config: CFG })
          }
          if (req.method === 'GET' && p === '/config') {
            return send(200, { ok: true, config: CFG })
          }
          if (req.method === 'POST' && p === '/config') {
            let body = {}
            try { body = JSON.parse(await readBody(req)) } catch { /* ignore */ }
            const allowed = ['decayThreshold', 'weightCap', 'hotTokenLimit', 'maxQueryResults', 'approvalFallback', 'nearDuplicateThreshold', 'nearDuplicateAction', 'sinkWindowMinutes', 'decisionChannelMax', 'decisionChannelChars', 'coldStartFallbackMax']
            if (body.reset === true) {
              try { fs.unlinkSync(PATHS.config) } catch { /* ignore */ }
              setConfig({ ...DEFAULTS })
                          return send(200, { ok: true, config: CFG, reset: true })
            }
            const next = { ...CFG }
            for (const k of allowed) {
              if (body[k] !== undefined) {
                // v0.8.2（真机实测踩坑）：新增的**字符串/布尔**配置必须按类型落库。
                // 旧代码除 approvalFallback 外一律 Number()，于是：
                if (k === 'approvalFallback') next[k] = body[k] === 'auto' ? 'auto' : 'deny'
                else if (k === 'nearDuplicateAction') next[k] = body[k] === 'skip' ? 'skip' : 'merge'
                else {
                  const v = Number(body[k])
                  if (Number.isFinite(v) && v >= 0) next[k] = v
                }
              }
            }
            setConfig(next)
                      saveConfig(CFG)
            return send(200, { ok: true, config: CFG })
          }
          if (req.method === 'GET' && p === '/entries') {
            const q = url.searchParams.get('q') || ''
            const layer = url.searchParams.get('layer') || ''
            const limit = Math.min(500, Number(url.searchParams.get('limit')) || 200)
            if (q) {
              // v0.6.5：带 q 时也应用 layer 筛选；queryEntries 已补齐 hits/pinned/mode/ts/kind
              const res = await queryEntries(q, limit, { minWeight: 0, layer: layer || undefined })
              const seen = new Set()
              const merged = []
              for (const r of res) {
                if (seen.has(r.fp)) continue
                seen.add(r.fp)
                merged.push({ layer: r.layer, fp: r.fp, kind: r.kind, mode: r.mode, weight: r.weight, hits: r.hits, ts: r.ts, pinned: r.pinned, text: r.text, fragment_type: r.fragment_type, status: entryStatus(r) })
              }
              return send(200, { ok: true, entries: merged.slice(0, limit) })
            }
            const all = db.listEntries({ layer: layer || undefined, limit: 1000 })
              .map((e) => ({ layer: e.layer, fp: e.fp, kind: e.kind, mode: e.mode, weight: e.weight, hits: e.hits, ts: e.created_at, pinned: e.pinned, text: e.text, fragment_type: e.fragment_type, status: entryStatus(e) }))
            all.sort((a, b) => (b.pinned - a.pinned) || (b.weight - a.weight) || String(b.ts || '').localeCompare(String(a.ts || '')))
            return send(200, { ok: true, entries: all.slice(0, limit) })
          }
          if (req.method === 'POST' && p === '/entries/pin') {
            let body = {}
            try { body = JSON.parse(await readBody(req)) } catch { /* ignore */ }
            if (!body.fp) return send(400, { ok: false, error: 'fp 必填' })
            const r = setPin(body.fp, true)
            return r.ok ? send(200, { ok: true, fp: r.fp, pinned: true }) : send(404, r)
          }
          if (req.method === 'POST' && p === '/entries/unpin') {
            let body = {}
            try { body = JSON.parse(await readBody(req)) } catch { /* ignore */ }
            if (!body.fp) return send(400, { ok: false, error: 'fp 必填' })
            const r = setPin(body.fp, false)
            return r.ok ? send(200, { ok: true, fp: r.fp, pinned: false }) : send(404, r)
          }
          if (req.method === 'POST' && p === '/entries/remove') {
            let body = {}
            try { body = JSON.parse(await readBody(req)) } catch { /* ignore */ }
            if (!body.fp) return send(400, { ok: false, error: 'fp 必填' })
            const r = removeEntry(body.fp)
            return r.ok ? send(200, { ok: true, fp: r.fp, backup: r.backup }) : send(404, r)
          }
          if (req.method === 'POST' && p === '/entries/restore') {
            let body = {}
            try { body = JSON.parse(await readBody(req)) } catch { /* ignore */ }
            if (!body.fp) return send(400, { ok: false, error: 'fp 必填' })
            const r = restoreEntry(body.fp)
            return r.ok ? send(200, { ok: true, fp: r.fp, text: r.text, backup: r.backup }) : send(404, r)
          }
          if (req.method === 'POST' && p === '/entries/update') {
            let body = {}
            try { body = JSON.parse(await readBody(req)) } catch { /* ignore */ }
            if (!body.fp || !String(body.text ?? '').trim()) return send(400, { ok: false, error: 'fp 与 text 必填' })
            const r = updateEntryText(body.fp, body.text)
            return r.ok ? send(200, { ok: true, fp: r.fp, text: r.text, note: r.note }) : send(404, r)
          }
          return send(404, { ok: false, error: 'not found' })
        } catch (err) {
          return send(500, { ok: false, error: String(err && err.message || err) })
        }
      },
    }), 'dsh-memory-layer: settings web API')
  })
}

// ---------- 测试用内部接口（不参与 DSH 装配） ----------

export const __internals = {
  MEMORY_ROOT,
  parseEntryLine,
  formatEntryLine,
  fingerprint,
  isImportant,
  estimateTokens,
  zhBigrams,
  consolidateHits,
  removeEntry,
  purgeEntry,
  markUsed,
  restoreEntry,
  unarchiveEntry,
  updateEntryText,
  entryStatus,
  tokenize,
  queryEntries,
  compact,
  dump,
  recallBySignals,
  buildInjection,
  explain,
  health: db.health,
  migrateFingerprints,
  setPin,
  scanAllFiles,
  migrateMarkdownToDb,
  sessionSummarySectionText,
  handleSessionEvent,
  markSummaryPending,
  clearSummaryPending,
  setConfig: (c) => { setConfig(c) },
  getConfig: () => ({ ...CFG }),
  requestAllowed,
  realmFor,
  currentSignal,
  paths: PATHS,
}
