# DCode

TypeScript + Electron 的 Coding Harness 基础框架。包含本地用户档案、独立会话、DeepSeek 流式对话，以及 React + Ant Design 桌面界面。

产品范围与验收要求见 [doc/SPEC.md](doc/SPEC.md)。当前版本只提供对话，不执行终端命令或读写代码工程。本地用户档案不等于服务端账号认证。

## 开发与启动

需要 Node.js 22.12+（推荐 Node.js 24 LTS）和 npm。

```sh
npm ci
cp .env.example .env.local
chmod 600 .env.local
# 编辑 .env.local，填入自己的 DEEPSEEK_API_KEY
npm run dev
```

本工作区已经配置 `.env.local`，不需要重新复制示例文件。开发模式支持界面热更新。

```sh
npm run build
npm start
```

`npm run pack` 生成当前系统可运行的应用目录到 `release/`；安装包分发、签名与公证不在首版范围。首次安装若 npm 拦截 Electron 下载脚本，执行 `node node_modules/electron/install.js` 下载运行时。

## 环境变量

| 变量 | 用途 | 默认值 |
| --- | --- | --- |
| `DEEPSEEK_BASE_URL` | OpenAI 兼容服务地址 | `https://api.deepseek.com` |
| `DEEPSEEK_API_KEY` | 模型 API 密钥，仅主进程读取 | 无 |
| `DEEPSEEK_MODEL` | 模型 ID | `deepseek-flash` |
| `DCODE_USER_DATA_DIR` | 覆盖本地数据目录，供测试隔离使用 | Electron userData |

启动时加载根目录 `.env.local` 到 `process.env`，系统已有环境变量优先。打包后的应用改为读取 userData 目录下的 `.env.local` 或系统环境变量。通过 Finder 启动通常不会继承终端变量，建议配置 userData 中的文件。修改配置后重启应用。

密钥不传入 renderer；设置页只显示配置状态。`.env.local` 被 Git 忽略，发布文件白名单只包含编译代码与包元数据，不包含环境文件。请求只向配置的服务发出，不跟随 HTTP 重定向。

DeepSeek 模型 ID 已通过账户 `/models` 接口确认，基础聊天使用 Flash 非思考模式。接口参考：[DeepSeek Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/)。

## 数据与操作

macOS 默认数据文件：`~/Library/Application Support/DCode/state.json`。Windows 与 Linux 使用 Electron 对应的用户数据目录。用户、会话、主题偏好保存在此文件中，写入使用临时文件原子替换；请在应用关闭后备份数据。

- `Enter` 发送，`Shift + Enter` 换行；中文输入法组词时不会发送。
- `Cmd/Ctrl + N` 新对话。
- 生成中点击停止按钮，保留部分回复；可重新生成最后一个回答。
- 搜索匹配标题与消息正文。用户切换后只展示该用户的会话。
- 删除会话或用户需要确认，最后一名用户不可删除。
- Markdown 代码块可复制，外部链接在系统浏览器打开，远端图片及 HTML 不加载。

## 检查与测试

```sh
npm run typecheck
npm test
npm run test:e2e
```

单元测试验证存储、用户隔离、上下文与 SSE 协议；E2E 启动真实 Electron 窗口，使用本地测试服务验证流式显示、停止/重试、复制、用户管理、会话管理、主题、窄窗口与重启恢复。测试用户数据在系统临时目录中，结束后删除。

真实 DeepSeek 测试默认关闭，以免常规测试发起付费请求。可显式执行：

```sh
DCODE_LIVE_TEST=1 npm run test:e2e
```

该测试读取本地环境配置，发送一条短消息；不会输出密钥。它会与本地服务 E2E 一起运行。

## 项目结构

```text
src/main/       窗口、安全 IPC、配置、持久化和模型请求
src/preload/    受限桌面 API
src/shared/     跨进程类型及通道
src/renderer/  对话界面、用户与主题设置、Markdown
tests/unit/     存储与流协议测试
tests/e2e/      Electron 全链路测试
doc/SPEC.md     首版规格
```

UI API 查询使用项目自带 CLI，例如 `npx --no-install antd info Button`。Electron 安全机制参考：[官方安全文档](https://www.electronjs.org/docs/latest/tutorial/security)。
