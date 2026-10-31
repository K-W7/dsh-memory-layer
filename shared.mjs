// ============================================================================
// dsh-memory-layer · 共享基础（shared.mjs）—— 配置 / 常量 / 基础工具 / 审计
//
// 从 index.mjs 拆出（v0.6 架构升级）：配置默认值与持久化、路径常量、
// 纯工具函数（文件读写/时间/指纹/重要性判断/token 估算）、审计写入。
// 供 store/retrieve/meta/snapshot/gate/interface 各模块复用，避免循环依赖。
// ============================================================================

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import * as db from './db.mjs'

// 记忆根目录：默认 ~/.dsh/memory（可用环境变量 DSH_MEMORY_ROOT 覆盖）
// v0.5：SQLite 为主存储（~/.dsh/biomemory/biomemory.db）。
// v0.6.1：单轨制——SQLite 是唯一运行时数据源；Markdown（hot/projects/longterm/
// preferences）保留为只读备份与人工查看层，不再参与任何运行时写入/读取
// （仅首次启动的一次性历史迁移会读它，之后永不读取）。
export const MEMORY_ROOT = process.env.DSH_MEMORY_ROOT || path.join(os.homedir(), '.dsh', 'memory')

export const TOOL_NAME = 'memory'
export const REQUEST_MARKER = '[dsh-memory-layer]'

// ---------- 配置（默认值，可在 apply(config) 覆盖） ----------

export const DEFAULTS = {
  decayThreshold: 3,      // 权重低于此值 → 状态页标「待处理」（v0.10.0 起不再自动归档，归档只由 compact 五条规则决定）
  weightCap: 20,          // 权重上限（防膨胀）
  hotTokenLimit: 2000,    // 快照注入 token 上限（v0.11：5000→2000。快照是常驻注入，触发召回才是
                          // 精准通道；旧默认让"每轮固定开销"占了 token 大头，与"没命中就不占
                          // token"的印象相反。想恢复全量注入可自行调大）
  maxQueryResults: 20,    // 查询返回上限
  approvalFallback: 'deny', // v0.6.5 起默认 deny（fail-closed）：审批服务缺失/请求异常/非授予结果 → 拒绝写入并记审计；auto=自动保存并审计（旧行为，需显式设置）
  nearDuplicateThreshold: 0.7, // v0.8.0：写入去重——与已有同类条目的中文 bigram Jaccard ≥ 此值时不再新增（0=关闭；
                               // 实测「换了说法的同一件事」约 0.7~0.8，完全改写才会低于 0.6）
  nearDuplicateAction: 'merge', // v0.8.0：命中近重复怎么办——merge=合并进已有条目（追加「补充·日期」并提权，借鉴 @zheexinn/dsh-memory）/ skip=只提示不写
  sinkWindowMinutes: 5,   // v0.8.0：轮次结束后的「请沉淀」提醒有效窗口（分钟，可配）。
                          // 语义：一轮结束后短暂窗口内注入一次催促；超过窗口即丢弃（下一轮重新判断），
                          // 避免用户隔很久再发消息时被一条过期的「上一轮请沉淀」打扰。
  // ---- v0.11：偏好/决定独立通道与冷启动兜底 ----
  // 触发式召回只能命中含文件名/错误代号的记忆，而"偏好/决定"是纯自然语言（实测 8 条里
  // 6 条无任何 trigger），它们只能靠常驻快照出场、并随记忆增长被挤出预算。
  // 这里给 decision/preference 一条独立小预算，不与触发召回抢 1200 字符。
  decisionChannelMax: 3,  // 偏好/决定通道每轮最多注入条数（0=关闭）
  decisionChannelChars: 400, // 偏好/决定通道每轮字符预算（0=关闭）
  // 冷启动：库里还没攒出 trigger 关联时，召回层等于不存在，用户会觉得"没用"。
  // 活跃条目少于此值且本次零命中 → 回落注入最近写入的 N 条（仍受预算约束）。
  coldStartFallbackMax: 3, // 0=关闭冷启动兜底
  // ---- v0.11.3：宿主注入开关（默认 true，保持现行为） ----
  // 退成纯数据层（只存只查、不进 prompt）时三个全置 false；apply 时读取，
  // 改完需重启宿主或重载插件才生效。false = 对应段根本不注册，不留空段占位。
  injectSnapshot: true,   // 记忆快照段（systemPrompt.context，order -50）
  injectRecall: true,     // 触发式召回段（systemPrompt.context，order -40）
  injectSummary: true,    // 轮次结束沉淀提醒段（systemPrompt.section，order 200）
}

// 冲突阈值从配置读取（模块加载时为默认，apply 时更新）

export let CFG = { ...DEFAULTS }

