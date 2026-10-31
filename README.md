# dsh-memory-layer

> **给 DeepSeek Harness 的记忆层**：记住你的偏好和决定，换个会话它自己会想起来；数据只在本机，随时能查能改。

**v0.11.3** · MIT License · DSH 0.2.x（`>=0.2.0-rc.2 <0.3.0-0`，0.2.1-rc.3 桌面版实测）· Node ≥ 22.19.0

---

## 它是什么

一句话：**只做记忆，不做记忆平台。**

- **不做**：外置服务、向量检索、嵌入模型、知识图谱、云端同步、Web UI。
- **做**：一个 SQLite 单文件 + 一个"什么时候该想起什么"的确定性规则集。

它和"记忆平台"（如外置记忆服务）的区别，不是功能多少，而是**没有额外要跑的东西**：装完就是一个插件，数据在你自己机器的 `.dsh/biomemory/biomemory.db` 里，拷走文件就是迁移。

## 四层结构

### 1. 存储层：单文件 SQLite

| 字段 | 含义 |
|---|---|
| `realm` | 隔离维度：`user` 或 `project:<工作目录>` |
| `mtype` | 记忆类型：`workflow` / `error` / `decision` / `fact` |
| `trigger` | 触发信号串（见下） |
| `mkey` | 同键覆盖用的主题键 |
| `text` | 正文 |
| `created_at` / `last_accessed` / `last_used` / `hits` | 生命周期：写入时间 / 最近**被注入** / 最近**真实使用** / 真实使用次数 |
| `status` | `active` / `archived` / `deleted`（`remove` 是**墓碑**，不物理删；只有 `purge` 不可逆） |

另有两张辅助表：`chains`（工作流链）、`trigger_counts`（触发次数，用于工作流升级）。

> v0.11：`last_accessed`（被看到）与 `last_used`（真被用上）必须分开。
> 混为一谈时，触发召回每组装一次提示词就把命中条目刷新成"刚用过"，
> 清理规则的 30/90 天判据会被自己喂饱、永不触发。

### 2. 召回层：触发信号驱动

不等模型"自己想起来"，而是**看当前会话发生了什么**：

- 信号来源：当前会话工作目录（`session.cwd`）+ 最近 12 次工具调用的名字与参数（文件路径、命令、错误代号都从这里来）。
- 触发串只有三种形态，可读可解释：
  - `file:<文件名>` —— 例如 `file:package.json`
  - `tool:<工具名>` —— 例如 `tool:pwsh`
  - `err:<错误代号>` —— 例如 `err:MODULE_NOT_FOUND`
- 命中即注入，排序 **workflow > error > decision > fact**，同类型按最近访问；命中工作流链则**整条链**一起注入。
- **注入预算**：每次最多 8 条、最多 1200 字符；没命中就一个字都不注入（不占 token）。
- **偏好/决定通道**（v0.11）：触发串只能从文件名/错误代号里提取，而"偏好/决定"是纯自然语言
  （实测 8 条典型偏好里 6 条没有任何 trigger）。给它们一条独立小预算（默认 ≤3 条 / ≤400 字符），
  不与触发召回抢 1200 字符。
- **冷启动兜底**（v0.11）：库还很小、还没攒出 trigger 关联时，零命中也不至于颗粒无收
  （回落注入最近写入的几条；库一大就自动让位给触发召回）。

### 2.5 注入 ≠ 使用（v0.11）

被注入只刷新 `last_accessed`；只有下面两种情况才算**真实使用**、推进 `hits` 与 `last_used`：

- `memory action=query` 的关键词命中；
- 显式 `memory action=used fp=<指纹>`。

清理规则只认真实使用。这样"被想起过"不会阻止一条记忆最终被淘汰。

### 3. 清理层：五条可解释规则

`/memory compact` 执行，每次淘汰都写 `compact.log`：

