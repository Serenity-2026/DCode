# DCode 项目交接摘要

用途：给新窗口恢复功能开发上下文。按 2026-10-07 的源码整理，只保留已实现功能、分层契约、已知边界和开发入口，不记录代码问答、语法教学、迭代过程或 GitHub 操作历史。详细规范在 `doc/SPEC*.md`，若早期文档与源码冲突，以当前源码和测试为准。

## 1. 项目目标与当前范围

- 项目根目录：`/Users/a1/Documents/open-source/DCode`。
- DCode 是 Electron 桌面 Coding Harness。目前完成本机账号、模型配置、流式对话和桌面交互框架。
- 技术栈：TypeScript 5.9、Electron 44、React 19、Ant Design 6；electron-vite 构建，electron-builder 打包；Vitest 单元测试、Playwright Electron E2E。
- 当前能与模型对话、把用户主动选择的文本文件/目录作为上下文，已接入简洁 function call / agent loop 和 OpenAI、Anthropic 统一消息层。生产工具列表为空，尚未实现终端执行、工程写入、云端账号同步或具体编码工具。不要把附件选择误认为已获得工程操作能力。
- Agent 基本框架已经完成；本轮没有待完成的功能需求。下一步功能由用户在新窗口指定，开发时继续沿用当前分层，逐步增加能力。
- 用户是 Java 程序员，了解部分 TS 语法；交流用中文。每个类和核心方法前写中文注释，说明职责与依赖。

## 2. 已有功能与界面约定

- 本机账号密码注册/登录，账号隔离会话、模型服务、模型选择、强度、快速模式和主题；支持修改显示名。登录后重启自动恢复，主动退出才注销。
- 多服务配置：设置填写服务名称、Base URL、API 协议与 API Key，不填写模型 ID。通过所选协议的 `/models` 测试并保存，失败保留旧配置；编辑时密钥留空沿用原密钥，未传协议时沿用已有选择。配置名称与协议并排，保持小窗口保存按钮可见。
- 协议为 `openai-completions` 或 `anthropic-messages`，所选模型继承所属服务的协议，不能靠 Claude/GPT 名称猜测。旧配置和环境地址仅在官方 `api.anthropic.com` 时自动使用 Anthropic，其余沿用 OpenAI；自定义网关由用户明确选择。Anthropic 支持根地址或 `/v1`，使用原生认证与模型列表分页。
- 登录/恢复后刷新模型列表，输入框下方按服务分组选模型；模型 ID 来自接口，不能写死。刷新失败保留缓存并提示。
- 流式正文/推理内容、停止并保留部分回复、最后一条回复重新生成；会话创建、搜索、切换、重命名、确认删除；Markdown、代码复制、外链打开。
- `Enter` 发送，`Shift+Enter` 换行，中文输入法组词时不发送；`Cmd/Ctrl+N` 新对话。
- 界面参考 Codex 的克制桌面风格，支持浅色/深色。应用、登录页与左上品牌使用自定义 D 图标，资源在 `build/icon.svg/png/icns`。
- 欢迎页使用灰色云朵终端：漂浮、悬浮提亮、点击旋转/光圈，内部短横线持续闪烁。选择文件夹后标题显示带下划线的目录名，点击可更换目录；取消保留草稿，移除恢复默认标题。
- 输入框左下“+”添加文件/文件夹；右侧依次为模型选择、上下文圆环、快速模式、模型强度与发送/停止。模型菜单向上展开，箭头向上；生成期间输入区域使用旋转圆环光标。
- 快速模式开启为蓝色实心闪电，关闭为描边；OpenAI 兼容协议按快速模式配置发送 `service_tier: "priority"`，不按域名特判，效果取决于服务支持；服务拒绝时提示关闭快速模式。Anthropic 原生协议不发送此参数。
- 模型强度由服务元数据决定：支持 `low/high/max` 就只展示这三档。白名单为 `minimal/low/medium/high/xhigh/max/ultra`，按顺序过滤；未返回档位显示“强度未知”，明确空列表显示“不支持推理”，均禁用。无猜测档位兜底。默认值优先服务默认档，选择按账号/服务/模型保存。
- 强度面板使用连续滑块，释放时取最近档位并保存一次；粗圆角轨道、动态粒子、平滑变化、键盘整档操作。OpenAI 兼容请求按所选强度发送 `reasoning_effort`，不按域名自动追加供应商专有 `thinking`。Anthropic 原生协议本轮不发送这些选项。
- 侧栏使用 AntD Splitter：默认 246px，上限为窗口宽度 1/3，拖至 180px 以下收起；顶部按钮显示/隐藏并恢复本次会话宽度。收起不丢草稿和聊天。
- 对话左侧每轮用户问题对应 4–16px 短线；鼠标连续位置形成峰值，两侧平滑递减。悬浮显示问题/回复预览，点击平滑跳转，滚动同步当前轮次；阅读历史时流式输出不强制回底。未实现收藏。
- 动画尊重 `prefers-reduced-motion`；交互保留键盘与窄窗口支持。