// ESM 导出不可被导入方赋值：统一经 setter 修改（index/各模块一致）
export function setConfig(next) {
  CFG = { ...DEFAULTS, ...(next ?? {}) }
}
export function getConfig() {
  return { ...CFG }
}

// ---------- 数据层：Markdown 文件读写（透明、可读改） ----------

export const PATHS = {
  hotBehavior: path.join(MEMORY_ROOT, 'hot', 'behavior.md'),
  hotKnowledge: path.join(MEMORY_ROOT, 'hot', 'knowledge.md'),
  preferences: path.join(MEMORY_ROOT, 'preferences.md'),
  audit: path.join(MEMORY_ROOT, 'audit.log'),       // 旧版人类可读审计（兼容）
  auditJson: path.join(MEMORY_ROOT, 'audit.jsonl'), // v0.3 结构化审计
  archive: path.join(MEMORY_ROOT, 'archive'),
  backups: path.join(MEMORY_ROOT, 'backups'),
  config: path.join(MEMORY_ROOT, 'biomemory.config.json'), // 持久化配置（设置页写入，透明可改）
}

// 宽松布尔：只认 true/false、'true'/'false'、1/0、'1'/'0'；其余返回 undefined（保持默认）
export function toBoolean(v) {
  if (v === true || v === 1 || v === '1' || v === 'true') return true
  if (v === false || v === 0 || v === '0' || v === 'false') return false
  return undefined
}

// 配置持久化：从 biomemory.config.json 读取（不存在则用默认）
export function loadConfig() {
  try {
    const raw = readFile(PATHS.config)
    if (!raw.trim()) return { ...DEFAULTS }
    const saved = JSON.parse(raw)
    const merged = { ...DEFAULTS }
    // 2026-09-24 修复（根因：读路径只认数值，非数值字段一律被 continue 丢掉）：
    //   旧实现一律 Number()，于是 approvalFallback='auto'→Number=NaN→丢弃→落回
    //   默认 'deny'（fail-closed 意外生效，重要记忆写入被静默拒绝）；extractProvider/extractModel
    //   这类字符串被清空（按需抽取永久报「未配置抽取模型」）；preloadEmbeddings=true→丢弃→false
    //   （预热失效）；nearDuplicateAction='skip'→丢弃→merge；autoDreamDays=3 能读但 0 会被丢。
    //   ★教训：写路径按类型处理时，读路径必须逐字段对齐同一套类型规则——两处只改一处等于没改。
    for (const k of Object.keys(DEFAULTS)) {
      const v = saved[k]
      if (v === undefined) continue
      switch (k) {
        case 'approvalFallback':
          // 枚举：只认 'auto'（自动写入）/'deny'（fail-closed），其余保持默认
          if (v === 'auto' || v === 'deny') merged[k] = v
          break
        case 'nearDuplicateAction':
          merged[k] = v === 'skip' ? 'skip' : 'merge'
          break
        case 'injectSnapshot':
        case 'injectRecall':
        case 'injectSummary': {
          // v0.11.3：布尔项单独处理——旧 default 分支用 Number(v) > 0 判断，
          // false 会被当成「无效」丢掉并回落到默认 true，等于关不掉。
          const b = toBoolean(v)
          if (b !== undefined) merged[k] = b
          break
        }
        default:
          // 其余为数值项：只接受有限正数（保持原语义）
          if (Number.isFinite(Number(v)) && Number(v) > 0) merged[k] = Number(v)
          break
      }
    }
    return merged
  } catch {
    return { ...DEFAULTS }
  }
}

export function saveConfig(next) {
  const out = {}
  for (const k of Object.keys(DEFAULTS)) out[k] = next[k]
  writeFile(PATHS.config, JSON.stringify(out, null, 2))
}

export function ensureDirs() {
  for (const dir of [
    path.join(MEMORY_ROOT, 'hot'),
    path.join(MEMORY_ROOT, 'projects'),
    path.join(MEMORY_ROOT, 'longterm'),
    PATHS.archive,
    PATHS.backups,
  ]) {
    fs.mkdirSync(dir, { recursive: true })
  }
}

// "2026-08-16 13:00" → ISO
export function tsToIso(ts) {
  const m = String(ts).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/)
  if (!m) return null
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5])).toISOString()
}

// ---------- 纯工具 ----------

export function readFile(p) {
  try { return fs.readFileSync(p, 'utf-8') } catch { return '' }
}

export function writeFile(p, text) {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, text, 'utf-8')
}

export function appendFile(p, text) {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.appendFileSync(p, text, 'utf-8')
}

export function nowStamp() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

