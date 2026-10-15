# 文件与命令工具

## 参考与范围

2026-10-07 核对 pi 最新发布为 [v1.0.4](https://github.com/earendil-works/pi/releases/tag/v1.0.4)，提交 `7c10bd4337495ee613f2224843ecdf349b80d1df`。参考该版本 [read](https://github.com/earendil-works/pi/blob/v1.0.4/packages/coding-agent/src/core/tools/read.ts)、[bash](https://github.com/earendil-works/pi/blob/v1.0.4/packages/coding-agent/src/core/tools/bash.ts)、[edit](https://github.com/earendil-works/pi/blob/v1.0.4/packages/coding-agent/src/core/tools/edit.ts)、[write](https://github.com/earendil-works/pi/blob/v1.0.4/packages/coding-agent/src/core/tools/write.ts) 的参数、截断与取消规则，自行实现本机工具，不引入 pi 运行时。

生产 Agent 注册 read、bash、edit、write。会话创建时选择绝对工作目录，取消选择则终止创建并保留当前会话；AgentSession 每次发送使用 Conversation.directory，重试和重启继续沿用。文件夹附件只提供快照，不改变工作目录。选择目录不自动读取其内容；详见 `SPEC-folder-conversations.md`。

路径支持相对工作目录、绝对路径及 `~/`；与 pi 一样，这不是文件系统沙箱，bash 具有当前系统账号的命令权限。选择器仍会读取文本快照；本次不改变既有附件展示，不增加审批、终端面板、执行记录持久化或后台任务。

## 工具模块与注入

2026-10-13 将工具声明和实现拆为独立模块，保留现有参数、输出和取消行为：

- `read.ts`、`bash.ts`、`edit.ts`、`write.ts` 分别导出 `ReadTool`、`BashTool`、`EditTool`、`WriteTool` 类，实现 `WorkspaceTool`，声明只读的 name、description、parameters，并显式标注 execute 的参数和返回类型。具体工具不依赖其他工具，也不依赖应用会话或存储。
- `tool-runtime.ts` 定义 `WorkspaceTool` 与执行上下文，并提供 `ToolRuntime.bind(tool): AgentTool`。负责本轮 cwd、会话内文件读取时间记录、取消检查、预期系统错误转换和临时目录清理；不导入、枚举或判断具体工具名称。
- `file-operations.ts` 提供文件路径解析、UTF-8 解码及同路径写入互斥；`output.ts` 提供输出截断。公共模块不依赖具体工具。
- `bootstrap.ts` 显式导入工具类，在会话工厂中用 `[new ReadTool(), new BashTool(), new EditTool(), new WriteTool()].map(tool => runtime.bind(tool))` 注入 Agent，为每个会话创建独立工具实例与 runtime，并将该 runtime 作为 ToolWorkspace 注入对应 AgentSession。目录在每次执行开始时捕获；账号/会话目录恢复规则不变。

新增本机工具时，在独立文件导出实现 WorkspaceTool 的类，并在 bootstrap 的数组中创建实例注册。无需修改其他工具、ToolRuntime、Agent 或 AgentLoop。不需要工作目录的工具可以直接实现 AgentTool 注入 Agent。暂不引入基类继承、动态扫描、插件加载器或依赖注入框架。

工具可声明只用于本地执行的 executionMode。ReadTool 为 parallel，BashTool、EditTool、WriteTool 为 sequential；未声明时默认串行。ToolRuntime.bind 与 Agent 注册保留该属性，模型只接收 name、description、parameters。ToolExecutor 将连续并行调用合组、串行调用各自成组，组间按源顺序等待；详见 `SPEC-tool-executor.md`。编辑版本校验由文件工具在现有同路径队列内执行，不进入通用执行器。

## 行为

- `read({ path, offset?, limit? })`：offset 为从 1 开始的整数，limit 为正整数。文本只读取有效 UTF-8，输出最多 2000 行或 50 KiB，优先保留完整行，返回可继续读取的 offset；单行超限时提示改用 bash。支持 PNG/JPEG/GIF/WebP 图片，以独立图片块传给模型；不增加图片缩放、BMP 转换或模型视觉能力猜测。
- `bash({ command, timeout? })`：执行 bash 命令，cwd 固定为本次选择目录；timeout 单位秒，不传时没有工具级默认超时。合并 stdout/stderr，返回最后 2000 行或 50 KiB；截断时完整内容保存在系统临时目录并返回路径，可继续用 read/bash 检查，应用退出清理。非零退出码和超时作为错误 toolResult 回传，停止终止命令及子进程。Windows 需要 PATH 中可用的 bash（如 Git Bash）。
- `edit({ path, edits: [{ oldText, newText }] })`：所有替换匹配原始文件，唯一且不重叠，统一校验成功后写入；不创建不存在的文件。优先精确匹配，缺失时参考 pi 对 Unicode 标点/空格、尾部空白做容错；未触及的行不因容错而重写。保留 UTF-8 BOM 和原有 LF/CRLF，拒绝空 oldText、歧义、重叠、没有变化的操作。返回成功信息和有界 unified diff。
- `write({ path, content })`：UTF-8 新建或完整覆盖，自动创建父目录；允许空内容。覆盖已有文件须先 read 且修改时间不变；新建文件无须 read。同一路径的 write/edit 串行，取消后正在进行的磁盘写入不能撤销，但不会释放互斥后让下一次写入与旧操作交错。

### 编辑前读取与版本检查

2026-10-15 为 edit 及 write 覆盖已有文件增加 Read-before-edit 与 Staleness check。每个会话的 ToolRuntime 保存 `Map<规范化绝对路径, mtimeMs>`，不缓存全文、不计算文件哈希、不持久化。相同目录的后续提问保留记录，工作目录变化或 runtime 清理时重置；不同会话不共享记录。

read 在读取前后比较原始精度的 mtimeMs，发生变化就失败；成功返回文本（包括分页、截断后实际返回的文本）才保存时间。失败、取消、单行超限而未返回文本、图片读取、附件和 bash 不建立可编辑文本的读取记录。edit 在获得路径队列后检查已读记录，并在读取当前内容前及写入前复核 mtimeMs；没有记录或时间不相等（包括时间回退、内容相同但时间变化）均返回预期工具错误，要求重新 read。

write 在获得路径队列、创建父目录后，紧邻写入前检查文件是否存在：已有文件须有已读记录且 mtimeMs 严格相等，否则拒绝覆盖并要求 read；不存在时使用独占创建，检查后若出现同名文件则拒绝覆盖。新建不建立已读记录，后续 edit 或 write 覆盖仍须 read。edit 及 write 覆盖成功后更新已有记录，支持连续修改；启动写入时移除旧记录，写入失败或写入期间取消后须重新 read。

本轮仅检查修改时间：内容改变但 mtimeMs 未变时可能漏检，也不保证最后一次检查与写入之间的外部修改被发现。分页读取不证明模型已看过文件的所有区域，原文匹配、唯一性及重叠检查继续执行。

主进程 infrastructure 承担磁盘/进程操作。AgentSession 仅根据会话配置工作目录；Agent/Loop 不读取系统路径。OpenAI 在配对工具结果后追加 user 图片消息，Anthropic 在 tool_result 中嵌入图片。预期工具错误可回传具体原因，未分类异常仍使用通用错误，避免泄露秘密。

## 工具执行状态

- 工具调用按发生时正文的 UTF-16 偏移穿插显示，形成“文字 → 调用行 → 后续文字”，不汇总到回复底部。行首显示垂直居中的状态圆点（执行中黄色、成功绿色、失败红色、停止灰色），工具图标无边框；不再显示行尾状态文字，状态仍供辅助技术读取。同名并行调用按调用 ID 区分。
- read/write/edit 调用行显示操作名和可点击文件名，例如 `read xxx.ts`、`write xxx.ts`、`edit xxx.ts`，保留工具图标与状态圆点，链接后无附加图标。bash 调用行显示工具名（执行中为“正在调用 bash 工具”），实际 command 在其下方的独立代码框展示，保留多行及参数，长命令自动换行。
- ToolExecutor 的开始事件携带参数副本，AgentSession 提取文件工具的有效 path、bash 的 command、正文偏移、调用 ID 和状态；不保存其他完整参数。更新仍立即随完整 StreamEvent 推送，不受正文节流影响。历史 bash 记录缺少 command 时不猜测补齐。
- 记录随回复保存至 state.json，切换会话和重启后仍可查看；完成、停止或报错时结算尚在运行的记录，启动恢复时将遗留 running 标记为 stopped。旧消息缺少此字段时按无记录处理，不改变 schema 版本。
- 记录不加入模型请求上下文。只有真实工具事件产生记录，模型直接使用附件快照回答或续写时不显示工具调用。

## 右侧文件预览

- 点击调用行的文件链接，在工作台右侧打开可调整宽度、关闭的只读面板；聊天和输入区保留，窄窗口收起会话栏。切换会话或删除会话时关闭预览，关闭预览不停止任务。
- read 预览本次实际读取的文本和起始行；write 预览写入后文本与写入前磁盘内容的统一差异；edit 预览修改后文本与已有 diff。“内容 / 修改”标签切换视图，差异使用增删着色，正文显示行号。
- 预览是调用时快照，随工具记录保存；主进程不向 renderer 开放任意路径读取，也不把预览再次加入模型请求。文本、差异各保留至多 2000 行或 50 KiB，分页或截断显示“部分内容”。失败、取消、图片读取和旧记录没有文本快照时显示对应状态。
- 已有记录缺少正文偏移时保留在回复末尾，缺少文件路径时只展示工具名；不从历史正文猜测路径、顺序或文件内容。

## 统一工具结果

2026-10-14 核对 pi 最新发布为 [v1.2.0](https://github.com/earendil-works/pi/releases/tag/v1.2.0)，参考其 [AgentToolResult](https://github.com/earendil-works/pi/blob/v1.2.0/packages/agent/src/types.ts) 与 [执行循环](https://github.com/earendil-works/pi/blob/v1.2.0/packages/agent/src/agent-loop.ts)，自行实现当前需要的子集，不引入 pi 依赖。

- AgentTool 和 WorkspaceTool 的 execute 统一返回 `Promise<AgentToolResult<TDetails>>`，取消字符串兼容。完整结果契约包含 `content` 文本/图片内容块数组、`details`（没有附加信息时为 undefined）及可选 `structuredContent`、`usage`、`isError`、`terminate`，与 pi v1.2.0 的字段保持一致；不增加进度回调。
- ToolExecutor 以 `isError === true` 确定返回结果的失败状态；工具抛出异常时生成错误结果，取消仍终止任务。最终 toolResult 含必填 isError，工具结束事件携带同一结果。内容块与 details 被复制，工具返回对象、订阅事件与 Agent 状态互不污染。
- read 在 details 返回文本总行数、下一页 offset、截断信息及 preview，图片直接作为 content 中的 image 块；write 在 details 返回文本与差异 preview；edit 保留原有有界 diff 并补充 preview；bash 返回退出码、超时状态以及可选截断信息和完整日志路径。bash 的非零退出与工具超时返回 isError: true，仍保留输出和 details；进程/日志系统故障继续抛出预期异常。
- structuredContent 为 JsonValue，支持 JSON 对象、数组、基本值和 null；usage 沿用 pi 的 token、缓存、推理及成本字段，描述工具自身的调用用量，不加入主对话上下文估算。两个字段都随工具结果保留在 Agent 状态和事件，成功与失败均不丢失。
- terminate 是整批工具结束后的终止提示：本轮所有工具结果都为 terminate: true 才结束，不再请求模型；混合结果、未知工具、非法参数和抛出的异常不触发该规则。仍先完成整批执行和结果事件，取消始终优先于正常终止。
- 模型适配层仅转换 content 与错误状态，不发送 details、structuredContent、usage 或 terminate；OpenAI 合并文字块，并在整批工具结果配对后追加图片消息，Anthropic 保留混合内容块的顺序。会话层仅保存预览所需的 preview，不保存完整工具结果、structuredContent、usage 或 terminate。

## 清理与任务错误

- ToolRuntime.dispose 逐个清理登记的临时目录；成功后立即移除登记，失败不阻止后续目录，汇总失败路径和原因向上抛出。失败目录保留，下一次 dispose 可重试；force 只忽略不存在的路径。应用退出入口用 try/catch 捕获并调用 reportError 统一记录和提示，删除会话失败由 IPC 返回给界面，不静默忽略。
- 模型、协议、参数和工具错误继续使用现有 Agent/Loop 错误路径。终止订阅失败也必须更新 Agent 的 error 状态并释放 busy；AgentSession 捕获启动或异步收尾失败，将固定目标回复标记为 error 并尝试保存和推送。保存或推送仍失败时抛出汇总异常，后台 Promise 的最终 catch 调用 app 注入的报告回调，同步失败通过 IPC 返回；业务层不定义日志或提示策略，也不依赖 Electron，不引入通用执行包装器。
- 停止包括最终保存，空闲会话也可以重试保存。窗口关闭和应用退出显式处理停止 Promise 的失败，不产生未处理拒绝；停止/保存失败时显示原因并保留窗口或应用，允许重试。普通取消仍保存部分回复后关闭，不撤销已发生的工具副作用。

## 验证

验证真实临时文件的分页、UTF-8/图片、截断、写入/覆盖、批量替换、失败不修改、BOM/CRLF/容错、取消及写入互斥；真实 bash 的 stdout/stderr、退出码、超时、停止子进程、截断和完整日志；会话目录恢复、重试、跨账号/会话隔离、旧数据兼容；双协议真实工具循环及图片回传。重构前后保留同一套行为测试，增加独立自定义工具的注入/上下文测试，并检查工具模块之间、公共运行层与具体工具之间无反向依赖。最后运行类型检查、单元测试、生产构建、本地 Electron E2E，不开启真实付费服务 smoke。