## 3. 架构与职责

主进程负责权限、业务、存储、模型网络及系统能力；renderer 负责 React 界面；preload 是受限桥接脚本，不是单独的第三个业务进程。

```text
src/main/
  index.ts                       只调用启动入口
  app/bootstrap.ts               生命周期与手动依赖装配
  windows/main-window.ts          窗口、安全策略、流事件转发、安全关闭
  ipc/ipc-router.ts              来源校验、Result 包装、操作互斥
  controllers/                  auth/model/state/chat/desktop 的 IPC 接口
  services/                     业务规则与任务生命周期
  repositories/state-repository.ts  JSON 格式校验、读取、保存与事务回滚
  infrastructure/               配置、密钥、模型 HTTP/SSE、文件和 Electron 适配
  domain/                       内部数据类型、系统能力契约、纯输入校验
src/preload/index.ts             白名单 window.dcode API
src/shared/                     DTO、IPC 通道、纯上下文/附件/强度规则
src/renderer/src/
  app/App.tsx                   初始快照、登录/工作台路由、主题
  features/auth/AuthScreen.tsx   账号界面
  features/settings/ModelSettings.tsx  服务设置
  features/chat/Workspace.tsx    会话、草稿、流更新与聊天工作台
  features/chat/components/     工具栏、强度、附件、Markdown、导航、云朵
  components/                   BrandMark、WorkspaceLayout 等通用组件
  styles.css                    主题、布局与动画
```

核心业务类：`Agent` 在 `agent.ts`，`AgentSession` 在 `agent-session.ts`；`Auth` 在 `auth-service.ts`，`Models` 在 `model-service.ts`；`StateService` 管理身份、账号归属、会话、偏好和公开快照；`StateRepository` 只管持久化；`DesktopService` 通过 `DesktopAccess` 契约使用 `ElectronDesktop`。`SecretCodec` 契约由 `Secrets` 实现。

Agent 框架参照 pi v1.0.4 的职责划分，自行实现最小子集，没有引入 pi 包或完整运行时。依赖方向为 `AgentSession → Agent → AgentLoop → ModelStream`；参考源码与范围见 `SPEC-agent-loop.md`。

| 层与入口 | 当前职责 | 边界 |
| --- | --- | --- |
| `services/agent-loop.ts` · `run()` | 复制单次上下文，请求模型，顺序执行工具，追加结果并继续循环，上报消息/工具/轮次事件 | 不管理应用会话、存储或长期运行状态；模型调用函数由 bootstrap 注入 |
| `services/agent.ts` · `prompt/replaceMessages/subscribe/abort/waitForIdle` | 注册工具并编译 Schema，拥有完整消息、草稿、公开状态、取消控制器与运行 Promise；更新状态后通知订阅者 | 不依赖应用存储、IPC 或 Electron；运行期间拒绝新 prompt 和上下文替换 |
| `services/agent-session.ts` · `send/stop` | 准备当前应用会话历史，创建回复占位，订阅 Agent，保存并推送聊天消息 | 不直接请求模型、执行工具或创建取消控制器 |
| `infrastructure/model-client.ts` 与 `llm/` | HTTP、协议选择、SSE 解码，以及 OpenAI/Anthropic 双向消息转换 | 供应商字段不进入循环或应用会话逻辑 |

`domain/agent.ts` 定义状态、上下文和生命周期事件；`domain/llm.ts` 定义统一消息、模型端口与工具契约。`bootstrap.ts` 手动装配各层，生产入口为 `new Agent(loop, [])`。每个应用主进程启动时只创建一组 Loop、Agent 和 AgentSession；不同提问与会话复用这些实例，每次发送替换历史上下文，每次 prompt 创建独立取消控制器与运行 Promise。当前全应用只能同时运行一个生成任务。

事件方向为 `Loop.emit → Agent.publish → 订阅者 → AgentSession.onEvent → StreamEvent → 窗口`。AgentSession 构造时登记同步订阅；AgentEvent 不含应用会话 ID，Session 用当前 target 将事件对应到聊天消息。对外状态快照、事件副本和推送消息均复制，工具 handler 与 API Key 不进入公开状态。

