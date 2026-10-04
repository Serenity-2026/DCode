# DCode 基础对话 SPEC

现行账号与模型设置要求见 [SPEC-account-models.md](SPEC-account-models.md)。下文保留首版范围与验收记录。

版本：0.1 · 日期：2026-10-02 · 状态：首版已实现，2026-10-03 验收通过

## 1. 目标与边界

用 TypeScript + Electron 构建可运行的 Coding Harness 桌面应用首版。先交付本地用户管理、持久化多轮对话、DeepSeek 流式响应和参考 Codex 结构的精致界面。

用户管理在本版本指本机用户档案：创建、编辑名称、切换、删除；不同用户的会话互相隔离。这不是身份认证或权限隔离，不提供密码、云端登录、跨设备同步。首版不执行终端命令、不编辑工程文件、不集成 Agent 工具调用。

## 2. 核心流程

1. 首次启动自动创建默认本地用户，进入新对话。
2. 输入问题，Enter 发送，Shift+Enter 换行；中文输入法组合输入时 Enter 不发送。
3. 首次发送建立会话，标题从第一条问题生成；后续请求携带本会话已完成的上下文。
4. 模型文本逐步显示，支持 Markdown、代码块、表格和复制。代码及 Markdown 不执行 HTML。
5. 生成时可停止；保留已收到的文本并标记停止。错误保留问题与部分答案，展示可操作错误，支持重新生成最后一条答案。
6. 会话支持查找、切换、重命名和删除；删除需要确认。新对话不产生空白历史记录。
7. 用户管理支持创建、编辑、切换和删除，删除用户一并删除其会话且需要确认；不能删除最后一个用户。
8. 生成时禁止切换用户、切换/删除会话及重复发送；可停止后操作。
9. 退出应用或关闭窗口时取消请求；重启恢复档案、会话及最后的选择，未完成回复标记停止。

## 3. 界面

- 左侧固定宽度侧栏：品牌、新对话、搜索、按更新时间排序的会话、当前用户与设置。
- 顶部细窄标题栏：会话标题、模型信息、原生窗口控制与拖动区域。
- 主区域：克制留白、中央欢迎标题、三个可填入输入框的编码快捷问题；有消息时切换为有最大阅读宽度的对话流。
- 底部悬浮输入面板：多行输入、模型名称、发送/停止按钮。
- 采用暖灰白背景、墨黑文本、细边框、轻微阴影和绿色状态点；默认浅色，设置支持深色并保存偏好。
- UI 交互组件使用 Ant Design，通过 ConfigProvider 统一主题；图标使用 @ant-design/icons。控件具备中文可访问名称、键盘焦点和禁用状态。
- 主要操作、错误提示使用中文；界面不展示实现原理、未来规划或规格说明。

## 4. 技术架构

```text
src/main        Electron 窗口、IPC、环境配置、JSON 数据存储、模型流式请求
src/preload     contextBridge 白名单 API、流事件订阅/退订
src/shared      跨进程类型、IPC 通道常量
src/renderer    React + TypeScript + Ant Design、样式与 Markdown
tests           存储/流协议/聊天生命周期单元测试及 Electron 端到端测试
doc             SPEC 与运行说明
```

- 构建：electron-vite；开发时 renderer 热更新。提供 dev、typecheck、test、test:e2e、build、start、打包目录命令。
- 主进程持有所有数据与模型配置，renderer 不访问 Node、文件系统或密钥。
- 开启 contextIsolation、sandbox；关闭 nodeIntegration；阻止网页导航和新窗口；外部链接仅经校验后在系统浏览器打开。
- IPC 按动作白名单注册，主进程验证参数与当前用户/会话归属。流事件包含会话和消息 ID，避免错误更新其他对话。
- 数据使用 Electron userData 下的版本化 JSON。写入临时文件后原子替换；错误回滚内存状态，读取损坏数据时报告错误，不静默覆盖。
- 模型请求由主进程 fetch 发起，以 AbortController 停止，增量 TextDecoder 处理 UTF-8，按 SSE 帧解析；支持网络分块边界、注释心跳、[DONE]、推理文本和非正常断流。网络错误不得假装完成。
- 对话开始时持久化用户问题与 assistant 占位；流中节流保存，结束、失败和停止时保存最终状态。

## 5. 配置与凭据

开发环境使用项目根目录 `.env.local`，加入 `.gitignore`，文件权限为 0600；通过 dotenv 加载到主进程 `process.env`，已有系统环境变量优先。

