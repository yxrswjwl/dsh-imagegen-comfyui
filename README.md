# dsh-imagegen

<p align="center">
  <a href="https://www.npmjs.com/package/@dickpy/dsh-imagegen"><img src="https://img.shields.io/npm/v/@dickpy/dsh-imagegen?color=cb3837&logo=npm&label=npm" alt="npm" /></a>
  &nbsp;
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-3b82f6.svg" alt="License" /></a>
  &nbsp;
  <a href="https://github.com/dickpy/dsh-imagegen"><img src="https://img.shields.io/badge/platform-DeepSeek%20Harness-111827" alt="Platform" /></a>
</p>

<div align="center">

## DeepSeek Harness 的 AI 生图无限画布

**画布即工作台** —— 文本 / 图片 / 文件 / **工作流节点** 自由编排，ComfyUI 等渠道按节点驱动

[快速开始](#quick-start)&nbsp;&nbsp;·&nbsp;&nbsp;[无限画布](#canvas)&nbsp;&nbsp;·&nbsp;&nbsp;[配置](#configuration)&nbsp;&nbsp;·&nbsp;&nbsp;[交流群](#community)

</div>

`dsh-imagegen` 是 DeepSeek Harness（DSH）的 AI 生图插件，专门做**无限画布**：把文本、图片、文件和「工作流节点」自由编排到一张可以无限滚动的画布里，连线即触发生成。每个 ComfyUI 工作流的输入要求都不一样——挂一个**工作流节点**到画布上，插件自动读取这个工作流所需的文本输入、图片输入与高级参数，连上对应节点就能跑，无需手填表单。生成由宿主进程执行，不卡界面、不打断对话，图片也在画布里继续串接迭代。

<a id="quick-start"></a>
## 快速开始

前置条件：已安装 [DeepSeek Harness](https://github.com/deepseek-ai/DeepSeek-Harness) 和 Node.js 20+。

```bash
dsh plugin --profile web add @dickpy/dsh-imagegen
```

安装后重启 `dsh web`，侧边栏会出现一个新的“画布” Tab（Windows 如遇 PowerShell 脚本策略限制，请使用 `dsh.cmd`）。

首次使用：

1. 打开“设置 → 插件 → VisioWork”，添加一个 ComfyUI 或其他生图提供方，填入 API 地址和密钥，点击“检测可用模型”，勾选生图模型后保存。
2. 点开“画布” Tab，新建或挑一个已有的画布项目。
3. 在底部 Dock 选**工作流节点**，再选你配置好的工作流模型；插件会自动分析这个工作流需要哪些文本输入、图片输入和高级参数，把它们渲染成工作流节点上的端口和折叠面板。
4. 加一个**文本节点**写提示词，拖到工作流节点的文本端口连一条线，点工作流节点上的运行按钮即可出图；结果作为新的图片节点出现在画布里，可以继续连到下一个工作流节点迭代。

<details>
<summary><b>其他安装方式与升级</b></summary>

**让 Agent 帮你安装** —— 将下面内容直接发给 DSH、Codex 或其他 coding agent：

```text
用 dsh plugin --profile web add @dickpy/dsh-imagegen 安装 AI 生图插件。完成后重启 dsh web，侧栏会多出"画布" Tab，打开设置中的 VisioWork 配置添加 ComfyUI 渠道即可。
```

**从 Release 安装** —— 从 [GitHub Releases](https://github.com/dickpy/dsh-imagegen/releases) 下载目标版本的 tgz 后执行：

```bash
dsh plugin --profile web add <下载路径>/dickpy-dsh-imagegen-<版本号>.tgz
```

**升级与回滚** —— 重复执行 `add` 命令即可更新到最新版；面板打开时也会自动检测新版本，出现顶部横幅后可在线更新，完成后重启 `dsh web` 生效。渠道配置与画布数据由 DSH 宿主保存，正常升级不会清空。需要固定版本时，使用 `@dickpy/dsh-imagegen@<版本号>` 或指定 Release tgz。

</details>

<div align="center">
  <img src="docs/images/infinite-canvas-demo.gif" alt="无限画布演示：连线节点、悬停快速添加与弹簧 Dock" width="100%" />
</div>

<a id="canvas"></a>
## 无限画布

「画布」Tab 是一个可以无限滚动的节点画布：在画布上自由摆放文本节点、图片节点、文件节点和**工作流节点**，拖动节点两侧的端口圆点即可连线，按住空格或 Ctrl 平移画布，滚轮缩放（5%–500%）。

<div align="center">
  <img src="docs/images/infinite-canvas.png" alt="无限画布：文本与图片节点连线驱动工作流节点出图" width="100%" />
  <p><sub>文本节点提供提示词、图片节点作为参考图，连线到工作流节点即可出图并继续串接</sub></p>
</div>

- **工作流节点 = 唯一生成入口**：每个 ComfyUI 工作流的提示词槽、图片槽、模型 / 尺寸 / seed 等高级参数都不一样。挂一个工作流节点到画布上，插件自动调用工作流扫描器读出**这个工作流**实际需要的输入端口（文本 / 图片）与高级参数面板，无需手填表单。把文本 / 图片节点拖到对应端口连一条线，点工作流节点上的运行按钮即出图；结果作为新的图片节点出现在画布里，保留连线关系，可以继续串到下一个工作流节点迭代。
- **连线即数据流**：连线上有流向动画与箭头，一眼可见提示词和参考图从哪来到哪去。工作流节点上显示每个端口的已连接输入数；同一端口多源连接时按 z-order 取最上层一张。
- **进度与重试**：工作流节点运行时会实时显示 ComfyUI 进度（百分比 + 当前节点）；失败 / 取消有专属错误样式，点运行按钮可重试；`runCount` 一键设 1–4 张同时跑。
- **悬停快速添加**：鼠标放到节点右侧的加号上，直接弹出「文本 / 图片 / 工作流 / 文件」选择菜单，选中的新节点自动落到右侧并连线（自动避让已有节点并把画布带到新节点前）；按住加号拖动仍是自由连线，工作流节点后不再叠加工作流节点。
- **本地图片入库**：本地图片支持拖拽到画布、直接粘贴剪贴板截图、或在空白处右键「添加图片节点 / 上传图片」；空图片节点可点击上传。
- **图片节点工具**：图片节点悬停工具条提供四个能力 —— **标注**（在图片上拖框，松开后从框上拉出一条引导线并挂上一张提示词卡片：卡片跟随图片移动、不需要连任何线；生成时自动读取框与提示词，把红框烧进参考图并附带坐标约束；结果图会与干净原图合成，红框标记不会出现在成品里，框外区域也保证与原图一致；重试同样会重建标记图）、**移除背景**（本地抠图，直接产出带透明通道的 PNG，不消耗额度）、**图层拆分**（调用视觉聊天模型把图拆成背景 / 元素 / 文字图层节点，文字层可改字号、加粗与颜色，人物与装饰元素各自独立可移动）、**模型选择**（为这个节点指定模型，连接到工作流节点时按节点 > 工作流 > 全局默认的顺序挑选）。
- **文本节点排版**：文本节点头部可调字号（A- / A+）、加粗与文字颜色，图层拆分产出的文字层同样可直接编辑。
- **画布操作**：框选多选、Shift 加选、整体拖动、四角等比缩放、右键菜单、双击空白快速建节点、复制 / 粘贴 / 副本（Ctrl+C/V/D）、撤销重做（Ctrl+Z / Ctrl+Shift+Z）；把图片节点放大后再标注会更顺手，缩放后标注框按比例跟随。左下角小地图可点击跳转，底部工具条悬浮居中（reactbits Dock 式弹簧放大与悬浮标签）：文本、涂鸦、**文件**、**工作流**、**技能库**，以及背景 / 小地图 / 适应内容等视图项；其中「文件」直接弹出上传并把文件落成文件节点。
- **背景与视图**：13 种背景一键切换 —— 点阵 / 网格线 / 波浪线 / 滚动方格 / 点场 / 互动点阵 / 浮动线条 / 流体扰动 / 液态以太 / 故障终端 / 丝绸 / 星系 / 空白。其中一组移植自 [React Bits](https://www.reactbits.dev) 的动效背景并做了无依赖重写：「液态以太」是随鼠标搅动的 WebGL 流体速度场，「浮动线条」是指针会压弯的发光波形，「星系」是四层视差星野（鼠标推开星星），「丝绸」是缓慢流动的绸面光泽，「故障终端」是带扫描线与故障位移的 CRT 字符场；「波浪线 / 滚动方格 / 点场 / 互动点阵」为画布 2D 实现，支持鼠标扰动与点击冲击波。浅色 / 深色画布会自动切换明暗墨色，新建画布默认使用液态以太；「适应全部内容」一键回正视图。
- **数据与多窗口**：画布按项目保存在宿主数据目录（`~/.dsh/dsh-imagegen/canvas`），支持多项目管理与重命名；多窗口同时编辑时保存冲突自动按服务端进度重试合并；旧版本画布数据自动迁移到新结构。

### 文件节点

画布新增**文件节点**：在空白处右键「添加文件节点 / 上传文件」，或直接把文件拖进画布即可建节点；空节点点击也能上传。

- **任意文件**：单文件上限 50MB，宿主按内容寻址落盘（sha256），文档、表格、PDF、压缩包、音视频都可以放上来。
- **安全边界**：`.exe / .bat / .ps1 / .js / .html / .svg` 等脚本与可执行扩展名会被浏览器与宿主两侧拒绝；除下面列出的可预览类型外，资源一律以 `application/octet-stream` + `attachment` 返回，HTML/SVG 一类的标记永远不会被内联渲染。
- **节点内预览**：文件内容直接在节点里读，不用先下载，并尽量**按原文件的样子还原** ——
  - **Markdown**：渲染成富文本（标题、列表、表格、引用、代码块、链接），全屏可切「渲染 / 源码」；
  - **DOCX**：还原文档结构 —— 标题层级、加粗 / 斜体、项目与编号列表、表格；
  - **PPTX**：一页一张幻灯片卡片，显示页码、标题、正文要点与内嵌图片；
  - **文本 / 代码 / JSON / YAML / XML**：宿主解码后显示原文（上限 12 万字符，超出部分给出提示），带行数与滚动，首次渲染先用随资源下发的 8KB 摘要，随后补齐全文；
  - **CSV / TSV / XLSX**：解析成表格渲染（首行作为表头，最多 300 行 × 40 列），支持带引号的多行单元格；
  - **ODT / ODP**：从 ODF 容器中抽取正文文本；
  - **PDF**：交给浏览器内置阅读器内联显示（宿主以 `application/pdf` + `inline` 返回）；
  - **音频 / 视频**：`<audio>` / `<video>` 直接播放，宿主支持 HTTP Range，进度条可拖动；
  - **ZIP**：列出压缩包目录（名称 / 大小 / 文件夹，最多 400 项）；
  - 其他二进制（如 `.doc`、`.tiff`、7z/rar）给出本地化说明，仍可下载或用技能处理。
  - 以上解析都在宿主侧限量执行（字数 / 行数 / 页数 / 图片字节预算），超大文件只截断不卡顿。
- **全屏阅读器**：双击节点、点悬浮工具条的「放大预览」或右键菜单同名项，在浮层里查看全文 / 整表 / 整页 / 整副幻灯片，Markdown 可在「渲染 / 源码」间切换，可一键复制内容、在新标签页打开媒体、下载文件，Esc 或点遮罩关闭。
- **工具条**：技能、下载、放大预览、复制、删除。

### 画布技能

任意图片 / 文本 / 文件节点（工作流节点除外）的悬浮工具条与右键菜单都有**「技能」**入口，技能把节点内容交给模型或 Agent 继续加工，结果以新节点 + 连线回到画布（运行只产出草稿，仍由浏览器写入文档）。

内置动作：

| 技能 | 适用节点 | 说明 |
| --- | --- | --- |
| 文本润色 `polish.text` | 文本 | 更正式 / 更口语 / 更短 / 扩写，或自定义指令 |
| 图片描述 `describe.image` | 图片 | 视觉模型读出内容，产出可继续当提示词用的文本节点 |
| 内容抽取 `extract.content` | 文件、图片 | 文本 / 代码直接解码，OOXML（pptx/docx/xlsx）、ODF、PDF 抽取正文（PDF 依赖 FlateDecode 文本流，扫描件请配合 OCR 技能） |
| 图片转可编辑 PPT `ppt.fromImages` | 图片 | 重任务：驱动本机 `image-to-editable-ppt` 技能，产出 `.pptx` 文件节点 |

- **两层执行**：轻量技能直接调用「提示词增强」所配置的聊天模型（不额外占 Agent 会话）；重任务技能会启动一个**无头 DSH Agent**，把技能正文注入 Agent 的独立系统提示区，并在磁盘上物化输入文件（`<工作目录>/<画布>/<任务>/input|output`），让 Agent 用真实工具跑完整流水线。
- **运行卡片与连线**：技能开始执行的瞬间，源节点会**延生出一条流动虚线，连到一张运行卡片**上 —— 卡片显示技能名、轻量/重任务角标、阶段步骤条（排队 → 准备输入 → 执行 → 收集产物）、已用时，并可直接取消；重任务执行中每产出文件都会实时提示（如「已产出 2 个文件」）。完成后卡片自动让位给真正的结果节点与连线；失败时卡片保留错误信息，可一键重试或关闭。刷新页面或切换画布后，未完成的运行会自动恢复卡片。
- **重任务先确认**：长任务技能的菜单会标「重任务」角标，点击后弹出确认框，显示成本提示与前置条件；确认后才创建 Agent，并可在运行卡片上取消。
- **多节点批量**：多选同类型节点后运行技能会串行覆盖这些节点；一次最多 12 个输入节点。
- **多选与来源**：技能产出的节点带来源标记，指向它读了哪些节点。
- **随节点顺手润色**：文本节点工具条的 ✨ 按钮直接弹出风格菜单，一键覆盖原文（Ctrl+Z 撤销）；多选文本节点时同样按顺序批量处理。

#### 需要自己装的技能

画布会自动列出本机 `~/.dsh/skills` 下**可被模型调用**的所有技能（菜单里 id 形如 `skill:<名称>`），并按其自述与 frontmatter 判断轻量 / 重任务。`image-to-editable-ppt` 属于长任务技能，需要你自行安装；它的图片后端可以直接在下面的「技能配置」里填，插件会调用它自己的 `editppt config` 写进 `~/.editppt/config.yaml`。

#### 技能库（在线安装 / 上传安装）

底部 Dock 的**「技能库」**按钮打开管理面板，不用手敲文件系统：

- **在线安装**：粘贴 GitHub 仓库 / 仓库子目录 / 单个 `SKILL.md`（`blob` 链接）/ 任意 git 地址 / zip 地址，一行一个。GitHub 走 `codeload` 归档下载，**不依赖本机 git**；其他 git 地址回退到 `git clone --depth 1`（非交互、180 秒超时）。
- **上传安装**：点虚线框选择或直接把 zip **拖进虚线框**（≤50MB；解压后总量同样有上限）。压缩包先解到临时目录，确认里面有 `SKILL.md` 且 frontmatter 的 `name` 合法后才落到 `~/.dsh/skills`。在线安装区位于面板顶部，已安装列表移到下方，每条带大小与配置 / 卸载操作。
- **卸载**：列表里逐条删除（目录、以及扁平的 `<name>.md` 都能识别）。
- **热加载**：`~/.dsh/skills` 由宿主的技能监听器看着，装完即出现在技能菜单里，**不需要重启**。
- **没装也能看懂**：菜单里需要外部技能的行会标出「未安装」并给出「去安装」；运行失败若原因是技能缺失，提示条上直接带安装按钮并把上游地址填好。提示条现在固定在画布**顶部**，不会再被底部内容挡住。

#### 技能配置（技能自己声明，面板统一渲染）

技能过去只能靠文档手敲命令行或改 dotfile 配自己的密钥 / 后端。现在技能可以在 `SKILL.md` 旁边放一份 `skill.config.json` 声明要什么、怎么生效，技能库面板会把它渲染成表单：

- **字段**：`string` / `secret` / `boolean` / `number` / `select`，可标 `required`、给默认值与说明；
- **生效步骤**：`command`（无 shell、按数组参数执行技能自带的 CLI，如 `editppt config …`）或 `file`（物化一份配置文件，`~` 展开、拒绝 `..` 逃逸与 DSH 主目录控制文件）；
- **两个按钮**：「保存」只存值；「保存并应用」存完按顺序执行声明的步骤，并逐步回显结果；
- **密钥**：存进插件设置的 `role('secret')` 字典（脱敏存储），表单只显示「已设置 / 未设置」，命令回显里也会替换成 `•••`；密钥永不出现在运行目录、清单或提示词里；
- **节点菜单**：声明了必填字段却还没配的技能会显示「需要配置：…」和「去配置」，点开直接定位到该技能的表单；
- **已知技能配方**：`image-to-editable-ppt` 插件内置了一份配方（图片 API 密钥 / 地址 / 模型 + 可选 PaddleOCR token，走 `editppt config`），所以上游还没带声明时也能开箱配置；技能自带声明永远优先。

格式、边界与安全规则见 [`docs/skill-config.md`](docs/skill-config.md)。没声明配置的技能行为不变：面板只给通用提示，仍按它自己的文档 / 让 Agent 配置。

#### 相关设置

「设置 → 插件 → AI 生图」新增**无限画布技能**分组：

- **画布技能**：总开关，关闭后节点上不再出现技能菜单。
- **允许重任务技能**：关闭后只保留轻量技能（不会启动无头 Agent）。
- **技能白名单**：逗号或换行分隔的技能名；留空表示允许本机全部技能。
- **重任务工作目录**：无头 Agent 的工作目录，留空使用数据目录下的 `canvas/runs`。
- **重任务超时（分钟）**：超时自动取消（填 0 不超时）。
- **重任务 Agent 预设**：指定重任务使用的 Agent 预设名。
- **检测技能环境**：一键查看可用技能数量与无头 Agent 是否可用。

<a id="configuration"></a>
## 配置模型

打开 DSH 的“设置 → 插件”，展开 **VisioWork（dsh-imagegen）**。每个渠道都有独立的 API 地址、密钥、模型目录和「安装目录」（仅 ComfyUI），可同时配置多个服务；预置了 OpenAI、智谱、xAI、字节火山方舟（Seedream）、阿里云百炼（Qwen-Image）、MiniMax（image-01）、ComfyUI（本地服务）等常用渠道，也可添加任意自定义 OpenAI 兼容渠道。

<div align="center">
  <img src="docs/images/plugin-settings.png" alt="DSH 设置页中的 VisioWork 插件配置" width="72%" />
  <p><sub>设置 → 插件 → VisioWork（dsh-imagegen）</sub></p>
</div>

| 配置项 | 说明 |
| --- | --- |
| 渠道 | 预置渠道可直接选用，也可添加任意自定义渠道。 |
| API 地址 | 渠道根地址：OpenAI 兼容渠道填 `/v1` 根地址（如 `https://api.openai.com/v1`），插件会自动拼接图像接口；ComfyUI 填本地服务地址（如 `http://127.0.0.1:8188`）。 |
| API 密钥 | ComfyUI 本地服务通常无需密钥；其他渠道每个单独保存，密钥仅存在 DSH 宿主侧，浏览器拿不到明文。 |
| 模型目录 | 保存地址和密钥后点击“检测可用模型”，插件会过滤聊天、Embedding 等非图片模型；没有 `/models` 的网关可手动添加并设置别名。 |
| 安装目录（仅 ComfyUI） | 本地 ComfyUI 仓库路径，插件会从这里读取 Save (API Format) 工作流 JSON；工作流可放进「任意子目录」并被扫描识别。 |
| 提示词增强 API | 可选。画布技能中的轻量动作（如文本润色、图片描述）调用这里配置的聊天模型；留空则轻量技能被禁用。 |
| 技能 / 重任务开关 | 技能总开关、重任务开关、技能白名单、重任务超时、重任务 Agent 预设、工作目录等；详见 [无限画布 → 画布技能](#canvas) 章节的相关设置小节。 |

**关于“检测可用模型”**

- 优先读取上游返回的能力字段，并结合命名启发式（image / flux / seedream / nanobanana / kolors…）过滤非图片模型，但仍建议只勾选你的上游实际支持生图的模型。
- 支持用尚未保存的地址和密钥先探测、确认可用后再保存。
- 未被识别的 OpenAI 兼容图片模型仍可手动加入清单，按通用协议尝试调用。

<details>
<summary><b>已适配的接口与模型家族</b></summary>

- **OpenAI 兼容接口**：支持 `/images/generations`、`/images/edits` 和 `{ data: [{ b64_json | url }] }` 格式响应。
- **异步两步式接口（apimart.ai / apib.ai 等）**：OpenAI 兼容渠道的 `/images/generations` 若返回 `{ data: [{ status, task_id }] }` 提交结果，插件会自动轮询 `GET /v1/tasks/{task_id}`（指数退避，最长 240 秒）直到完成，自动展开 `url` 数组并下载成图；兼容 submitted / pending / processing 与 completed / succeeded 等常见状态词，上游失败原因原样透传，取消任务会同步中断轮询。无需专用预设，任意 OpenAI 兼容渠道自动生效。
- **Grok Imagine**：原生支持 `grok-imagine-image` 与 `grok-imagine-image-2.0`（地址 `https://api.x.ai/v1`），图生图使用其 JSON `image_url` 协议，比例和清晰度映射为 `aspect_ratio` 与 `resolution`。
- **Nano Banana（谷歌 Gemini 图像系列）**：内置 `nanobanana2` / `nanobanana2-lite` / `nanobanana-pro`（也识别官方 `gemini-3.x-image*` ID），清晰度映射为 `image_size`（1K/2K/4K）。
- **Seedream（字节跳动生图系列）**：内置 `seedream-5.0-pro`（也识别 `seedream-4.x`、`doubao-seedream-…`），文生图与图生图统一走 `/images/generations`，参考图以 JSON `image` 数组发送。
- **Qwen-Image（通义千问）**：内置阿里云百炼渠道，使用 `https://dashscope.aliyuncs.com/api/v1` 的 DashScope 原生 `multimodal-generation` 接口（不是 OpenAI 兼容接口），支持 Qwen-Image 2.0 / 3.0 系列文生图与图像编辑，比例自动映射为 `宽*高` 尺寸。该渠道不能复用于提示词增强。
- **智谱 GLM-Image**：内置 `glm-image`，文生图质量参数映射为 `hd`；当前不支持图生图，选择编辑模型时会被自动排除。
- **MiniMax image-01**：内置 MiniMax 官方渠道，使用 `https://api.minimax.io/v1`（国内站 `https://api.minimaxi.com/v1`）的原生 `/image_generation` 接口（不是 OpenAI 兼容接口）。支持 `1:1 / 16:9 / 4:3 / 3:2 / 2:3 / 3:4 / 9:16 / 21:9` 宽高比，一次最多 9 张，图生图以单张参考图作为 `subject_reference`（人物/主体参考）发送——它是主体一致性参考而非像素级编辑，适合“同一人物换场景”，不适合局部修图。MiniMax 的 `/models` 只列出聊天模型，请直接使用预填的模型目录。
- **后续模型**：未被识别的 OpenAI 兼容图片模型可手动添加；厂商专属鉴权或请求协议需要单独适配。

</details>

<a id="security"></a>
## 数据与安全

- API 请求由 DSH 宿主进程代理，浏览器不直接连接上游：没有 CORS 问题，密钥不会出现在前端；宿主路由仅监听本机回环地址并校验同源请求。
- 密钥保存于本机 DSH 设置中，设置页面仅展示“已配置”状态。
- 画布项目与图片数据保存在宿主的 `~/.dsh/dsh-imagegen/canvas`，由你控制；文件访问有严格限制（见下）。
- 画布文件节点上传的文件（≤50MB）以内容寻址保存在同一数据目录，脚本与可执行扩展名被拒绝；预览只在宿主侧解码（文本 / 表格 / 文档正文 / 压缩包目录），只有图片、PDF、音频、视频会在显式 `inline` 请求下以内联响应返回，且响应带 `X-Content-Type-Options: nosniff`，其余资源一律以下载方式返回。
- 画布技能中的「轻量动作」（文本润色 / 图片描述 / 内容抽取）会把你选中的节点内容发送到「提示词增强 API」所配置的聊天模型；「重任务」技能会启动一个拥有本机文件读写与命令执行能力的无头 Agent，并把你选择的技能正文注入它的上下文。请在运行前确认节点内容不敏感、且已了解该技能会做什么。
- `image-to-editable-ppt` 之类的第三方技能由其自身文档决定外部依赖（OCR Token、图片后端等），这些凭据由该技能管理，本插件不读取也不上传它们。
- 图生图会把参考图发送到当前渠道的上游 API，请确认渠道服务商的数据处理政策，不要上传敏感图片。
- 生图会消耗上游 API 额度。图片内容由上游模型生成，可能出现不准确、不适宜或不符合预期的结果，请在使用前人工检查。
- API 密钥属于敏感信息，请不要提交到 GitHub Issue、日志、截图或 README；发现密钥泄露时应立即在上游服务商处轮换。

<a id="community"></a>
## 社区与支持

欢迎加入 QQ 群，一起交流 DSH、AI 生图和插件使用体验，也欢迎分享提示词、工作流与改进建议。

<p align="center">
  <img src="docs/images/community-qq.png" alt="扫码加入 dsh-imagegen QQ 交流群" width="360" />
</p>

- 发现问题请提交 [Bug 报告](https://github.com/dickpy/dsh-imagegen/issues/new?template=bug_report.yml)，附带插件版本、DSH 版本和复现步骤。请勿粘贴 API 密钥。
- 有改进想法请提交 [功能建议](https://github.com/dickpy/dsh-imagegen/issues/new?template=feature_request.yml)。
- 查看全部 [Release](https://github.com/dickpy/dsh-imagegen/releases) 和 [Issue](https://github.com/dickpy/dsh-imagegen/issues)。
- 如果这个插件对你有帮助，欢迎 Star。

<details>
<summary><b>本地开发</b></summary>

```bash
pnpm run typecheck
pnpm run build
pnpm run watch
node scripts/smoke.mjs
```

改完源码后要装进本机 GUI 验收，打一个本地 tgz 再覆盖安装即可（面板不会热更新宿主端，装完重启 `dsh web`）：

```bash
pnpm pack --pack-destination .        # 生成 dickpy-dsh-imagegen-<版本>.tgz
dsh plugin --profile web add ./dickpy-dsh-imagegen-<版本>.tgz
```

</details>

## 许可证

[Apache-2.0](./LICENSE)