1. 同 `realm + type + key` 的新记忆覆盖旧记忆（旧条目标墓碑）——写在写入路径上（**全等**比较，不做前缀匹配）；
2. `fact`：**真实使用**超过 30 天没发生过（使用次数 ≤1）→ 进墓碑；
3. `workflow` / `error` / `decision`：不设有效期；**真实使用**超过 90 天前 → 权重减半；
4. `error` 与 `decision` **永不自动删除**；
5. 每条淘汰/降权都记 `compact.log`（时间 · 指纹 · 命中规则 · 摘要）。

锁定（pinned）的条目豁免全部规则；`compact` 只把 `status` 改成 `deleted`（墓碑，`restore` 能翻回来），所以**写库路径不产生备份副本**——需要事前快照请自己 `dump` 或拷库。

### 4. 适配层：工作流从重复里自己长出来

同一个触发串出现 **超过 3 次**，相关记忆自动升级为 `workflow`，并按时间顺序拼成一条链：

```
当 file:package.json 时：先看 package.json → 跑测试 → 再改代码
```

链是**顺序记录**，不是因果推断——不假装知道为什么，只如实记下"你上次是这么做的"。

## 安装

### 桌面版：按包名安装（推荐）

1. 打开 DSH 桌面版 → 左侧 **插件** → **加插件**；
2. 在包名输入框填 `dsh-memory-layer`，点 **安装**（安装完自动启用）。

命令行等价：

```bash
# 把 desktop 换成你的 profile 名
dsh plugin --profile desktop add dsh-memory-layer
```

### 本地开发（link）

```bash
dsh plugin --profile desktop add link:./dsh-memory-layer
```

安装完重启 DSH 生效（开了 HMR 的 profile 会热挂载）。

## 用法

### 工具 `memory`

| action | 说明 |
|---|---|
| `add` | 写入一条记忆（`text` 必填；`track=user|agent`；`source` 记来源；realm 由会话工作目录推断） |
| `query` | 关键词查询（`text`/`topK`/`fragmentTypes`/`includeArchived`）；**关键词命中记一次真实使用** |
| `used` | 标记"这条刚才真的用上了"（推进 `hits` 与 `last_used`，影响清理规则） |
| `list` / `update` | 浏览 / 改 |
| `remove` | 标墓碑（行还在库里，`restore` 可回滚） |
| `purge` | **物理删除**（不可逆；不落备份副本——备份会把该消失的内容留在同一台机器上）——只给误存密钥这类场景 |
| `restore` / `pin` / `unpin` | 回滚 / 锁定 / 解锁 |
| `compact` | 按五条规则清理（`dryRun=true` 只预览；实跑只改 `status`，不备份） |
| `dump` | 导出人类可读 Markdown（含工作流链；保留最近 10 份） |

写入（`add` / `update`）时，若正文含「今天 / 昨天 / 下周」等相对时间却没有绝对日期锚点（`YYYY-MM-DD`、`M月D日`、`20xx年`），成功返回的 `note` 会附一行提醒；**写入照常成功，不拒绝**——因为拒绝会丢信息。

还有一个 `memory_recall` 工具，用于"你还记得…吗"式的显式召回。

### 命令 `/memory`

```
/memory list | query <词> | add <内容> | edit <fp> <新内容> | entries [词]
/memory remove <fp> | purge <fp> | undo <fp> | unarchive <fp> | used <fp>
/memory pin <fp> | unpin <fp>
/memory stats | why <fp> | preview
/memory compact [--dry-run] | dump | help
```

- **`stats`**：健康度——活跃条数、墓碑/归档数、类型与 realm 分布，以及 **trigger 覆盖率**
  （有多少记忆没有任何触发串 = 永远不会被主动想起，只能靠偏好通道或常驻快照出场）。
- **`why <fp>`**：这条记忆为什么（不）会被注入——命中了哪个触发串、realm 是否匹配、优先级、
  真实使用次数。
- **`preview`**：预览"如果现在组装提示词，会注入什么"（含偏好通道、触发命中、冷启动三段与预算占用）。

### 写入审批

重要记忆（用户偏好/决定/纠正类）走 DSH 官方审批：批准才落库，审批服务不可用时**默认拒绝**（fail-closed，可用配置 `approvalFallback=auto` 放宽）。

