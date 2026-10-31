# Agent WeCom Notify

为 **Codex CLI** 和 **DeepSeek Harness（DSH）** 提供企业微信群机器人提醒：回合完成、计划／问题等待回答、权限等待审批。两套实现各自独立，群消息只提醒，仍需返回原工具回答或审批。

[English](README.md) · [来源与许可](NOTICE.md)

```text
codex/   Python 通知脚本、安装器和离线测试
dsh/     DSH Host-only Bundle、资源和离线测试
docs/    Codex 与 DSH 分别安装的详细指南
```

1. 在企业微信群中添加机器人，把 Webhook **仅存私有文件**，不要提交到仓库，也不要在聊天中粘贴。
2. Codex：`cd codex && python3 install_codex_wecom.py`；重启 Codex，使用 `/hooks` 审核并信任 Hook。详见 [Codex 指南](docs/codex.md)。
3. DSH：把 `dsh/cordis.patch.yml` 的空 `webhookFile` 改为**本机私有文件绝对路径**，使用 DSH `plugin_manager` 的 `install_bundle` 安装完整 `dsh/` 目录，按状态重启。公开模板的 `includeExcerpts` 默认 `false`。详见 [DSH 指南](docs/dsh.md)。

离线测试：`python3 -m unittest discover -s codex/test -v`；`cd dsh && node --test test/*.test.js`。DSH 的 `node check.mjs` 只检查默认私有文件（或通过 `DSH_WECOM_WEBHOOK_FILE` 指定其他文件），**不会联网，也不能证明插件已激活**。

**安全提醒：** Codex 会向群发送完整工作路径、任务及回复；DSH 只在明确打开 `includeExcerpts: true` 后发送任务／回复摘要。命中常见凭据标记时会整段省略，但规则无法保证覆盖所有敏感信息；敏感任务请禁用有关通知或摘要，且不要在不可信群中使用。Webhook 等同密码，不能通过群消息直接回答问题或批准权限。未经你另行指示，本目录不会修改你现有的 Codex／DSH 安装配置，也不会自动提交或推送 GitHub。

**许可与来源：** 项目采用 [CC BY-NC-SA 4.0](LICENSE)，限制商业使用。Codex 脚本改编自 [Juse 的文章及配套代码](https://biojuse.com/2026/09/15/codex-cli-wecom-notification/)；参见 [NOTICE.md](NOTICE.md)。
