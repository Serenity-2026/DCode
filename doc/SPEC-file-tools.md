# 文件与命令工具

## 参考与范围

2026-10-07 核对 pi 最新发布为 [v1.0.4](https://github.com/earendil-works/pi/releases/tag/v1.0.4)，提交 `7c10bd4337495ee613f2224843ecdf349b80d1df`。参考该版本 [read](https://github.com/earendil-works/pi/blob/v1.0.4/packages/coding-agent/src/core/tools/read.ts)、[bash](https://github.com/earendil-works/pi/blob/v1.0.4/packages/coding-agent/src/core/tools/bash.ts)、[edit](https://github.com/earendil-works/pi/blob/v1.0.4/packages/coding-agent/src/core/tools/edit.ts)、[write](https://github.com/earendil-works/pi/blob/v1.0.4/packages/coding-agent/src/core/tools/write.ts) 的参数、截断与取消规则，自行实现本机工具，不引入 pi 运行时。

生产 Agent 注册 read、bash、edit、write。现有文件夹选择器返回绝对路径，随附件保存；每次发送从当前会话最近一次文件夹附件恢复工作目录，重试复用该轮目录，新会话和其他账号不沿用。旧附件没有路径时，须重新选择目录。未选择目录时四个工具返回可处理的错误，不使用应用启动目录。工作目录作为本轮 system 上下文交给模型。

路径支持相对工作目录、绝对路径及 `~/`；与 pi 一样，这不是文件系统沙箱，bash 具有当前系统账号的命令权限。选择器仍会读取文本快照；本次不改变既有附件展示，不增加审批、终端面板、执行记录持久化或后台任务。

## 工具模块与注入

2026-10-13 将工具声明和实现拆为独立模块，保留现有参数、输出和取消行为：

- `read.ts`、`bash.ts`、`edit.ts`、`write.ts` 分别导出 `ReadTool`、`BashTool`、`EditTool`、`WriteTool` 类，实现 `WorkspaceTool`，声明只读的 name、description、parameters，并显式标注 execute 的参数和返回类型。具体工具不依赖其他工具，也不依赖应用会话或存储。
- `tool-runtime.ts` 定义 `WorkspaceTool` 与执行上下文，并提供 `ToolRuntime.bind(tool): AgentTool`。只负责本轮 cwd、取消检查、预期系统错误转换和临时目录清理；不导入、枚举或判断具体工具名称。
- `file-operations.ts` 提供文件路径解析、UTF-8 解码及同路径写入互斥；`output.ts` 提供输出截断。公共模块不依赖具体工具。
- `bootstrap.ts` 显式导入工具类，在会话工厂中用 `[new ReadTool(), new BashTool(), new EditTool(), new WriteTool()].map(tool => runtime.bind(tool))` 注入 Agent，为每个会话创建独立工具实例与 runtime，并将该 runtime 作为 ToolWorkspace 注入对应 AgentSession。目录在每次执行开始时捕获；账号/会话目录恢复规则不变。

新增本机工具时，在独立文件导出实现 WorkspaceTool 的类，并在 bootstrap 的数组中创建实例注册。无需修改其他工具、ToolRuntime、Agent 或 AgentLoop。不需要工作目录的工具可以直接实现 AgentTool 注入 Agent。暂不引入基类继承、动态扫描、插件加载器或依赖注入框架。

## 行为

- `read({ path, offset?, limit? })`：offset 为从 1 开始的整数，limit 为正整数。文本只读取有效 UTF-8，输出最多 2000 行或 50 KiB，优先保留完整行，返回可继续读取的 offset；单行超限时提示改用 bash。支持 PNG/JPEG/GIF/WebP 图片，以独立图片块传给模型；不增加图片缩放、BMP 转换或模型视觉能力猜测。
- `bash({ command, timeout? })`：执行 bash 命令，cwd 固定为本次选择目录；timeout 单位秒，不传时没有工具级默认超时。合并 stdout/stderr，返回最后 2000 行或 50 KiB；截断时完整内容保存在系统临时目录并返回路径，可继续用 read/bash 检查，应用退出清理。非零退出码和超时作为错误 toolResult 回传，停止终止命令及子进程。Windows 需要 PATH 中可用的 bash（如 Git Bash）。
- `edit({ path, edits: [{ oldText, newText }] })`：所有替换匹配原始文件，唯一且不重叠，统一校验成功后写入；不创建不存在的文件。优先精确匹配，缺失时参考 pi 对 Unicode 标点/空格、尾部空白做容错；未触及的行不因容错而重写。保留 UTF-8 BOM 和原有 LF/CRLF，拒绝空 oldText、歧义、重叠、没有变化的操作。返回成功信息和有界 unified diff。
- `write({ path, content })`：UTF-8 新建或完整覆盖，自动创建父目录；允许空内容。同一路径的 write/edit 串行，取消后正在进行的磁盘写入不能撤销，但不会释放互斥后让下一次写入与旧操作交错。

主进程 infrastructure 承担磁盘/进程操作。AgentSession 仅根据会话配置工作目录；Agent/Loop 不读取系统路径。OpenAI 在配对工具结果后追加 user 图片消息，Anthropic 在 tool_result 中嵌入图片。预期工具错误可回传具体原因，未分类异常仍使用通用错误，避免泄露秘密。

## 统一工具结果

2026-10-14 核对 pi 最新发布为 [v1.2.0](https://github.com/earendil-works/pi/releases/tag/v1.2.0)，参考其 [AgentToolResult](https://github.com/earendil-works/pi/blob/v1.2.0/packages/agent/src/types.ts) 与 [执行循环](https://github.com/earendil-works/pi/blob/v1.2.0/packages/agent/src/agent-loop.ts)，自行实现当前需要的子集，不引入 pi 依赖。

- AgentTool 和 WorkspaceTool 的 execute 统一返回 `Promise<AgentToolResult<TDetails>>`，取消字符串兼容。完整结果契约包含 `content` 文本/图片内容块数组、`details`（没有附加信息时为 undefined）及可选 `structuredContent`、`usage`、`isError`、`terminate`，与 pi v1.2.0 的字段保持一致；不增加进度回调。
- Loop 以 `isError === true` 确定返回结果的失败状态；工具抛出异常时生成错误结果，取消仍终止任务。最终 toolResult 含必填 isError，工具结束事件携带同一结果。内容块与 details 被复制，工具返回对象、订阅事件与 Agent 状态互不污染。
- read 在 details 返回文本总行数、下一页 offset 和截断行数/字节数，图片直接作为 content 中的 image 块；write 返回文本块且 details 为 undefined；edit 返回文本块并在 details 保存有界 diff；bash 返回退出码、超时状态以及可选截断信息和完整日志路径。bash 的非零退出与工具超时返回 isError: true，仍保留输出和 details；进程/日志系统故障继续抛出预期异常。
- structuredContent 为 JsonValue，支持 JSON 对象、数组、基本值和 null；usage 沿用 pi 的 token、缓存、推理及成本字段，描述工具自身的调用用量，不加入主对话上下文估算。两个字段都随工具结果保留在 Agent 状态和事件，成功与失败均不丢失。
- terminate 是整批工具结束后的终止提示：本轮所有工具结果都为 terminate: true 才结束，不再请求模型；混合结果、未知工具、非法参数和抛出的异常不触发该规则。仍先完成整批执行和结果事件，取消始终优先于正常终止。
- 模型适配层仅转换 content 与错误状态，不发送 details、structuredContent、usage 或 terminate；OpenAI 合并文字块，并在整批工具结果配对后追加图片消息，Anthropic 保留混合内容块的顺序。这些附加字段仅留在本次运行状态与事件，不写入应用对话历史。

## 清理与任务错误

- ToolRuntime.dispose 逐个清理登记的临时目录；成功后立即移除登记，失败不阻止后续目录，汇总失败路径和原因向上抛出。失败目录保留，下一次 dispose 可重试；force 只忽略不存在的路径。应用退出由已有原生错误框提示，删除会话失败由 IPC 返回给界面，不静默忽略。
- 模型、协议、参数和工具错误继续使用现有 Agent/Loop 错误路径。终止订阅失败也必须更新 Agent 的 error 状态并释放 busy；AgentSession 捕获启动或异步收尾失败，将固定目标回复标记为 error 并尝试保存和推送。保存或推送仍失败时，由 app 注入的错误报告回调显示原生错误框；业务层不依赖 Electron。
- 停止包括最终保存，空闲会话也可以重试保存。窗口关闭和应用退出显式处理停止 Promise 的失败，不产生未处理拒绝；停止/保存失败时显示原因并保留窗口或应用，允许重试。普通取消仍保存部分回复后关闭，不撤销已发生的工具副作用。

## 验证

验证真实临时文件的分页、UTF-8/图片、截断、写入/覆盖、批量替换、失败不修改、BOM/CRLF/容错、取消及写入互斥；真实 bash 的 stdout/stderr、退出码、超时、停止子进程、截断和完整日志；会话目录恢复、重试、跨账号/会话隔离、旧数据兼容；双协议真实工具循环及图片回传。重构前后保留同一套行为测试，增加独立自定义工具的注入/上下文测试，并检查工具模块之间、公共运行层与具体工具之间无反向依赖。最后运行类型检查、单元测试、生产构建、本地 Electron E2E，不开启真实付费服务 smoke。