```dotenv
BASE_URL=<模型服务地址>
API_KEY=<本地密钥>
```

环境变量与服务商无关，不内置服务地址或密钥。地址和密钥都非空时导入首个注册账号；缺少任一项时不创建默认服务，可注册后在设置中添加。已有账号配置不被环境文件覆盖。模型 ID 由服务的 `/models` 接口返回，用户在输入框选择，不通过环境变量固定。

发布后的应用读取系统环境变量，或 userData 目录里的 `.env.local`。凭据不进入 VITE_*、源码、构建产物、安装包、日志、SPEC 或提交信息。设置页显示服务配置，模型列表在输入框选择，不返回密钥。仓库提交需求原文时对密钥脱敏。

## 6. 数据模型

- User：id、name、createdAt。
- Conversation：id、userId、title、model、createdAt、updatedAt、messages。
- Message：id、role(user/assistant)、content、reasoning、status(complete/streaming/stopped/error)、error、createdAt。
- AppState：schemaVersion、users、activeUserId、activeConversationId、conversations、theme。

上下文排除失败/停止的 assistant 消息及其没有完成回答的问题，当前待回答问题始终作为最后一条 user 消息。重试保留最后的问题，重新建立 assistant 回复，不重复添加 user 消息。

## 7. 错误及限制

- 未配置密钥、401/403、余额不足、429、服务异常、网络故障、超时和断流显示简短中文提示；允许重试。
- 输入不能为空、单条消息最多 32,000 字符；用户名称 1–40 字符，会话标题 1–80 字符。
- 回复为 length/content_filter 结束时保存文本并标记错误，提示截断/过滤；不能伪装完整回答。
- 单窗口最多一个正在生成的请求；连接和流空闲超时取消；停止及时中断网络。
- 本地档案不是安全边界，同一 OS 用户能读取全部聊天数据。文件权限限制到当前 OS 用户，不包含账户密码。

## 8. 验收标准

1. `npm run typecheck` 与 `npm run build` 通过，Electron 窗口可启动。
2. 单元测试覆盖 UTF-8 跨块 SSE、心跳、推理、[DONE]、异常断流、HTTP 错误、取消、用户隔离、持久化、删除约束及重试上下文。
3. Electron E2E 使用本地流式测试服务验证实际主进程—preload—renderer：发送→逐步显示→完成；停止→保存；重试；用户切换隔离；重启后恢复。
4. 使用真实 DeepSeek 配置做短请求验证；若账户或服务拒绝，明确记录原因，不能以测试服务结果宣称真实连接成功。
5. 人工/截图检查初始页和对话页，确认布局、Markdown、主题与窄窗口可用。
6. Git 只提交本次文件，`.env.local` 忽略且构建无密钥；保留任务前已有的 AGENTS.md 修改。主题分支保留，未经用户批准不 push。

## 9. 实施顺序

1. 提交 SPEC 与忽略规则。
2. 搭建构建、类型与安全 IPC 骨架，实现存储和模型流服务。
3. 实现用户、会话、主题设置和高质感对话界面。
4. 完成单元测试、Electron 端到端验证、真实连接验证与文档，清理临时内容并提交。

## 10. 参考

- [Electron 安全与 IPC](https://www.electronjs.org/docs/latest/tutorial/security)
- [Ant Design CLI](https://ant.design/docs/react/cli/)
- [DeepSeek Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/)

## 11. 实际验收记录

2026-10-03，在 macOS arm64 / Node.js 24 环境验证：

| 检查 | 结果 |
| --- | --- |
| TypeScript 严格类型检查、生产构建 | 通过 |
| 单元测试 | 19 项通过，涵盖存储、协议、心跳超时、停止及异常断流保存 |
| 本地服务 Electron E2E | 通过，覆盖流式显示、停止/重试、实际剪贴板、用户与会话管理、主题、820×620 窗口及重启恢复 |
| 真实 DeepSeek Electron E2E | 通过，使用 deepseek-flash 收到“连接成功” |
| 开发模式 | 工作台成功显示 |
| 应用目录打包 | 通过，生成 release/mac-arm64/DCode.app，并验证 packaged 模式启动与环境文件读取 |
| 凭据检查 | 环境文件权限 0600 且被 Git 忽略；源码、历史、编译输出不包含密钥 |
| 视觉检查 | 欢迎页、对话页布局与 Markdown 显示通过 |

打包应用未做开发者签名与公证，当前只验证 macOS；Windows/Linux 的原生窗口与打包尚未在对应系统验证。配置与操作说明见 README.md。
