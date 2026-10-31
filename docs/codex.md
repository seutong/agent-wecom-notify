# Codex CLI 安装与验证

适用 macOS/Linux，Python ≥ 3.9；仅使用标准库。Codex 通知脚本与安装器必须放在同一目录 `codex/`。参考 [Juse 原文](https://biojuse.com/2026/09/15/codex-cli-wecom-notification/)；本仓库版本的修改与许可见 [NOTICE](../NOTICE.md)。

## 安装

1. 创建企业类型的企业微信群并添加群机器人。完整 Webhook 是密码，只能输入到本地私有文件，不要提交到 Git。
2. 在仓库根目录运行：

   ```sh
   cd codex
   python3 install_codex_wecom.py
   ```

   交互式 Webhook 输入不会回显。如已有私有文件，可使用 `python3 install_codex_wecom.py --webhook-file /absolute/private/path/wecom_webhook`；此参数是**文件路径**，不是 Webhook URL。若使用 `CODEX_HOME`，安装与运行时保持一致。
3. 安装器将通知脚本、`wecom_webhook` (0600)、用户级 `config.toml` 顶层 `notify` 及 `hooks.json` 的 `PreToolUse`/`PermissionRequest` 规则写到 `${CODEX_HOME:-~/.codex}`，现有文件修改前先备份为 `.bak-*`。脚本权限 0700，Hook 异步发送。请注意现有 notify 条目会被替换，其他 Hook 尽量保留。
4. 重启 Codex CLI，输入 `/hooks` 核查并信任新规则；每次 Hook 内容改变后可能需要重新信任。

## 检查

```sh
python3 install_codex_wecom.py --check               # 离线检查，不发送
python3 install_codex_wecom.py --check --send-test   # 向群发送真实测试消息
```

正常完成一个无敏感信息的任务，然后核对完成消息；Plan 模式和问答可在自然使用中核对。等待真实审批出现时再检查权限提醒，不要为了测试执行危险操作。发出提醒后仍需回到 Codex 操作。Plan 内容可能来自非稳定的 session JSONL，Codex 升级后需重新验证。若未通知，先执行 `--check`，确认 `/hooks` 信任状态和 `[features] hooks` 未禁用；多次通知则检查用户级与项目级 Hook 是否重复。

**隐私边界：** 当前 Codex 消息包含**完整工作目录**、任务、最终回复、提问选项或审批命令摘要。命中常见凭据标记的字段会整段省略，但规则无法保证识别全部敏感内容；不可信群或敏感任务应暂停这些通知。用户级私有配置、Webhook 及备份不属于本仓库内容。
