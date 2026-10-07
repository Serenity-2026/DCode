# DCode 项目交接摘要

用途：给新对话恢复开发上下文。按 2026-10-07 的源码整理，只保留当前实现与设计约定，不记录问答、迭代过程和 GitHub 操作历史。详细规范在 `doc/SPEC*.md`，若早期文档与源码冲突，以当前源码和测试为准。

## 1. 项目目标与当前范围

- 项目根目录：`/Users/a1/Documents/open-source/DCode`。
- DCode 是 Electron 桌面 Coding Harness。目前完成本机账号、模型配置、流式对话和桌面交互框架。
- 技术栈：TypeScript 5.9、Electron 44、React 19、Ant Design 6；electron-vite 构建，electron-builder 打包；Vitest 单元测试、Playwright Electron E2E。
- 当前能与模型对话、把用户主动选择的文本文件/目录作为上下文，已接入简洁 function call / agent loop 和 OpenAI、Anthropic 统一消息层。生产工具列表为空，尚未实现终端执行、工程写入、云端账号同步或具体编码工具。不要把附件选择误认为已获得工程操作能力。
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
- 快速模式开启为蓝色实心闪电，关闭为描边；OpenAI 兼容协议使用 `service_tier: "priority"`，效果取决于服务支持。DeepSeek 官方域名与 Anthropic 原生协议不发送此参数。
- 模型强度由服务元数据决定：支持 `low/high/max` 就只展示这三档。白名单为 `minimal/low/medium/high/xhigh/max/ultra`，按顺序过滤；未返回档位显示“强度未知”，明确空列表显示“不支持推理”，均禁用。无猜测档位兜底。默认值优先服务默认档，选择按账号/服务/模型保存。
- 强度面板使用连续滑块，释放时取最近档位并保存一次；粗圆角轨道、动态粒子、平滑变化、键盘整档操作。OpenAI 兼容请求发送 `reasoning_effort`；DeepSeek 选择强度时同时启用 `thinking`。Anthropic 原生协议本轮不发送这些选项。
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

核心业务类：`Auth` 在 `auth-service.ts`，`Models` 在 `model-service.ts`，`Chat` 在 `chat-service.ts`；`StateService` 管理身份、账号归属、会话、偏好和公开快照；`StateRepository` 只管持久化；`DesktopService` 通过 `DesktopAccess` 契约使用 `ElectronDesktop`。`SecretCodec` 契约由 `Secrets` 实现。

代理链路：`domain/llm.ts` 定义统一 `LlmMessage`、text/thinking/toolCall 内容块和 toolResult。`AgentLoop` 只有顺序工具执行与继续请求的循环，通过 ModelStream 端口使用模型；`infrastructure/llm/openai.ts` 与 `anthropic.ts` 做双向协议转换，`sse.ts` 处理共享字节解码，`model-client.ts` 负责 HTTP 与协议选择，`tool-schema.ts` 通过 Ajv 编译参数定义。bootstrap 注入模型函数与空工具列表，后续具体工具仅在主进程装配时添加。

依赖约束：app 装配各层；Controller 连接 Router/Service；Service 可用 Repository/infrastructure/domain，但不得导入 Electron、Controller、IPC 或窗口；Repository 不依赖业务层；infrastructure 不依赖 Service；domain/shared 不导入 Node/Electron/UI。renderer 不导入 main/preload/Node/Electron，通用 components 不反向依赖 features。架构测试检查边界与循环依赖。未引入 DI 框架或数据库。

## 4. 启动与对话链路

启动：`main/index.ts → startApplication → app.whenReady → 配置/StateRepository/StateService/Secrets/Models/Auth → auth.restore → Chat/MainWindow/DesktopService/IpcRouter → 注册 Controller → 创建窗口`。macOS 关闭窗口保留应用；关闭窗口或退出时有生成任务就先停止并保存。

请求链路：`React → window.dcode → preload ipcRenderer.invoke → IpcRouter → Controller → Service → Repository 或 infrastructure`。IPC 请求返回 `Result<T>`（成功 value / 失败 error），Snapshot 是裁剪后的公开状态，不含密码、令牌或密钥。

对话生命周期：