依赖约束：app 装配各层；Controller 连接 Router/Service；Service 可用 Repository/infrastructure/domain，但不得导入 Electron、Controller、IPC 或窗口；Repository 不依赖业务层；infrastructure 不依赖 Service；domain/shared 不导入 Node/Electron/UI。renderer 不导入 main/preload/Node/Electron，通用 components 不反向依赖 features。架构测试检查边界与循环依赖，并单独约束 AgentSession/Agent/AgentLoop 的依赖方向。未引入 DI 框架或数据库。

## 4. 启动与对话链路

启动：`main/index.ts → startApplication → app.whenReady → 配置/StateRepository/StateService/Secrets/Models/Auth → auth.restore → AgentLoop/Agent/AgentSession/MainWindow/DesktopService/IpcRouter → 注册 Controller → 创建窗口`。macOS 关闭窗口保留应用；关闭窗口或退出时有生成任务就先停止并保存。

请求链路：`React → window.dcode → preload ipcRenderer.invoke → IpcRouter → Controller → Service → Repository 或 infrastructure`。IPC 请求返回 `Result<T>`（成功 value / 失败 error），Snapshot 是裁剪后的公开状态，不含密码、令牌或密钥。

对话生命周期：

1. ChatController 获取 `Models.selected()`，解密当前服务密钥并组装单次配置；互斥入口拒绝生成期间的新修改，停止入口不受此锁阻止。
2. `AgentSession.send()` 校验并调用 `StateService.begin()`，保存用户消息和 streaming 回复占位；用成功历史替换 Agent 上下文，prompt 当前问题，立即返回初始 Snapshot。
3. Agent.prompt 同步占用运行状态并创建取消控制器，微任务中启动 `AgentLoop → streamModel → fetch → 对应供应商 SSE 适配器`；解析正文、推理和完整工具调用。模型回复有工具调用时，校验 JSON Schema 后顺序执行，追加统一工具结果再请求；没有调用、结束原因为 stop 且包含非空正文时结束。循环最多 8 次模型请求，第 8 次仍要求工具时在执行前报上限；断流/截断/错误参数不执行半截调用，取消后不继续下一轮。
4. Agent 先用循环事件更新运行状态，再同步通知订阅者。AgentSession 消费 message_update 累加文本，约每 500ms 保存、每 30ms 推送完整消息副本；agent_end 中更新 complete/stopped/error、保存并推送最终消息，Agent 随后释放运行占用。
5. 流事件经 `MainWindow.publish → webContents.send → preload.onStream → Workspace` 按消息 ID 合并。Workspace 缓存事件，避免初始 Snapshot 覆盖更新的流内容；不能依靠微任务调度保证跨进程响应先后。
6. `AgentSession.stop()` 调用 Agent.abort，再 await Agent.waitForIdle 等循环及终止订阅者保存完成，然后返回快照；await 不阻塞事件循环。生成默认 60 秒空闲超时，每批非空字节（包括心跳）重置，不是整个回答的总时长；退出 finally 清掉计时器。模型列表是 15 秒总超时。

## 5. 上下文、模型元数据与附件

- `src/shared/context.ts` 是请求上下文与 UI 估算的共同入口：包含 system 提示、成功历史轮次及当前问题；失败/停止历史和推理内容不作为有效历史发送。重试复用当时附件文本，不重新读磁盘。
- 完整 assistant 与工具结果保留在 Agent 内存状态，下一轮适配器按目标协议回传。独立 Agent 可以连续 prompt 保留上下文；应用会话每次发送重新载入成功问答文本，避免账号/会话串用。Anthropic 多个 toolResult 合并为紧随 assistant 的 user 消息；推理签名/加密块仅向原协议、服务与模型回传。跨用户轮次沿用成功问答文本，不保存或重放工具消息。本轮没有执行状态机、审批、单工具超时、后台任务或断点续跑。
- token 估算为 UTF-8 字节数 / 3 加消息开销，含草稿和附件，不是服务实测。窗口读取 `/models` 中的 `context_window`、`context_length` 或 `top_provider.context_length`；缺失时仍显示未知，不编造窗口。
- 强度读取 `effort.supported_levels` 与 `effort.default_level`。服务若只返回 ID，应用无法凭 ID 推断窗口和强度；需要后续明确的元数据来源才能补齐。
- 文件选择通过原生选择器，主进程读取 UTF-8 文本快照，随消息保存和发送；没有持续监听目录或保存可执行工程权限。
- 文件夹不设文件数量、单文件大小、总文本大小配额；空目录也可保留。仍跳过隐藏项、依赖/构建目录、符号链接、二进制、非 UTF-8 和空白文件。大目录仍受本机资源与服务上下文窗口限制，当前没有自动压缩/分块检索。
- 独立文件沿用限制：单文件 128KiB、一次读取最多 50 个有效文件、每条消息最多 10 个独立文件附件、独立文件文本合计 512KiB；目录不计入这些配额。

