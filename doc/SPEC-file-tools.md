# 文件与命令工具

## 参考与范围

2026-10-07 核对 pi 最新发布为 [v1.0.4](https://github.com/earendil-works/pi/releases/tag/v1.0.4)，提交 `7c10bd4337495ee613f2224843ecdf349b80d1df`。参考该版本 [read](https://github.com/earendil-works/pi/blob/v1.0.4/packages/coding-agent/src/core/tools/read.ts)、[bash](https://github.com/earendil-works/pi/blob/v1.0.4/packages/coding-agent/src/core/tools/bash.ts)、[edit](https://github.com/earendil-works/pi/blob/v1.0.4/packages/coding-agent/src/core/tools/edit.ts)、[write](https://github.com/earendil-works/pi/blob/v1.0.4/packages/coding-agent/src/core/tools/write.ts) 的参数、截断与取消规则，自行实现本机工具，不引入 pi 运行时。

生产 Agent 注册 read、bash、edit、write。现有文件夹选择器返回绝对路径，随附件保存；每次发送从当前会话最近一次文件夹附件恢复工作目录，重试复用该轮目录，新会话和其他账号不沿用。旧附件没有路径时，须重新选择目录。未选择目录时四个工具返回可处理的错误，不使用应用启动目录。工作目录作为本轮 system 上下文交给模型。

路径支持相对工作目录、绝对路径及 `~/`；与 pi 一样，这不是文件系统沙箱，bash 具有当前系统账号的命令权限。选择器仍会读取文本快照；本次不改变既有附件展示，不增加审批、终端面板、执行记录持久化或后台任务。

## 行为

- `read({ path, offset?, limit? })`：offset 为从 1 开始的整数，limit 为正整数。文本只读取有效 UTF-8，输出最多 2000 行或 50 KiB，优先保留完整行，返回可继续读取的 offset；单行超限时提示改用 bash。支持 PNG/JPEG/GIF/WebP 图片，以独立图片块传给模型；不增加图片缩放、BMP 转换或模型视觉能力猜测。
- `bash({ command, timeout? })`：执行 bash 命令，cwd 固定为本次选择目录；timeout 单位秒，不传时没有工具级默认超时。合并 stdout/stderr，返回最后 2000 行或 50 KiB；截断时完整内容保存在系统临时目录并返回路径，可继续用 read/bash 检查，应用退出清理。非零退出码和超时作为错误 toolResult 回传，停止终止命令及子进程。Windows 需要 PATH 中可用的 bash（如 Git Bash）。
- `edit({ path, edits: [{ oldText, newText }] })`：所有替换匹配原始文件，唯一且不重叠，统一校验成功后写入；不创建不存在的文件。优先精确匹配，缺失时参考 pi 对 Unicode 标点/空格、尾部空白做容错；未触及的行不因容错而重写。保留 UTF-8 BOM 和原有 LF/CRLF，拒绝空 oldText、歧义、重叠、没有变化的操作。返回成功信息和有界 unified diff。
- `write({ path, content })`：UTF-8 新建或完整覆盖，自动创建父目录；允许空内容。同一路径的 write/edit 串行，取消后正在进行的磁盘写入不能撤销，但不会释放互斥后让下一次写入与旧操作交错。

主进程 infrastructure 承担磁盘/进程操作。AgentSession 仅根据会话配置工作目录；Agent/Loop 不读取系统路径。保留字符串工具返回兼容，并扩展可带图片的结果；OpenAI 在配对工具结果后追加 user 图片消息，Anthropic 在 tool_result 中嵌入图片。预期工具错误可回传具体原因，未分类异常仍使用通用错误，避免泄露秘密。

## 验证

验证真实临时文件的分页、UTF-8/图片、截断、写入/覆盖、批量替换、失败不修改、BOM/CRLF/容错、取消及写入互斥；真实 bash 的 stdout/stderr、退出码、超时、停止子进程、截断和完整日志；会话目录恢复、重试、跨账号/会话隔离、旧数据兼容；双协议真实工具循环及图片回传。最后运行类型检查、单元测试、生产构建、本地 Electron E2E，不开启真实付费服务 smoke。
