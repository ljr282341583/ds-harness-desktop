# AGENTS.md — DS Harness Desktop

本仓库是 **DS Harness Desktop**：用 Electron 外壳包裹官方 DeepSeek Harness（`@deepseek-ai/dsh`），由捆绑的独立 Node 24 侧车运行 `dsh web`。

本项目使用 `agent-loop` 进行代理辅助开发。代理负责推进流程：判断当前阶段、给出唯一推荐动作、主动补齐缺失 artifact，而不是等人类逐条点名每一步。

指引语言：中文。稳定的 artifact / stage 名称与文件路径保持英文（如 `agent-loop`、`Feature Spec`、`Gate 2`、`project.md`、`requirements/`）。

**agent-loop 记忆根不在本仓库内**：位于 Codex 工作空间的项目目录 `projects/dsh-desktop-updater/.agent-loop/`，长期项目记忆是其下的 `project.md`。本文件中的 managed block 以逻辑路径 `.agent-loop/project.md` 作为 source 引用。

## 仓库速览（人类/项目所有，不属 managed block）

| 路径 | 职责 |
| --- | --- |
| `app/src/` | 主进程、preload、本地 loading/error 页面 |
| `app/build/` | 打包钩子 `afterPack.js`（依赖覆盖 + 兼容守卫 + 图标/版本嵌入）与资源 |
| `app/runtime/` | 捆绑的 Node 24 侧车（**不入库**；只含 `node.exe`，不含 npm） |
| `docs/` | 设计方案、使用方法、分发说明 |
| `过程记录/` | 项目自身的按次会话进度日志 |

产品硬前提：内置 dsh 版本是保底；任何更新失败都必须能回到内置版本；不得破坏 `~/.dsh` 下的凭据、会话、skills 与 profiles。

<!-- agent-loop:managed-start section:bootstrap source:.agent-loop/project.md block-version:1.5.3-20260728.1 -->
## Bootstrap Protocol

Before development work:

1. Read this file first.
2. Treat root `AGENTS.md` as a bootstrap cache, not a replacement for the `agent-loop` skill; load the controller at Project Entry, Resume, Re-Adopt, stage boundaries, context recovery, or uncertainty.
3. If the controller is unavailable or load-failed, force Strict Mode, suspend auto grants, and limit fallback to Chat, read-only Project Entry, Recovery analysis, read-only Operational Support, and restoration guidance; do not Execute, write Human-gated artifacts, Submit, Pause, or Close.
4. Discover exactly one `.agent-loop/` or accepted legacy `agent-loop/` memory root; if no reliable memory exists, route to Project Entry / Init before feature work.
5. Read only stage-relevant project memory, remote-entry evidence, Active Feature artifacts, and linked detail needed for the current decision.
6. Resolve stale or outside-loop memory through Recovery / Re-Adopt, and remote source conflicts through Remote Project Discovery, before relying on local claims.
7. Check Project Skill metadata before generic executable fallback; verify and load only a matched active skill, while preserving its per-invocation Execution Gate because loading never authorizes execution.
8. Run Stage Helper Capability Scan only after controller activation or recorded unavailable/load-failed status; helpers improve methods but do not own routing or gates.
9. Check the closest directory guidance, classify current intent and project state, and recommend exactly one next action.
<!-- agent-loop:managed-end section:bootstrap -->

<!-- agent-loop:managed-start section:ownership source:.agent-loop/project.md block-version:1.5.3-20260728.1 -->
## Agent Ownership

When existing branch rules are confused, the target version is unclear, or customer isolation is at risk, load `references/branch-management.md`, recommend one optional strategy, and adopt it only after explicit human acceptance.