1. ChatController 获取 `Models.selected()`，解密当前服务密钥并组装单次配置；互斥入口拒绝生成期间的新修改，停止入口不受此锁阻止。
2. `Chat.send()` 校验并调用 `StateService.begin()`，保存用户消息和 streaming 回复占位；记录 `{ controller, done }`，立即返回初始 Snapshot。
3. `setImmediate` 延迟启动异步生成，随后 `toLlmMessages → AgentLoop → streamModel → fetch → 对应供应商 SSE 适配器`；解析正文、推理和完整工具调用。模型回复有工具调用时，校验 JSON Schema 后顺序执行，追加统一工具结果再请求；没有调用且返回正文时结束。循环最多 8 次模型请求，断流/截断/错误参数不执行半截调用，取消后不继续下一轮。
4. Chat 累加文本，约每 500ms 保存、每 30ms 推送完整消息副本；最终更新 complete/stopped/error 并保存、清除 active、推送最终消息。
5. 流事件经 `MainWindow.publish → webContents.send → preload.onStream → Workspace` 按消息 ID 合并。Workspace 缓存事件，避免初始 Snapshot 覆盖更新的流内容；不能依靠 setImmediate 保证跨进程响应先后。
6. `Chat.stop()` 先 abort，再 await done 等取消后的 catch/finally 收尾，然后返回快照；await 不阻塞事件循环。生成默认 60 秒空闲超时，每批非空字节（包括心跳）重置，不是整个回答的总时长；退出 finally 清掉计时器。模型列表是 15 秒总超时。

## 5. 上下文、模型元数据与附件

- `src/shared/context.ts` 是请求上下文与 UI 估算的共同入口：包含 system 提示、成功历史轮次及当前问题；失败/停止历史和推理内容不作为有效历史发送。重试复用当时附件文本，不重新读磁盘。
- 本次循环的完整 assistant 与工具结果只在运行内保留，下一轮适配器按目标协议回传。Anthropic 多个 toolResult 合并为紧随 assistant 的 user 消息；推理签名/加密块仅向原协议、服务与模型回传。跨用户轮次沿用成功问答文本，不保存或重放工具消息。本轮没有执行状态机、审批、单工具超时、后台任务或断点续跑。
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

本轮验证：类型检查与生产构建通过，11 个文件共 82 个单元测试通过，6 个本地 Electron E2E 通过；真实服务 smoke 默认跳过。此记录不是新对话当前状态的保证，修改后按范围重新验证。`DCODE_LIVE_TEST=1 npm run test:e2e` 才开启真实模型请求；不要在常规验证中自行开启。

测试入口：`tests/unit/architecture.test.ts` 检查依赖边界/循环；`ipc.test.ts` 检查来源、结果、互斥和停止；其余覆盖认证、存储、配置、模型/SSE、附件；`tests/e2e/chat.spec.ts` 覆盖完整桌面交互。打包应用不会随着源码修改自动更新，需重新 pack。

`llm.test.ts` 验证两种协议转换、UTF-8/工具 JSON 分块、签名与工具结果分组、原生模型分页与畸形流；`agent.test.ts` 验证两种供应商的多轮工具循环、参数校验、失败回传、取消和轮次上限。Electron E2E 增加协议选择、原生工具错误回传与重启场景；测试工具只在隔离测试中注入。

## 8. 后续开发约定与阅读入口

- 先读根目录 `AGENTS.md`，开始时检查实际 Git 状态并保留用户既有改动与本地数据；新功能按项目分支规则记录。本文省略提交历史和推送过程，不能代替 AGENTS.md。
- 前端统一 AntD；写组件前用 `npm exec -- antd info <组件>` 查实际 API，引用其他符号/类名前先搜索确认；不确定 Electron/TS API 时先查 Context7。
- 新 IPC 功能按 shared DTO/通道 → preload 白名单 → Controller → Service 添加；网络/系统适配进 infrastructure，磁盘格式进 domain/Repository，新 UI 进对应 feature。不要把业务重新堆回 main/index.ts。
- 功能先写必要 SPEC 再开发，修改应精准，避免猜测性功能/抽象；类和核心方法注释职责及依赖。界面只保留完成操作必需的文字，说明口径放 doc。
- 详细规格：`SPEC-architecture.md`（分层）、`SPEC-agent-loop.md`（pi v1.0.4 参考、简洁循环与统一消息层）、`SPEC-account-models.md`（账号）、`SPEC-model-discovery.md`（服务/模型）、`SPEC-composer-tools.md` / `SPEC-composer-motion.md`（工具/动画）、`SPEC-sidebar.md`、`SPEC-message-navigation.md`、`SPEC-welcome-workspace.md`、`SPEC-app-icon.md`。
- 早期 README/SPEC 中的“所有附件都限额”“强度自动/默认三档”等已被当前实现替代，接手时优先看本摘要及相应源码。后续新需求由用户指定，当前没有额外待实现事项。

新对话可直接发送：

> 请先阅读项目根目录 AGENTS.md 和 doc/PROJECT-HANDOFF.md，检查当前源码与工作区状态，在保留既有功能和本地数据的基础上继续开发。接下来的需求是：……
