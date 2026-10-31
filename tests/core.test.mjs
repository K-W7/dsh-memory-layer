/**
 * 核心行为回归（零依赖，node:test）。
 *
 * 覆盖 0.11.0 里几条「语义边界」：
 *   ① remove 只是墓碑，行还在库里，restore 能直接复活；
 *   ② purge 是真删，且**不产生任何备份副本**（备份会把该消失的内容留在同一台机器上）；
 *   ③ compact 只改 status，**不产生备份副本**（墓碑本来就能 restore）；
 *   ④ 指纹迁移只跑一次，跑完的 fp 与 fingerprint() 一致。
 *
 * 每个测试用独立的临时库（DSH_BIOMEMORY_DIR），不碰用户数据：
 *   npm test
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mem-layer-'))
process.env.DSH_BIOMEMORY_DIR = tempDir

const db = await import('../db.mjs')
const store = await import('../store.mjs')
const { compact } = await import('../compact.mjs')
const { fingerprint } = await import('../shared.mjs')

/** 备份目录里现有的 .db 文件名（不存在的目录当空处理）。 */
function backups() {
  const dir = db.backupDir()
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir).filter((f) => f.endsWith('.db')).sort()
}

/** 写一条记忆，返回 fp。approved/mode 显式给定，避免依赖宿主审批服务。 */
function write(text, track = 'user') {
  const r = store.writeEntry({ track, text, approved: true, mode: 'auto', realm: 'user' })
  assert.equal(r.ok, true, `写库失败：${r.error ?? ''}`)
  return r.fp
}

test('remove 是墓碑：行仍在库里，restore 能复活', () => {
  const fp = write('回归用例：删除是墓碑，不是物理删除')
  assert.equal(db.getByFp(fp).status, 'active')

  assert.equal(store.removeEntry(fp).ok, true)
  const gone = db.getByFp(fp)
  assert.notEqual(gone, null, '墓碑行必须还在库里')
  assert.equal(gone.status, 'deleted')

  assert.equal(store.restoreEntry(fp).ok, true)
  assert.equal(db.getByFp(fp).status, 'active')
})

test('purge 是真删，且不落备份副本', () => {
  const fp = write('回归用例：purge 不该留下副本')
  const before = backups()

  const r = store.purgeEntry(fp)
  assert.equal(r.ok, true)
  assert.equal(r.backup, undefined, 'purge 不再返回备份路径')
  assert.ok(!db.getByFp(fp), 'purge 之后行必须消失')
  assert.deepEqual(backups(), before, 'purge 不得写备份文件')
})

test('compact 只改状态，不落备份副本', () => {
  const fp = write('回归用例：compact 不备份', 'agent')
  // 造一条「很久没用过的 fact」：规则 2 一定会判它过期。
  db.openDb()
    .prepare("UPDATE entries SET mtype = 'fact', hits = 0, last_used = NULL, created_at = '2020-01-01T00:00:00.000Z' WHERE fp = ?")
    .run(fp)
  const before = backups()

  const r = compact({ now: new Date() })
  assert.equal(r.backup, null, 'compact 不再返回备份路径')
  assert.ok(r.tombstoned >= 1, `应当墓碑至少 1 条（实际 ${r.tombstoned}）`)
  assert.deepEqual(backups(), before, 'compact 不得写备份文件')
  assert.equal(db.getByFp(fp).status, 'deleted')
  // 墓碑依旧可复活——这就是不需要备份的理由。
  assert.equal(store.restoreEntry(fp).ok, true)
  assert.equal(db.getByFp(fp).status, 'active')
})

test('指纹迁移一次性：旧 fp 重算成全文哈希，重复调用不再动', () => {
  const text = '回归用例：指纹迁移只跑一次'
  const fp = write(text)
  const legacyFp = 'djb2-legacy-abcdef'
  db.openDb().prepare('UPDATE entries SET fp = ? WHERE fp = ?').run(legacyFp, fp)
  db.metaSet('fp_v2_at', null) // 模拟「0.11.0 首次启动」

  const first = store.migrateFingerprints()
  assert.equal(first.migrated, true)
  assert.ok(first.changed >= 1, '至少改写 1 条')
  const migratedFp = fingerprint(text)
  assert.notEqual(db.getByFp(migratedFp), null, '新指纹应当能查到这条')
  assert.ok(!db.getByFp(legacyFp), '旧指纹不该还在')

  const second = store.migrateFingerprints()
  assert.equal(second.migrated, false, '第二次必须跳过')
  assert.equal(second.reason, 'already')
})

test('includeArchived 拿得到归档条目，但 deleted 永不出现', async () => {
  const { queryEntries } = await import('../retrieve.mjs')
  const keep = write('回归用例：归档条目要能按需取出')
  const drop = write('回归用例：墓碑条目不该出现在检索结果里')
  db.setStatus(keep, 'archived')
  db.setStatus(drop, 'deleted')

  const withArchived = (await queryEntries('回归用例', 20, { includeArchived: true })).map((e) => e.fp)
  assert.ok(withArchived.includes(keep), 'includeArchived=true 要包含归档条目')
  assert.ok(!withArchived.includes(drop), 'deleted 条目永远不返回')

  const activeOnly = (await queryEntries('回归用例', 20)).map((e) => e.fp)
  assert.ok(!activeOnly.includes(keep) && !activeOnly.includes(drop))
})

test('测试结束：临时库可清理', () => {
  assert.ok(fs.existsSync(db.dbPath()), '数据库文件应当落在临时目录里')
  assert.equal(path.dirname(db.dbPath()), tempDir)
})
