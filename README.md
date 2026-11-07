# XYCAD · 自托管 CAD 在线预览

XYCAD 是由 **zhao960728-crypto（阿阳有想法）** 发布的实验性 CAD 在线预览项目，提供二维图纸、三维模型、测量、装配树和三视图导出。默认由自有 Node.js 服务解析，浏览器绘制；核心预览不依赖第三方 CAD 云接口，项目没有 npm 依赖。

**原始项目：[github.com/zhao960728-crypto/XYCAD](https://github.com/zhao960728-crypto/XYCAD)**

> **先读缺陷：目前仅覆盖部分格式版本与几何布局。能打开不等于几何完整或尺寸正确；复杂模型可能缺件、缺面、失败或耗时较长。测量和三视图由预览几何计算，不能直接作为制造验收依据。** 详见[功能缺陷与限制](docs/known-limitations.md)和[验证记录](docs/project-regression.md)。

## 开源、商用与二次开发

采用 [Apache License 2.0](LICENSE)。允许免费使用、学习、复制、修改、商用、集成、再分发和二次开发，也允许按该许可条件发布闭源衍生产品。

再分发时须附带许可证，保留适用的版权和出处声明及 [NOTICE](NOTICE)，在修改文件中明确注明修改。建议在衍生项目的 README、关于页面或第三方声明中写明：

```text
本项目基于 XYCAD 二次开发。
原始发布者：zhao960728-crypto（阿阳有想法）
原始项目：https://github.com/zhao960728-crypto/XYCAD
原项目许可：Apache-2.0
修改内容：<填写自己的修改内容>
```

以上是署名示例和许可摘要；具体权利与义务以 LICENSE 为准。无需为每次二开另行申请许可。软件按现状提供，不承诺任意 CAD 文件兼容、制造精度、适销性或特定用途适用性。品牌和第三方组件仍遵循各自授权，详见[发布声明](docs/release.md)。

## 快速启动

安装 Node.js **22.2.0 或更高版本**，以及运行自动测试所需的 Python **3.9+**（部分测试会调用 Python；仅启动核心服务无需 Python）。

```bash
git clone https://github.com/zhao960728-crypto/XYCAD.git
cd XYCAD
npm start
```

打开 [http://127.0.0.1:4173/](http://127.0.0.1:4173/)，点击“查看样图”或上传自己的文件。没有 npm 依赖，无需先执行 `npm install`。GitHub 仓库托管源码；**GitHub Pages 无法单独运行本项目的 Node.js 解析服务**。

二维拖动平移；三维拖动旋转、Shift + 拖动平移；滚轮缩放，双击适配窗口。三维预览要求浏览器支持 WebGL 2。

## 当前功能与格式范围

| 格式或功能 | 当前提供 | 主要限制 |
| --- | --- | --- |
| DXF | 文本/二进制二维矢量、图层、常用文字和块 | 模型空间为主；字体替代、复杂排版与图元可能简化 |
| DWG / DWT | AC1015、AC1018、AC1021、AC1024、AC1027、AC1032 常用二维内容转 DXF | 非完整 DWG 实现；布局、代理对象、OLE、外部参照和三维实体不完整；部分失败文件仅显示内嵌图 |
| EXB | 已适配的 CAXA 模型矢量或文件内嵌图 | 版本与对象覆盖有限；没有 DXF 下载 |
| DWFx | 二维固定页面常见路径、填充、裁剪和变换 | 最多 64 页；嵌入字体、图片、复杂画笔及经典 DWF 未完整支持 |
| SLDDRW | 保存的图框、文字、标注线、部分视图缓存；可读时导出 DXF/PDF | 依赖原件保存缓存；缺视图时拒绝整套 DXF；标注拆成文字与线条，失去关联 |
| STEP / STP | 部分解析曲面、B 样条面、边界和装配变换 | 复杂修剪、自由曲面与容差可能导致缺面、缺件或失败 |
| X_T / X_B | 已验证的 Parasolid 文本及部分中性/IEEE 二进制布局 | 并非全部版本、曲面或编码；能显示的装配仍可能有未读出节点 |
| STL / 3MF | 常见三角网格、3MF Core 组件和变换 | STL 无声明单位；3MF 外部部件及未实现的必要扩展会报错 |
| OBJ / PLY / OFF | 常见文本和所支持二进制网格 | 不提供完整材质/贴图链路；部分格式单位未知；OFF 统一显示网格颜色 |
| SLDPRT | 可选离线入口，读取所选配置保存的多实体几何 | 另配 Python 和外部解析器；格式覆盖有限，不提供原生特征编辑与历史重建 |
| 装配浏览 | 树、显隐、分色、爆炸视图、重复零件共享网格、按需加载 | 按可读结构生成；部分大装配不完整；首帧仍需服务端解析和建网格 |
| 测量 | 二维距离、角度、面积、圆弧；三维点距、角度、网格面积、拟合孔径和平面间距 | 取决于显示几何与选点；单位未知、页面比例、网格精度均会影响结果 |
| 三视图 | 第一角法；六轴主视方向；可见/遮挡线；整套或单节点 DXF、A4 PDF | 网格近似；20 万面及遮挡预算；不完整装配可禁用整套出图；不输出参数化工程图 |

**IGES/IGS、SLDASM、经典 DWF 及任意格式的完整原生编辑不在当前支持范围内。**

SLDDRW、DWFx 测量可手动填写所在视图比例；同页不同视图不能默认共用一个比例。未声明单位的模型保留原坐标单位。三维测量以装配原位为准；爆炸位置不作为真实装配尺寸。

## 配置与部署

默认只监听 `127.0.0.1:4173`。例如 PowerShell：

```powershell
$env:XYCAD_HOST = '127.0.0.1'
$env:XYCAD_PORT = '4173'
npm start
```

| 环境变量 | 用途 |
| --- | --- |
| `XYCAD_HOST` / `XYCAD_PORT` | 监听地址 / 端口 |
| `XYCAD_DWG_CONVERTER` | 可信的本机 ES 模块绝对路径，替换内置 DWG 转换 |
| `XYCAD_SLDPRT_PARSER_DIR` | 单独安装的可信 `sldprt2step` 源码目录绝对路径 |
| `XYCAD_SLDPRT_PYTHON` | Python 解释器；默认 Windows `python`、其他系统 `python3` |
| `XYCAD_SOLIDWORKS=1` | Windows 回环地址下启用已安装且获授权的本机 SOLIDWORKS COM 接口 |
| `XYCAD_BDYC_ORIGIN` | 可选本机 BDYC HTTP 源地址，使用其现有登录权限下载原图 |
| `XYCAD_OPENAI_API_KEY` / `XYCAD_OPENAI_MODEL` | 可选本机预览诊断，默认关闭；使用部署者自己的密钥和模型 |

公开部署需要自行配置 HTTPS、认证、请求速率及进程/内存/磁盘隔离。独立服务没有完整的多租户账号系统，不宜直接作为匿名无限上传服务。项目没有统一上传字节上限，但存在格式解压、实体/三角面数、解析时限和输出预算；**不代表无限文件大小或无限资源**。

原文件在自托管服务器临时接收；普通请求结束后清理。装配预览的派生网格会暂存，闲置约 30 分钟过期，也可能因容量提前回收。部署方应自行管理访问权限、临时目录和保留策略。

本轮功能验证主要在 Windows 本机进行；Linux/macOS、不同浏览器和公网并发未完成同等验证。可选 SOLIDWORKS 接口仅支持 Windows。更多宿主接入约定见 [BDYC 接入说明](docs/bdyc-integration.md)。

### 可选 SLDPRT 离线入口

单独获取 [BlinkingSun/sldprt2step](https://github.com/BlinkingSun/sldprt2step)，已验证提交为 `fa954124f4f126e0c465c8f96454978ac80b812e`。例如先在独立目录中执行：

```bash
git clone https://github.com/BlinkingSun/sldprt2step.git
cd sldprt2step
git checkout fa954124f4f126e0c465c8f96454978ac80b812e
```

再为 XYCAD 设置 `XYCAD_SLDPRT_PARSER_DIR` 并重启服务。该组件采用其自己的 Apache-2.0 和 NOTICE，本仓库未捆绑其源码；分发时保留其原声明。

该入口无需安装 SOLIDWORKS，支持已适配的现代容器，每配置最多 256 个实心实体，SLDPRT 输入上限 64 MiB。选择配置读取保存的几何；缺少保存分区、实体不完整或外形范围明显冲突时拒绝成功预览。外形检查属于粗查，无法发现全部内部差异。旧式 OLE、片体、非恒等变换、复杂曲面和历史增量重放未完整覆盖。

### 可选接口的边界

- 本机 SOLIDWORKS 需要独立安装、授权和可用会话。仅对临时副本运行，覆盖仍取决于原件保存状态与软件版本。
- BDYC 是独立系统，本仓库只含适配端代码，不包含它的生产系统、账号或数据。独立 XYCAD 不依赖 BDYC。
- OpenAI 诊断仅在本机配置后、用户主动点击时请求；发送格式和预览状态，设置 `store: false`，不发送 CAD 原件。需要外网和付费账户；既有真实联调曾遇到 TLS 失败，不承诺可用。诊断建议不会修复几何。
- 外部 DWG 模块须导出 `convertDwg(bytes, { version })`，返回文本 DXF 的 `Uint8Array`，可异步。`POST /api/convert` 接收 `application/octet-stream` 原始 DWG/DWT 字节；不是通用双向 DWG 编辑接口。

## 校验与贡献

```bash
npm test
```

2026-11-07 公开版校验：**88 项通过，0 失败，0 跳过**。这些测试覆盖合成样本、格式/几何逻辑和本地 HTTP 接口，不构成全部版本兼容、任意输入正确或制造验收保证。真实业务原图、截图、导出物及原始测试证据不随仓库公开；[验证记录](docs/project-regression.md)明确区分公开可复跑测试和既有本机记录。

欢迎 fork、提 Issue 和提交 PR。报告问题时请给出版本、格式、预期/实际表现、提示与最小可公开样本；请先确认有权公开图纸。提交的贡献默认采用 Apache-2.0，请保留来源与第三方许可，避免引入业务数据、密钥或未经授权素材。

目录：`src/` 解析与几何，`public/` 网页与原创演示 DXF，`server.mjs` HTTP 服务，`scripts/` 可选工具和宿主打包，`test/` 自动测试，`docs/` 公开说明。
