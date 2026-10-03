# DCode 应用图标

## 设计

- 使用几何字母 D，左侧切口与短横线呼应代码输入光标。
- 深色圆角底板搭配冰蓝、靛蓝、紫色渐变，保留透明外边距。
- 图标以 SVG 为编辑源，PNG 为运行时资源，ICNS 为 macOS 打包资源。

## 接入与验收

- `build/icon.svg`：1024 × 1024 矢量源文件。
- `build/icon.png`：1024 × 1024 透明背景图标，开发模式及窗口使用。
- `build/icon.icns`：包含 16、32、64、128、256、512、1024 像素版本。
- Electron 主进程区分开发目录和 `process.resourcesPath`，设置 Dock 与窗口图标。
- electron-builder 配置 macOS ICNS，并将 PNG 复制到应用 Resources。
- 构建通过；确认应用包声明的图标存在且与源 ICNS 一致，运行时 PNG 与源文件一致。

## 修改图标

修改 SVG 后，将其重新渲染为 PNG，再用 macOS `sips` 生成标准 iconset 各尺寸，使用 `iconutil -c icns` 导出 ICNS。提交时同时更新三个资产，避免开发和打包图标不一致。