## 数据与隐私

- 全部本地：零外部请求、零外部 API、零遥测。
- 数据库：`<DSH_BIOMEMORY_DIR || ~/.dsh/biomemory>/biomemory.db`（SQLite，WAL）。
- 删除是墓碑（可恢复），`compact` 也只在库内改状态；**写库路径一律不产生备份副本**（`purge` 尤其不能留副本），需要快照就 `dump` 出 Markdown 或自己拷库。
- 环境变量：`DSH_BIOMEMORY_DIR`（数据目录）、`DSH_MEMORY_ROOT`（Markdown 备份/日志目录）。
- **配置目录说明**：配置文件在 `<DSH_MEMORY_ROOT || ~/.dsh/memory>/biomemory.config.json`
  （v0.11 修正：旧文档写成 `~/.dsh/biomemory/`，与实现不符——库在 `biomemory/`、配置与导出在 `memory/`）。
- **本地 HTTP 端点**（宿主 webServer 存在时注册 `/biomemory/api`）：默认只接受本机来源，
  跨站请求一律 403；必要时可用 `DSH_MEMORY_API_ORIGINS` 放开指定 Origin，
  或 `DSH_MEMORY_API_NOAUTH=1` 关闭校验（不建议）。

## 配置

`<DSH_MEMORY_ROOT || ~/.dsh/memory>/biomemory.config.json`（或 bundle config）可覆盖：

| 键 | 默认 | 说明 |
|---|---|---|
| `nearDuplicateThreshold` | 0.7 | 写入去重的相似度阈值（0=关闭） |
| `nearDuplicateAction` | merge | 命中近重复时合并 / `skip` 只提示 |
| `approvalFallback` | deny | 审批不可用时拒绝 / `auto` 自动保存 |
| `decayThreshold` | 3 | 状态页"低权重待处理"的阈值 |
| `hotTokenLimit` | 2000 | 常驻快照注入的 token 上限（v0.11：5000→2000，让触发召回成为主通道） |
| `maxQueryResults` | 20 | 查询返回上限 |
| `weightCap` | 20 | 权重上限（防膨胀） |
| `sinkWindowMinutes` | 5 | 轮次结束后"请沉淀"提示的有效窗口（分钟） |
| `decisionChannelMax` | 3 | 偏好/决定通道每轮最多注入条数（0=关闭） |
| `decisionChannelChars` | 400 | 偏好/决定通道每轮字符预算（0=关闭） |
| `coldStartFallbackMax` | 3 | 冷启动兜底条数（0=关闭） |
| `injectSnapshot` | true | **宿主注入开关**：记忆快照段（order -50）。false = 该段完全不注册 |
| `injectRecall` | true | **宿主注入开关**：触发式召回段（order -40） |
| `injectSummary` | true | **宿主注入开关**：轮次结束沉淀提醒段（order 200） |

三个 `inject*` 是「宿主注入开关」：默认 true 保持现行为；**退成纯数据层（只存只查、不进 prompt）时全置 false**。它们在插件 `apply` 时读取，改完需重启宿主或重载插件才生效（只改 `biomemory.config.json` 不会热切换）。

## 设计上刻意不做的事

- **不做向量/嵌入检索**：相同输入必须给相同结果，检索要可解释。
- **不做自动"反思"**：没有模型就不假装会归纳；工作流只从重复里浮出来。
- **不做删除即销毁**：一切删除留墓碑，误删可回滚。
- **不做跨机同步**：那是另一类产品；这里只保证文件可以整体搬走。

## 版本历史