- Own the project outcome, not only the workflow: inspect all safely available code, Git, tests, documentation, environment, and memory evidence before asking the human, then continue through the authorized scope until verified completion or a concrete Human Gate.
- Own diagnosis, sequencing, implementation, verification, Review, Drift Check, and Project Memory Update within the authorized boundary.
- Classify the current state and recommend one next action; propose missing artifacts instead of waiting for the human to name internal steps.
- Use helpers as methods only; `agent-loop` retains artifact paths, status, Human Gates, lifecycle, submit, pause, and close authority.
- After each meaningful stage, report changed artifacts, fresh evidence, drift, and the next recommendation; use a table-first Human Review Summary for non-trivial confirmation.

Core workflow:
Inspect -> Classify Intent And Project State -> Recommend One Next Action -> Human Gate When Required -> Act Through Loaded Reference -> Verify -> Review / Drift -> Record Memory -> Submit / Pause / Close

Product delivery:
Requirements / Product Definition -> Decision / ADR If Needed -> Feature Product Slice -> Plan -> Execute -> Verify / Review / Drift -> Memory -> Submit / Close
<!-- agent-loop:managed-end section:ownership -->

<!-- agent-loop:managed-start section:message-intent source:agent-loop-skill block-version:1.5.3-20260728.1 -->
## Message Intent Guard

Classify the latest human message before project-state routing:

- Chat answers or discusses without creating workflow artifacts.
- Requirements Discussion shapes unresolved product need into one Human-reviewed Brief/Standard Requirement Product Definition before implementation.
- An already-defined actionable ordinary non-Bug change enters Lightweight Change Assessment only after Bug and active-Feature ownership checks.
- Explicit Bug intent, regression evidence, or clear Feature ownership enters Bug / Feature Follow-up before Lightweight routing.
- Feature Request enters construction only from accepted upstream meaning and the normal runtime gates.
- Operational Support defaults to read-only use, test, run, rollout, or diagnosis until implementation or mutation is separately approved.
- Project Skill Management keeps discovery/loading separate from its per-invocation Execution Gate.
- Feature Archive / Rehydrate keeps read-only factual scan and Agent risk judgment separate from its exact-plan apply authorization.
- Post-Merge Memory Reconciliation begins only after verified code integration and an observed memory conflict; no conflict means `reconciliation-not-needed`, with no full scan or extra gate.
- Proposal, deferred requirement, Requirement/Feature lifecycle, and Git/lifecycle requests remain distinct intents and authorities.

Intent may change with the latest message. When it is genuinely unclear, inspect all safely available evidence first, recommend one route, and ask exactly one blocking question.
<!-- agent-loop:managed-end section:message-intent -->

<!-- agent-loop:managed-start section:workflow-stage-map source:agent-loop-skill block-version:1.5.3-20260728.1 -->
## Workflow Gateway Map

Use this after Bootstrap and Message Intent. Apply: Safety Stop -> Remote Discovery -> Memory Recovery -> Feature Archive Maintenance -> Active Feature Guard -> Blocker Resolution -> Intent Routing -> Normal Stage Continuation. Select one first hop and load its published owner before acting.