## 6. 配置、数据与安全

- 环境变量仅使用通用 `BASE_URL`、`API_KEY`，无内置服务地址/密钥/模型 ID。开发从根目录 `.env.local` 读取，系统已有变量优先；当前工作区已有此文件，不要用示例覆盖。本文不包含真实密钥。
- 完整环境配置仅导入首个注册账号，之后以账号保存的配置为准；改环境文件不会覆盖现有账号。打包后从 userData 下 `.env.local` 或系统环境读取，也可在界面配置。
- macOS 数据：`~/Library/Application Support/DCode/state.json`；`DCODE_USER_DATA_DIR` 可覆盖以隔离测试。当前 schema 3，没有旧版本迁移实现；损坏文件拒绝覆盖。
- StateRepository 临时文件写入后 rename 原子替换，transaction 失败回滚内存数据；StateService 同时回滚运行时认证身份，启动将遗留 streaming 标记为 stopped。
- 密码为随机盐+scrypt 哈希；保持登录通过随机令牌、哈希及 safeStorage 密文实现，不保存明文密码。API Key 使用 safeStorage 加密，不向 renderer 回显；聊天正文仍是本机 JSON。安全存储不可用时拒绝明文保存。
- 模型地址要求 HTTPS，本机 localhost/127.0.0.1 可用 HTTP；请求拒绝重定向。窗口启用 contextIsolation/sandbox，关闭 nodeIntegration，拒绝页面导航、新窗口及权限请求；IPC 只接受当前窗口主 frame。
- Markdown 不加载远端图片/HTML，外链经主进程校验后交系统浏览器。`.env.local`、构建和测试输出均忽略，不打包秘密配置。

## 7. 运行与验证

需要 Node.js 22.12+ 和 npm；已有工作区直接启动，不要重建本地数据或环境文件。

```sh
npm ci                  # 首次安装或锁文件改变后
npm run dev             # 开发、界面热更新
npm run typecheck
npm test
npm run test:e2e         # 先生产构建，再运行本地模拟模型服务 E2E
npm run build
npm start               # 预览 out/ 构建
npm run pack            # 当前系统应用目录到 release/
```

最近验证（2026-10-07）：当前源码类型检查、12 个文件共 94 个单元测试通过；生产构建在请求参数修正后通过，此后源码仅补充注释。最近一次本地 Electron E2E 为 Agent 分层和双协议框架的 6 项通过；请求参数修正后未重复 E2E。真实服务 smoke 默认跳过，未为本轮请求参数修正调用真实模型服务。

本交接整理只修改文档，使用差异与文件引用检查，不重复代码测试。上述验证记录不是新窗口当前状态的保证，后续修改需按范围重新验证。`DCODE_LIVE_TEST=1 npm run test:e2e` 才开启真实模型请求；不要在常规验证中自行开启。

测试入口：`tests/unit/architecture.test.ts` 检查依赖边界/循环；`ipc.test.ts` 检查来源、结果、互斥和停止；其余覆盖认证、存储、配置、模型/SSE、附件；`tests/e2e/chat.spec.ts` 覆盖完整桌面交互。打包应用不会随着源码修改自动更新，需重新 pack。

`llm.test.ts` 验证两种协议转换、UTF-8/工具 JSON 分块、签名与工具结果分组、原生模型分页与畸形流；`agent.test.ts` 验证两种供应商的多轮工具循环、参数校验、失败回传、取消和轮次上限；`agent-runtime.test.ts` 验证独立 Agent 的事件/状态、上下文保留、订阅隔离、并发和错误收尾；`agent-session.test.ts` 验证会话切换、停止与最终保存。Electron E2E 增加协议选择、原生工具错误回传与重启场景；测试工具只在隔离测试中注入。

## 8. 后续开发约定与阅读入口

