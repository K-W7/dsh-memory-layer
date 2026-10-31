// ============================================================================
// time.test.mjs —— 写入时的绝对日期提醒（v0.11.3，零依赖）
//
// ① needsAbsoluteDate 纯函数：命中 / 带锚点不提醒 / 「最近目前现在」不触发 / 空串英文不崩
// ② 集成：memory action=add / update 命中时，成功返回的 note 里确实带提醒，写入照常成功
//
// 每个测试用独立临时库（DSH_MEMORY_ROOT / DSH_BIOMEMORY_DIR），不碰用户数据。
// ============================================================================

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'biomem-time-'))
process.env.DSH_MEMORY_ROOT = tmpDir
process.env.DSH_BIOMEMORY_DIR = path.join(tmpDir, 'biomemory')

const { needsAbsoluteDate } = await import('../time.mjs')
const { apply } = await import('../index.mjs')
const { closeDb } = await import('../db.mjs')

after(() => {
  closeDb()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

// ---------- ① 纯函数 ----------

test('needsAbsoluteDate：命中相对时间词', () => {
  assert.equal(needsAbsoluteDate('今天把构建脚本跑了一遍'), '今天')
  assert.equal(needsAbsoluteDate('昨天的问题已修'), '昨天')
  assert.equal(needsAbsoluteDate('下周再对这个流程'), '下周')
  assert.equal(needsAbsoluteDate('今年改用 node:sqlite'), '今年')
})

test('needsAbsoluteDate：带绝对日期锚点就不提醒', () => {
  assert.equal(needsAbsoluteDate('2026-10-31 今天把构建脚本跑了一遍'), null)
  assert.equal(needsAbsoluteDate('10月31日 昨天的问题已修'), null)
  assert.equal(needsAbsoluteDate('2026年定的规矩'), null)
})

test('needsAbsoluteDate：「最近 / 目前 / 现在」不触发', () => {
  assert.equal(needsAbsoluteDate('最近在整理记忆'), null)
  assert.equal(needsAbsoluteDate('目前只有这一条'), null)
  assert.equal(needsAbsoluteDate('现在跑得通'), null)
})

test('needsAbsoluteDate：空串 / 英文 / 非字符串不崩', () => {
  assert.equal(needsAbsoluteDate(''), null)
  assert.equal(needsAbsoluteDate('   '), null)
  assert.equal(needsAbsoluteDate(undefined), null)
  assert.equal(needsAbsoluteDate(null), null)
  assert.equal(needsAbsoluteDate(12345), null)
  assert.equal(needsAbsoluteDate('shipped the plugin today'), null)
})

// ---------- ② memory 工具集成 ----------

function fakeCtx() {
  const tools = new Map()
  return {
    ctx: {
      systemPrompt: { context() {}, section() {} },
      on() {},
      effect() {},
      inject() {},
      get() { return undefined },
      tools: { register(tool) { tools.set(tool.name, tool) } },
    },
    tool: () => tools.get('memory'),
  }
}

test('add / update 命中相对时间时，成功返回的 note 里带日期提醒', async () => {
  const { ctx, tool } = fakeCtx()
  apply(ctx, {})

  const add = await tool().execute({ action: 'add', text: '今天把构建脚本跑了一遍' }, {})
  assert.equal(add.ok, true, '写入照常成功')
  assert.match(String(add.note), /建议补绝对日期/)

  const anchored = await tool().execute({ action: 'add', text: '2026-10-31 把构建脚本跑了一遍' }, {})
  assert.equal(anchored.ok, true)
  assert.ok(!String(anchored.note || '').includes('建议补绝对日期'), '带锚点不提醒')

  const upd = await tool().execute({ action: 'update', fp: anchored.fp, text: '昨天把构建脚本又跑了一遍' }, {})
  assert.equal(upd.ok, true, 'update 照常成功')
  assert.match(String(upd.note), /建议补绝对日期/)
})