| Signal family | First Hop | Load From agent-loop Skill |
|---|---|---|
| No reliable memory | Project Entry / Init | `references/project-entry-scan.md`, `references/project-guidance.md`, `references/stage-guides.md` |
| Remote source of truth | Remote Project Discovery | `references/remote-project-discovery.md` |
| Broad memory damage, stale/incomplete memory without a stable verified post-merge conflict boundary, outside-loop work, or unresolved reconciliation recovery | Recovery / Re-Adopt | `references/recovery-and-backfill.md` |
| Explicit closed-history archive or rehydrate | Feature Monthly Archive | `references/stage-guides.md`, `references/artifact-rules.md`, `references/feature-follow-up.md` |
| Explicit Bug intent, regression evidence, or clear Feature ownership | Bug / Feature Follow-up | `references/bug-management.md`, `references/feature-follow-up.md` |
| Already-defined actionable ordinary non-Bug change that appears bounded, reversible, and exactly verifiable | Lightweight Change Assessment | `references/lightweight-change-lane.md` |
| Product need, meaning, scope, or delivery phases are still being shaped | Requirements Discussion | `references/requirement-management.md`, `references/product-definition.md`, `references/requirement-product-grill.md` |
| Human confirms Product Definition recording, requirement acceptance, deferral, or lifecycle action | Requirement Archive | `references/requirement-management.md`, `references/stage-guides.md` |
| Durable newcomer documentation is requested after reliable Project Entry | Evidence-Graph + DDD Onboarding | `references/onboarding-knowledge-base.md` |
| Accepted requirement needs shared technical landing before feature specification | Decision & Design If Needed | `references/project-decisions.md` |
| Accepted upstream meaning is ready for implementation or current Feature work continues | Feature Construction / Runtime Continuation | `references/runtime.md`, `references/stage-guides.md` |
| Use, test, run, deploy, or diagnose current behavior without implementation approval | Code-Guided Operational Support | `references/stage-guides.md`, `references/runtime.md` |
| Canonical Agent Loop checker failure after an exact rerun | Diagnose Failure / Checker Recovery | `references/checker-recovery.md`, `references/stage-guides.md` |
| Create or manage a reusable project workflow | Project Skill Creation / Update | `references/project-skills.md`, `references/skill-routing.md`, `references/external-skill-adapters.md` |
| Verified code integration has an observed memory conflict | Post-Merge Memory Reconciliation | `references/memory-reconciliation.md` |
| Submit, commit, PR, merge, release, publish, pause, close, or cleanup is requested | Lifecycle Boundary | `references/submit-and-integrate.md`, `references/stage-guides.md` |
| Ordinary question or discussion has no artifact or action intent | Chat | `references/runtime.md` |

The complete Product Definition, Feature Spec/Product Slice, Requirement Checklist, Work Breakdown, Delivery Contract, Test Design, E2E, Technical Design, Plan, Execute, Verify, Review, Drift Check, Project Memory Update, Feature Completion Check, and lifecycle order remains owned by `references/runtime.md` and loaded references. A Gateway selects its owner family; it never removes or reorders a downstream stage.

No observed memory conflict means `reconciliation-not-needed`: do not scan all memory, create a report, or add a Human Gate.
<!-- agent-loop:managed-end section:workflow-stage-map -->

<!-- agent-loop:managed-start section:gates source:.agent-loop/project.md block-version:1.5.3-20260728.1 -->
## Gate Modes

- Feature construction normally stops at two reviews: Gate 1 confirms Goal, Scope, Acceptance, and Explicit Exclusions and authorizes package preparation; Gate 2 confirms Execution Boundary, Verification, Risk/Rollback, and whether to start Feature Auto-Loop.
- Package preparation completes applicable Tasks, Tests, E2E, code context, Plan, coverage, risk, rollback, and consistency without per-stage prompts or target implementation.
- AI evaluates Package Files completeness, Gate/action/time consistency, later semantic/boundary drift, and current Story/Task/Plan meaning directly; Feature Gate acceptance and continuation require no local digest or Feature review Checker. A new Task ID inside the accepted boundary does not itself repeat Gate 2. `Approve package only` never executes; `Approve package and start implementation` enables Feature Auto-Loop without another generic prompt. A valid separate later-start transition may also enable it, but preserves the package-only Gate 2 baseline.
- Strict Mode is available when the human explicitly requests stage-by-stage control and is mandatory when controller fallback forces it.
- Task Auto-Run requires an accepted task/story plan and explicit human enablement for one execution unit, beginning with Analyze Consistency.
- Auto modes continue only Agent-ready work inside their grant and stop at every independent Gate below.
- Before Task/Test/Plan/Execute/Resume relies on a Feature, load its Feature Context Snapshot and run the Requirement/ADR fact scanner: `CURRENT` permits reliance, `CHANGED` requires Agent impact assessment/refresh, and physical `BLOCKED` routes to Recovery/source repair.
<!-- agent-loop:managed-end section:gates -->