- 先读根目录 `AGENTS.md`，开始时检查实际 Git 状态并保留用户既有改动与本地数据；新功能按项目分支规则记录。本文省略提交历史和推送过程，不能代替 AGENTS.md。
- 前端统一 AntD；写组件前用 `npm exec -- antd info <组件>` 查实际 API，引用其他符号/类名前先搜索确认；不确定 Electron/TS API 时先查 Context7。
- 新 IPC 功能按 shared DTO/通道 → preload 白名单 → Controller → Service 添加；网络/系统适配进 infrastructure，磁盘格式进 domain/Repository，新 UI 进对应 feature。不要把业务重新堆回 main/index.ts。
- 功能先写必要 SPEC 再开发，修改应精准，避免猜测性功能/抽象；类和核心方法注释职责及依赖。界面只保留完成操作必需的文字，说明口径放 doc。
- Git 提交使用中文，正文包含本次用户原始提示词；提交前核对作者与邮箱，并只记录本次相关文件。当前未跟踪的 `.idea/` 属于用户已有内容，不纳入功能提交或清理；本地数据、`.env.local` 同样保留。
- 详细规格：`SPEC-architecture.md`（分层）、`SPEC-agent-loop.md`（pi v1.0.4 参考、简洁循环与统一消息层）、`SPEC-account-models.md`（账号）、`SPEC-model-discovery.md`（服务/模型）、`SPEC-composer-tools.md` / `SPEC-composer-motion.md`（工具/动画）、`SPEC-sidebar.md`、`SPEC-message-navigation.md`、`SPEC-welcome-workspace.md`、`SPEC-app-icon.md`。
- 早期 README/SPEC 中的“所有附件都限额”“强度自动/默认三档”“按 DeepSeek 域名追加 thinking 或跳过快速模式”等已被当前实现替代，接手时优先看本摘要及相应源码。

## 9. Agent 扩展入口与当前边界

- 统一消息：`LlmMessage` 包含 system/user/assistant/toolResult；assistant 内容块包含 text/thinking/toolCall，结束原因为 stop 或 toolCall。工具结果以 toolCallId 对应原调用。`ModelStream` 通过回调提供正文/思考增量，通过 Promise 提供完整 assistant 回复；完整工具参数由适配器拼接和解析后才交付循环。
- 工具接入：实现 `AgentTool` 的 name、description、parameters 和 `execute(args, signal): Promise<string>`，从 bootstrap 注入 Agent。名称必须唯一、Schema 根类型为 object，Ajv 严格校验，不修正或转换模型参数。模型只接收声明，执行函数保留在主进程。未知工具、非法参数和执行失败形成错误 toolResult 供下一轮模型处理；测试工具只用于隔离测试。
- 上下文归属：Loop 对输入历史深拷贝后维护局部请求消息；Agent 通过 message_end 保存完整正式消息，message_update 只更新草稿。应用会话每次 send 重载成功问答文本，完整工具记录不跨用户轮次重放，也不写入磁盘；多轮模型正文仍显示为同一条应用 assistant 回复。
- 运行收尾：订阅者为同步回调，agent_end 通知完成后才释放 busy，waitForIdle 包含 Session 的最终同步保存。普通运行错误通过 outcome/error 记录；订阅者错误也可能使运行 Promise 拒绝，但最终清理仍执行。停止/失败后独立 Agent 不自动修复未配对工具消息，调用方需 replaceMessages 提供有效历史。
- 工具取消：waitForTool 使取消时可以停止等待不配合的异步工具，不强行终止工具，也不撤销副作用；同步阻塞操作仍会阻塞事件循环。后续具体工具必须自行配合 AbortSignal。
- 目前未实现：并行工具、生成队列、多 Agent 并发、steering/follow-up、上下文压缩、审批、单工具超时、后台任务、完整执行记录持久化与断点恢复。这里列出能力边界，不代表下一步自动实施的需求。

| 新功能涉及的职责 | 修改入口 |
| --- | --- |
| 具体业务工具 | 工具实现、`domain/llm.ts` 契约、bootstrap 注册 |
| 循环决策或工具调度 | `services/agent-loop.ts` |
| 运行状态与生命周期事件 | `services/agent.ts`、`domain/agent.ts` |
| 工具历史展示、会话保存与恢复 | `services/agent-session.ts`、shared DTO、存储层与 renderer |
| 新模型协议或供应商参数能力 | `infrastructure/llm/`、model-client、模型配置；使用明确配置或元数据，避免域名/模型名猜测 |

新对话可直接发送：

> 请先阅读项目根目录 AGENTS.md 和 doc/PROJECT-HANDOFF.md，检查当前源码与工作区状态，在保留既有功能和本地数据的基础上继续开发。接下来的需求是：……
