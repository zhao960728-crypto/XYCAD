# 可选 BDYC 宿主接入

XYCAD 可独立运行。BDYC 是外部业务系统，本公开仓库只包含适配端与运行包工具，不包含 BDYC 的生产源码、账号、业务数据或一键部署包。使用者需要控制自己的宿主服务并实现匹配接口。

## 生成运行包

在 XYCAD 项目目录运行，目标必须位于项目目录外：

```powershell
node scripts/package-bdyc.mjs 'D:/my-host/tools/xycad/runtime'
```

输出源码、页面、可选脚本、LICENSE、NOTICE、公开文档以及 SHA-256 manifest。此命令只写运行包；不会自动重启宿主或部署网站。部署者自行校验 manifest 并管理解析进程。

## 独立本机桥接

设置 `XYCAD_BDYC_ORIGIN` 为受信的本机 BDYC HTTP 源地址；使用同一主机名访问 XYCAD。用户在同一浏览器登录宿主后，“打开 BDYC 图纸”通过既有下载接口读取原图，下载权限须由宿主验证。代码入口为 `src/bdyc-source.mjs`，不是任意远程 URL 代理。

## 同源嵌入模式

可参考 `src/embedded-access.mjs`、`public/host-tools.mjs`、`test/embedded-host.test.mjs`。`XYCAD_HOST_TOKEN` 为宿主管理的 64 位十六进制秘密，不得写到公开网页或仓库。宿主须验证登录、来源权限和跨站请求，并生成与账号/会话/浏览器绑定的作用域；网格与投影缓存也依此隔离。

宿主侧的保存、来源复用、下载签名、账号配额、诊断与任务入口需要匹配的服务实现，仅复制本仓库不会自动具备。运行包更新保留版权、出处与随附许可声明即可。不要把生产密钥或业务样本加入公开包。

既有集成主要在 Windows 验证；独立自动测试含模拟宿主和权限隔离检查，不能视为已部署任何外部 BDYC 或 Linux 环境。解析、测量及三视图仍受[已知限制](known-limitations.md)约束。