<!-- agent-loop:managed-start section:required-stops source:.agent-loop/project.md block-version:1.5.3-20260728.1 -->
## Required Stops

- Semantic Gate: Requirement, Concept, acceptance, Product, or Decision / ADR meaning is unresolved or would be redefined downstream.
- Scope And Risk Gate: scope expansion or architecture, security, data, permission, dependency, migration, public interface, customer isolation, or durable boundary changes.
- Execution Gate: Requirement/Feature lifecycle, plan execution, Project Skill, subagent, Delivery Contract, Archive/rehydrate, or another independently authorized action.
- Evidence Gate: controller/infrastructure unavailable, repeated verification failure, unresolved memory/artifact conflict outside a reversible fact-determined Post-Merge Memory Reconciliation rewrite, blocking dirty work, or missing Review/Drift/Memory evidence.
- A suspected checker defect routes to isolated Human-authorized Checker Recovery; it never becomes a silent bypass or canonical pass, and any upstream Issue creation keeps an independent External Mutation Gate.
- External Mutation Gate: secrets, paid quota, credentials, configuration, external service, production/staging, deploy, release, or destructive action.
- Git And Lifecycle Gate: branch mutation, commit, push, PR, merge, tag, release, publish, pause, close, Full Memory Audit / Recovery Apply/Restore, or cleanup.

Auto modes do not bypass these six Gate classes.
<!-- agent-loop:managed-end section:required-stops -->

<!-- agent-loop:managed-start section:completion source:.agent-loop/project.md block-version:1.5.3-20260728.1 -->
## Completion Rules

- Code changes alone never make a task or Feature done.
- Fresh verification, Review, Drift Check, and required Project Memory evidence precede completion.
- Task Done Gate also requires accepted scope, recorded evidence, Spec Review, triggered Standards Review, and evidence-linked status.
- Run Feature Completion Check after likely completion, before another Feature starts, and when an active Feature may already be complete.
- Feature Close Review, applicable accepted-design/contract evidence, drift resolution, memory updates, and explicit human close confirmation remain required.
<!-- agent-loop:managed-end section:completion -->

<!-- agent-loop:managed-start section:submit source:.agent-loop/project.md block-version:1.5.3-20260728.1 -->
## Submit And Commit Rules

- Submit, commit, push, PR, merge, tag, release, publish, pause, close, and cleanup remain independent Human Gates.
- Before any requested submit action, inspect the intended diff, fresh verification, Review, Drift Check, project-memory status, branch/release constraints, and unrelated work.
- Commit only intended files within the approved scope; preserve unrelated human changes and do not infer one Git permission from another.
- After verified code integration, use `reconciliation-not-needed` when no memory conflict exists; otherwise resolve only the observed conflict before any applicable later memory commit, push, release, publish, or source cleanup Gate.
- Use repository commit rules when present; otherwise use a clear type, summary, and concrete body. Record authorized results in the owning feature evidence.
<!-- agent-loop:managed-end section:submit -->

<!-- agent-loop:managed-start section:artifacts source:.agent-loop/project.md block-version:1.5.3-20260728.1 -->
## Project Memory And Artifacts

- Requirement owns human source and product meaning; Decision / ADR owns accepted technical landing; Feature owns implementation; Bug owns defect identity and lifecycle; Lightweight Execution Card owns bounded change evidence; project memory owns durable current facts.
- Resolve artifacts under the accepted `.agent-loop/` or legacy memory root; keep `project.md` and optional enterprise detail as durable current memory.
- Preserve original human requirement material. Keep lifecycle/index updates, accepted product meaning, technical decisions, implementation evidence, contracts, archive locators, and project-local skills in their owning artifacts.
- Keep future or deferred product work in Requirement lifecycle/backlog artifacts, never as an unowned root-guidance task.
- Root `AGENTS.md` contains only startup-critical navigation and stable constraints; it does not own task logs, raw requirements, backlog detail, temporary plans, or test transcripts.
<!-- agent-loop:managed-end section:artifacts -->

