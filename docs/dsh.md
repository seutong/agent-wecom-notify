# DSH Host-only Bundle 安装与验证

`dsh/` 是独立于 Codex 的 Host-only Bundle，不要用 Codex 安装器安装它。本目录是**公开模板**：`cordis.patch.yml` 的 `webhookFile` 初始为空、`includeExcerpts` 初始为 `false`。需要先配置本机私有路径；不要把完整 Webhook 地址直接写进 YAML。

## 配置

1. 在企业微信群添加机器人，安全地把完整 Webhook 地址放在 Vault / Git 仓库之外的私有文件（例如 `${HOME}/.dsh/secrets/wecom_webhook`）。创建目录时确保权限 0700，文件需为当前用户所有、普通文件、权限 0600、非符号链接。地址必须是 `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=...`。
2. 将 `dsh/cordis.patch.yml` 中 `webhookFile: ''` 改为本机**绝对路径**。此路径是配置，本身不是密钥；但公开发布前仍请检查是否暴露个人用户名。共享同一个机器人时也可以使用另一工具已有的私有文件，前提是所有者和权限符合检查要求。
3. 默认 `completion`、`approval`、`question` 为 `true`；分别设为 `false` 可关闭。`includeExcerpts: false` 只发送状态提醒，不发任务和回复；仅在接受发送内容到群时手动设为 `true`，摘要最多任务 200 字、回复 500 字。常见敏感内容会省略，但过滤器无法保证识别全部秘密。

## 安装

在 DSH 提供 `plugin_manager` 操作的会话里对**完整 `dsh/` 目录**执行 `install_bundle`，目标 desktop Profile。确认 `applied` / `restart-required`，需要时重启；Host JavaScript 更新同样需要重新应用 Bundle 并重启。不要直接改 `~/.dsh/profiles/desktop`、不要使用 shell `pnpm add` 或 `dsh plugin add` 绕过应用管理。不同 DSH 版本可能没有 GUI 安装按钮，以实际提供的插件管理操作为准。拷贝本仓库**不会**自动迁移你原来已安装的插件；切换安装源前先填写自己的 `webhookFile`，否则新模板默认不发送。

## 离线验证

```sh
cd dsh
node --test test/*.test.js
node check.mjs                 # 默认检查 ~/.dsh/secrets/wecom_webhook
# 如果采用其他私有路径：
DSH_WECOM_WEBHOOK_FILE=/absolute/private/path/wecom_webhook node check.mjs
```

`check.mjs` 不联网、不打印 URL，不能证明 Bundle 已在运行。重启后完成一次不含敏感内容的正常任务，核对群中“DSH 本轮任务已完成”的状态提醒；只有主动开启摘要后才出现“✅ DSH 本轮已结束”及内容摘要。旧版本的提问提醒曾实测送达；审批只通过离线模拟，不要制造危险审批。提醒失败不应代替或更改 DSH 的答复/审批。
