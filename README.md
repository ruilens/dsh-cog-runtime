# dsh-cog-runtime

DSH 认知运行时（v0.1，单 agent）。**目标：让"假装完成"成为不可能的状态。**

它不是记忆插件、不是编排提示词，而是给 Agent 的工作过程加上三个持久对象，并用代码强制三条规则。

## 三个对象（工作区 `.cog/`）

| 文件 | 内容 |
|---|---|
| `task.json` | 任务图：每个节点有 `goal` 和 `accept`（可机检验收条件） |
| `evidence.jsonl` | 证据账：每次完成必须指向真实产物（文件存在 / 命令退出码 0） |
| `decisions.jsonl` | 决策账：计划、失败、重规划、阻塞 |

## 三个机制（代码执行）

1. **没有验收条件的节点不能进计划** —— `cog_plan` 直接拒绝。
2. **没有可核验证据的节点不能标记完成** —— `cog_done` 会检查文件是否存在、命令是否 `exitCode 0`。
3. **同一节点失败两次后必须先重规划** —— `cog_fail` 计数；满两次后 `cog_done` 被拒，直到 `cog_replan` 或 `cog_block`。

## 工具

| 工具 | 作用 |
|---|---|
| `cog_plan({nodes:[{id,goal,accept}]})` | 建计划；无 `accept` 即拒绝 |
| `cog_status()` | 查看节点状态、失败次数、是否需重规划 |
| `cog_done({id, evidence:[{type,ref,exitCode?,note?}]})` | 提交完成；证据必须可核验 |
| `cog_fail({id, reason})` | 记录失败；两次后要求换方法 |
| `cog_replan({id, approach})` | 记录新方法，解除完成限制 |
| `cog_block({id, reason})` | 诚实阻塞 |

## 本地使用（未发布）

已配好的 profile：`~/.dsh/profiles/cog`。

```bash
# 在任意工作目录里跑（状态写到该目录的 .cog/）
cd <你的工作目录>
dsh --profile cog "你的任务"
```

安装到别的 profile（本地链接）：

```bash
dsh plugin --profile <name> add "link:C:/Users/19549/dsh-cog-runtime"
# 然后在 profile 的 cordis.patch.yml 里加：
# - id: cog-runtime
#   name: dsh-cog-runtime
```

> 桌面应用的 `desktop` profile 由 Electron 独占管理，CLI 不允许安装本地插件；
> 想在那里用，需要等发布到 npm 后通过应用的插件市场安装。
>
> 发布前需替换 `package.json` / `LICENSE` / `market-entry.yml` 里的
> `<YOUR-NAME>`、`<YOUR-GITHUB>` 占位符。

## 验收（v0.1）

`node test/smoke.mjs` —— 10 项，覆盖拒绝路径与正常路径。

端到端已验证：
- 正常任务：建计划 → 写文件 → `cog_done` → `done`
- 对抗任务：不建文件直接 `cog_done` → **被拒绝**，节点保持 `open`，agent 如实报告

## v0.1 已知限制

1. **证据只验"存在"，不验"为真"。** 文件存在但内容错，运行时会通过。要堵这个洞，需要 v0.2 的 `verify` 命令（由运行时自己执行）。
2. **验收条件由 agent 填写。** 它可以写一个很弱的条件。真实使用时，`accept` 应由任务/人给出。
3. **无并发控制。** 单 agent；多 worker 的单点所有权在 v0.3。
4. **无重启恢复的显式处理。** 状态在磁盘上，但未做"中断后继续"的协议。

## 路线

| 版本 | 内容 |
|---|---|
| v0.1 | 三个对象 + 三个机制（已完成） |
| v0.2 | `verify` 命令由运行时执行；预算上限；重启恢复 |
| v0.3 | 黑板 + 单点所有权（两个 worker） |
| v0.4 | 真实长任务验证（文献综述 / 年报章节） |

## 设计文档

- `C:\Users\19549\dsh-arch-lab\DESIGN-LESSONS.md`（经验与标签）
- `C:\Users\19549\dsh-arch-lab\DESIGN-LEDGER.md`（全史）
