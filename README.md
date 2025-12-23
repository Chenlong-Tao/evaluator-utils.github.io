# evaluator-utils.github.io

一个简单的 GitHub Pages 工具页（纯静态、无依赖）：把 **Python SDK** 的
`client.chat.completions.create(...)` 请求参数做成 **可视化编辑器**，并在校验通过后输出 **压缩 JSON** 供复制。

> 说明：当前页面 **不包含 `messages` 字段**（已按你的需求移除）。

## 如何启用 GitHub Pages

- **如果这是 `username.github.io` 这种用户/组织主页仓库**：直接 push 到 `main` 分支，Pages 通常会自动从根目录发布。
- **如果这是普通仓库**：
  - 打开 GitHub 仓库页面 → `Settings` → `Pages`
  - `Build and deployment` 里选择：
    - **Source**: `Deploy from a branch`
    - **Branch**: `main` / `/ (root)`
  - 保存后等待 1~2 分钟即可访问。

## 本地预览

任意静态服务器都可以，例如用 Python（可选）：

```bash
python3 -m http.server 5173
```

然后打开 `http://localhost:5173/`。

## 目录结构

- `index.html`: 编辑器页面（表单 + 参数说明 + 输出）
- `assets/css/styles.css`: 样式（含浅色/深色主题）
- `assets/js/app.js`: 编辑器逻辑（实时校验 + 生成压缩 JSON + 复制提示 + 主题切换）
- `404.html`: GitHub Pages 的 404 页面
- `.nojekyll`: 禁用 Jekyll 处理，避免路径/构建差异

## 使用说明

- 在页面中填写 **model**（必填）。
- 页面不提供 `messages` 编辑（已按需求移除），输出 JSON 中也不会包含该字段。
- 其余字段按需填写；留空则不会出现在输出 JSON 里。
- 若任何字段类型/JSON 语法不合法，**输出区会保持为空**，并在错误区显示原因。
- 校验通过后，输出区会给出 **压缩 JSON**，点“复制输出 JSON”即可复制。

## 关于“全部参数”

`chat.completions.create` 可能会随着 SDK/后端演进新增字段。为避免你被页面“卡住”，编辑器提供了：

- `extra`：一个 JSON object，会与上面表单字段 **合并输出**（用于承接新增字段或兼容字段）。