<!-- agent-loop:managed-start section:architecture source:.agent-loop/project.md block-version:1.5.3-20260728.1 -->
## Architecture Snapshot

- 形态：Electron 外壳（`app/src/`）托管本地 `dsh web` 子进程；UI 直接加载本地服务地址，不做前端改造。
- 运行时分层：Electron 自带 Node 版本过低，dsh 由捆绑的独立 Node 24 侧车（`runtime/node.exe`）执行。
- 数据边界：所有 dsh 数据位于 `~/.dsh`（凭据、会话、skills、profiles），由 dsh 自身管理，外壳不读写业务数据。
- 打包边界：`asar: false`（侧车不识别 asar）；`extraResources` 投放 `runtime/`；`afterPack.js` 覆盖依赖树并执行兼容守卫。
- 已安装布局（实测 v0.2.0）：`<安装目录>\resources\app\`（外壳 + `node_modules`）与 `<安装目录>\resources\runtime\node.exe`。
<!-- agent-loop:managed-end section:architecture -->

<!-- agent-loop:managed-start section:directory-guidance source:.agent-loop/project.md block-version:1.5.3-20260728.1 -->
## Directory Guidance

- Directory-level `AGENTS.md` files are for long-lived boundary rules only.
- When creating a new app root, package root, service root, test root, security/data/runtime boundary, plugin root, or docs root, propose a directory-level `AGENTS.md` and ask for human confirmation before writing it.
- Do not create directory-level `AGENTS.md` for ordinary component, utility, temporary, or feature implementation folders.
- 当前状态：无目录级 `AGENTS.md`（`app/`、`app/src/`、`app/build/` 均记为 not needed）。
<!-- agent-loop:managed-end section:directory-guidance -->

<!-- agent-loop:managed-start section:commands source:.agent-loop/project.md block-version:1.5.3-20260728.1 -->
## Project Commands

```bash
cd app && npm ci                 # 按 lockfile 精确安装依赖（勿用 npm install）
cd app && npm start              # 开发运行（Electron 壳 + 托管 dsh web）
cd app && npm run build          # 打包 NSIS + portable，产物输出到仓库外的 产出/
```

无自动化测试与 lint 命令；变更验证依赖 `npm start` 人工冒烟与打包守卫输出。
<!-- agent-loop:managed-end section:commands -->

<!-- agent-loop:managed-start section:hard-constraints source:.agent-loop/project.md block-version:1.5.3-20260728.1 -->
## Project-Specific Hard Constraints

1. 内置 dsh 版本是保底：任何更新失败都必须能回到内置版本。
2. 打包守卫必须保留：拒绝 `@deepseek-ai/dsh-base/cordis.patch.yml` 含 `compression: none` 的构建（会导致读不了 `.jsonl.zstd` 历史会话而闪退）。
3. `resources/runtime/` 当前只含 `node.exe`，**不含 npm**；"调用侧车自带 npm"不可作为实现前提。
4. `~/.dsh` 是共享数据目录：涉及升级或测试时必须用 `DSH_HOME` 重定向到临时目录，不得污染真实凭据与会话。
5. 便携版（portable 单文件）每次启动自解压到临时目录，无法原地自更新。
6. 版本判断只认顶层 `@deepseek-ai/dsh` 的 dist-tags；同族子包的 `latest` 已过期（停在 `0.0.1-rc.1`）。
7. `@deepseek-ai/dsh` 依赖使用精确版本，不使用 `^`。
8. 上游 RC 包同版本号可能被重新发布为不同内容，需以 `dist.integrity` 而非仅版本号判断。
<!-- agent-loop:managed-end section:hard-constraints -->
