# 发布、许可与出处声明

发布日期：2026-11-07。原始发布者：zhao960728-crypto（阿阳有想法）。原始仓库：<https://github.com/zhao960728-crypto/XYCAD>。

本项目采用 [MIT](../LICENSE) 许可，允许自由使用、复制、修改、商用、集成、再分发与二次开发。复制或再分发本软件或其重要部分时，保留版权、原始出处和随附许可声明即可；无需另行申请许可，无需公开二开源码，也无需逐个标注修改文件。原始出处已写入 LICENSE 的版权声明，[NOTICE](../NOTICE) 提供中英说明，可在衍生作品 README、文档或惯常第三方声明位置保留来源。原项目署名不代表为衍生产品背书。

默认实现使用 Node.js 与浏览器原生能力，没有 npm 依赖，不捆绑 CAD SDK、Node.js 二进制、浏览器或字体。运行时使用系统字体，因此字形外观可能与原 CAD 不同。公开演示 DXF 由项目 DXF 写出逻辑生成。

## 外部组件、资料与商标

| 项目 | 来源和授权边界 |
| --- | --- |
| sldprt2step | 可选依赖，[BlinkingSun/sldprt2step](https://github.com/BlinkingSun/sldprt2step)，验证提交 `fa954124f4f126e0c465c8f96454978ac80b812e`。未随本仓库分发；其 Apache-2.0、LICENSE 和 NOTICE 独立适用。 |
| Node.js、浏览器、Python | 使用者自行安装；若随交付物分发，按实际版本保留它们各自的许可。 |
| SOLIDWORKS | 可选本机 COM 接口；需要独立安装和有效授权。接口代码不授予软件安装或运行许可。 |
| OpenAI | 可选本机诊断；部署者自行提供账户、密钥及费用，遵守相应服务条款。无共享密钥或额度。 |
| 外部 DWG 转换器、BDYC | 仓库仅含可选接口，外部模块/宿主的授权、配置和访问权限由部署者管理。 |
| 格式规范 | 参考公开格式资料并进行本机文件对照；本仓库不分发供应商规范副本、SDK 或 schema 文件。 |

格式参考：[公开 DWG 格式说明](https://www.opendesign.com/files/guestdownloads/OpenDesign_Specification_for_.dwg_files.pdf)、[3MF 规范](https://3mf.io/spec/)、[STEP 几何定义](https://www.steptools.com/stds/smrl/data/resource_docs/geometric_and_topological_representation/sys/4_schema.htm)、[Microsoft 复合文档格式](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-cfb/05060311-bfce-4b12-874d-71fd4ce63aea)。这些资料及供应商产品的权利不因本项目开源而转移。

AutoCAD、SOLIDWORKS、Parasolid、CAXA 等名称用于说明兼容目标，各商标属于相应权利人；本项目不宣称获得相关厂商认证、赞助或背书。开源许可只覆盖有权授予许可的本项目内容，不替代第三方许可。

## 公开内容与保证边界

本次从本机工作区导出独立公开目录，只发布源码、合成测试、原创演示图和公开文档。未迁入早期试验历史，不包含业务 CAD 原图、客户/订单文件、截图、工作缓存、密钥或私有 BDYC 源码。公开验证摘要对样本匿名化，原始本机记录不作为公开可复现实验包。

本项目仍在开发中。软件按现状提供，格式覆盖、几何完整性、尺寸精度、可用性和特定用途适用性均无普遍保证；责任范围以 LICENSE 及适用法律为准。已知问题见[功能缺陷与限制](known-limitations.md)。