| 版本 | 日期 | 变更 |
|---|---|---|
| **v0.11.3** | 2026-10-31 | **退成数据层的准备 + 日期校验**：新增宿主注入开关 `injectSnapshot` / `injectRecall` / `injectSummary`（默认 true 保持现行为；全置 false = 只存只查、完全不进 prompt；`apply` 时读取，改后需重载）。写入含相对时间（今天/昨天/下周…）且无绝对日期锚点时，`add` / `update` 的成功返回附一行提醒，写入照常成功（锚点：`YYYY-MM-DD` / `M月D日` / `20xx年`；「最近 / 目前」不触发） |
| **v0.11.2** | 2026-10-31 | **按已发布的 0.11.1 回灌仓库 + 收口**：0.11.0/0.11.1 的源码树丢失，以 tgz 为准恢复模块（代码与 0.11.1 逐字节一致，功能无变更）；README 版本曝光、ARCHITECTURE 测试指向、SECURITY 支持版本与 audit.log 说明、CI Node 22.19 矩阵、.gitignore 白名单同步修正；删除 2 条 0.10 语义旧用例、同键覆盖用例改为全等键；删除 stale `pnpm-lock.yaml`。详见 `CHANGELOG.md` |
| **v0.11.1** | 2026-10-28 | **写库不再自动备份 + 测试随包发布**：`compact` / `purge` / 指纹迁移口径统一为「不落备份副本」（墓碑可 `restore`，`purge` 反而不能留副本，`backupDb()` 降为手工入口）；`files` 补 `tests` 并新增 `tests/core.test.mjs`（零依赖，装完即可 `npm test`）。详见 `CHANGELOG.md` |
| **v0.11.0** | 2026-10-27 | **数据正确性与可观测性**：修 `includeArchived` 会返回已删除墓碑条目；`remove` 改为真墓碑（物理删除收敛到 `purge`）；指纹改全文哈希（旧算法前 20 字撞车会静默丢记忆）+ 一次性重算迁移；同键覆盖改全等（前缀匹配会误墓碑）；注入与真实使用分开计数（`last_accessed` / `last_used`），清理规则不再被自反馈喂饱；写入路径按会话 cwd 推断 realm；沉淀状态与会话信号按会话分桶；本地 HTTP 端点加来源校验；`selfHeal` 不再抛出。**新增**：偏好/决定独立通道、冷启动兜底、`/memory stats`（含 trigger 覆盖率）/ `why` / `preview` / `used` / `purge` / `unarchive` / `help`、快照缓存、dump 轮转 |
| **v0.10.2** | 2026-10-25 | 简介换成「记住偏好与决定、换会话自动带上」的说法，桌面版实测版本改 0.2.1-rc.3；功能无变更 |
| **v0.10.1** | 2026-10-25 | 插件卡片文案重写：中英双语显示名与一句话简介（`locale` 的 `meta`），`description` 去掉版本号与功能罗列；功能无变更 |
| **v0.10.0** | 2026-10-05 | **重构为「记忆层」**：新增触发式召回（`trigger` + `realm` + `mtype` + `mkey` 四列）、类型优先级排序、五条清理规则 + 墓碑 + `compact.log`、工作流从重复中升级并成链、注入预算（≤8 条 / ≤1200 字符）、`compact`/`dump`；**移除**记忆代谢（dream）、深度反思（reflect）、冲突裁决、结构化审计与自动 Markdown 镜像 |
| v0.9.2 | 2026-09-29 | 删死模块与死配置键；文档与实现对齐（配置表/API 表/测试数） |
| v0.9.1 | 2026-09-29 | 移除管理 UI，插件退化为纯宿主能力 |
| v0.9.0 | 2026-09-29 | 移除嵌入模型与 semantic/hybrid 检索，改单一确定性检索路径 |
| v0.8.2 | 2026-09-20 | 合规化批次：审计双写修复、配置按类型落库、近重复写入去重 |
| v0.8.0 | 2026-09-16 | 写入去重（bigram 相似度）+ 合并/跳过两种策略 |
| v0.7.0 | 2026-09-17 | 镜像同步钩子（v0.10.0 已移除） |
| v0.6.4 | 2026-09-06 | 单轨制：SQLite 为唯一事实来源，Markdown 降级只读备份 |
| v0.6.0 | 2026-08-19 | 架构拆分（shared/store/retrieve/snapshot/gate）+ 会话沉淀 |
| v0.5.0 | 2026-08-15 | 数据层迁移到 SQLite（`node:sqlite`） |

## License

MIT — 详见 [LICENSE](LICENSE)。