// 单轨制：偏好文本一律从 SQLite 读（v0.6.1 替代 readFile(PATHS.preferences)，
// 消除对 Markdown 的运行时依赖——手工编辑 Markdown 不再影响冲突检测）
export function prefsText() {
  db.openDb()
  const prefs = db.listEntries({ fragmentType: 'preference', status: 'active', limit: 500 })
  return prefs.map((e) => e.text).join('\n')
}

export function isoNow() { return new Date().toISOString() }

export function fingerprint(text) {
  // v0.11：全文 sha1 前 16 位。
  //
  // 旧实现取"去空白后的前 20 字"做 djb2：中文里 20 字极易撞车（同一决定的不同表述、
  // 同一流程的不同步骤、同一个文件名的多条教训），撞了之后 writeEntry 开头就判
  // `duplicate` 直接跳过——那条记忆**静默丢失**，模型只看到"重复记忆，已跳过"。
  // 指纹的职责应当只是"内容是否完全一致"；语义层面的近似重复交给 bigramSimilarity。
  const norm = String(text ?? '').replace(/\s+/g, '')
  if (!norm) return ''
  return crypto.createHash('sha1').update(norm, 'utf8').digest('hex').slice(0, 16)
}

/** realm 归一化：无 cwd 时为全局 'user'，否则为 project:<规范化工作目录> */
export function projectRealm(cwd) {
  const v = String(cwd ?? '').trim()
  if (!v) return 'user'
  return 'project:' + v.toLowerCase().replace(/\\/g, '/').replace(/\/+$/, '')
}

export function isImportant(text, track) {
  // 分级：用户偏好/项目决策/禁忌教训 = 重要（需审批）；普通事实 = 自动
  const importantHints = /偏好|喜欢|不要|禁止|必须|以后都|正式名|规则|决策|教训|踩坑|千万|千万别|禁忌|红线|不得/
  return track === 'user' || importantHints.test(text)
}

// 粗略 token 估算：中文字符≈1 token，其余按 4 字符/token
export function estimateTokens(s) {
  let zh = 0, other = 0
  for (const ch of s) {
    if (/[\u4e00-\u9fff\u3400-\u4dbf]/.test(ch)) zh++
    else other++
  }
  return zh + Math.ceil(other / 4)
}

// 调试开关：DSH_MEMORY_DEBUG=1 时输出诊断日志（2026-10-05：本行曾被误删，导致 apply() 抛 ReferenceError、插件整体不加载）
const DBG = process.env.DSH_MEMORY_DEBUG === '1'

export function dbgLog(msg) {
  if (!DBG) return
  // 2026-09-29 修复：此前 try 块是**空的** —— 函数体虽然存在，却什么都不输出，
  // 于是 DSH_MEMORY_DEBUG=1 形同虚设，且 dbgLog 的所有调用方一起静默失效：
  //   index.mjs 迁移/apply、gate.mjs 自愈失败、recall.mjs 触发召回……
  // 排查"插件没生效""召回没命中"这类问题时没有任何线索。现写 stderr
  // （不污染 stdout：宿主可能把 stdout 当协议通道）。
  try {
    console.error(`[dsh-memory-layer] ${msg}`)
  } catch { /* 忽略：日志失败绝不影响记忆本体 */ }
}

// ---------- 中文 bigram（去重 / 相似度共用） ----------

// 中文双字 bigram 集合（主题相似度/冲突检测共用）
export function zhBigrams(s) {
  const out = new Set()
  const chars = s.replace(/[^\u4e00-\u9fff]/g, '')
  for (let i = 0; i < chars.length - 1; i++) out.add(chars.slice(i, i + 2))
  return out
}

// 写入去重（v0.8.0）：中文 bigram Jaccard 相似度（0..1）——判断「即将写入的内容是否与已有条目高度重复」。
// 纯函数、零依赖、不触发嵌入模型，可安全地放在写入路径上同步调用。
// 写入去重实际使用的相似度：短文本上 Jaccard 偏严格（改几个字就掉到 0.6 以下），
// 因此在「两条长度相近（短/长 ≥ 0.6）」时取 Jaccard 与包含度 inter/min(|A|,|B|) 的较大者。
// 长度差太大时仍用 Jaccard，避免「短句被长条目完全包含」被误判成重复。
export function bigramSimilarity(a, b) {
  const A = zhBigrams(String(a || ''))
  const B = zhBigrams(String(b || ''))
  if (!A.size || !B.size) return 0
  let inter = 0
  for (const g of A) if (B.has(g)) inter++
  const jaccard = inter / (A.size + B.size - inter)
  const ratio = Math.min(A.size, B.size) / Math.max(A.size, B.size)
  if (ratio < 0.6) return jaccard
  return Math.max(jaccard, inter / Math.min(A.size, B.size))
}
