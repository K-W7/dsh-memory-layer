// ============================================================================
// dsh-memory-layer · 写入时的绝对日期校验（time.mjs，零依赖纯函数）
//
// v0.11.3：写入（add / update）的正文里出现「今天 / 昨天 / 下周」这类相对时间，
// 却没给任何日期锚点时，返回命中的词——调用方据此在成功返回里附一行提醒。
// 只是提醒，不拒绝写入：拒绝会丢信息，而且相对时间有时就是当事人能给出的全部。
//
// 刻意不做：
//   - 「最近 / 目前 / 现在」不触发——它们常常就是诚实的精度，不是缺锚点。
//   - 不做时间推断（今天=哪天）：插件不知道写入时的本地日期上下文，猜错比不猜更糟。
// ============================================================================

/** 相对时间词（只有这些；不含「最近/目前/现在」）。顺序即返回优先级。 */
export const RELATIVE_TIME_WORDS = [
  '今天', '昨天', '明天', '后天', '前天',
  '本周', '这周', '上周', '下周',
  '这个月', '上个月', '下个月',
  '今年', '去年', '明年',
]

/** 绝对日期锚点：2026-10-31 / 10月31日 / 2026年 */
const ANCHOR_PATTERNS = [
  /\d{4}-\d{2}-\d{2}/,      // YYYY-MM-DD
  /\d{1,2}\s*月\s*\d{1,2}\s*日/, // M月D日
  /20\d{2}\s*年/,           // YYYY年（只认 20xx，避免把「3年」当锚点）
]

/**
 * 正文含相对时间且没有任何日期锚点时，返回第一个命中的相对时间词；否则 null。
 * @param {unknown} text
 * @returns {string|null}
 */
export function needsAbsoluteDate(text) {
  const s = String(text ?? '')
  if (!s.trim()) return null
  for (const re of ANCHOR_PATTERNS) if (re.test(s)) return null
  for (const w of RELATIVE_TIME_WORDS) if (s.includes(w)) return w
  return null
}
