# Agent WeCom Notify

WeCom (enterprise WeChat) group-bot notifications for **Codex CLI** and **DeepSeek Harness (DSH)**. The two integrations are independent: Codex uses a Python `notify` command plus Hooks, while DSH uses a Host-only Bundle. Neither allows approving requests or answering questions from WeCom—return to the agent to act.

[简体中文](README.zh-CN.md) · [Attribution and license](NOTICE.md)

| Event | Codex CLI | DSH |
| --- | --- | --- |
| Turn completed | `notify` (bounded task and reply) | `turn/end` (metadata-only by default) |
| Plan / user question | `PreToolUse` question hook and plan detection | pending question / plan review |
| Approval required | `PermissionRequest` hook | pending approval event |

## Repository

```text
codex/                 Python notifier, safe installer, offline tests
dsh/                   DSH Host-only Bundle, locales and offline tests
docs/                  Separate setup guides for each integration
LICENSE                CC BY-NC-SA 4.0 legal text
NOTICE.md              Juse attribution and modifications
```

## Quick start

1. Create an **enterprise WeCom group bot**. Treat its complete webhook URL as a password; keep it in a private file, **outside this repository**. Do not put it in Git, chat, environment history or a command argument.
2. **Codex (Python 3.9+, macOS/Linux):** run `cd codex && python3 install_codex_wecom.py`. The installer requests the webhook without echoing it, preserves existing unrelated settings and creates backups. Restart Codex, use `/hooks` to review/trust the added hooks, then run `python3 install_codex_wecom.py --check`. Optional `--check --send-test` **does send a real group message**. [Full guide](docs/codex.md).
3. **DSH (Node.js for offline tests; DSH desktop for runtime):** prepare a private webhook file, set its **absolute path** in `dsh/cordis.patch.yml` (`webhookFile` is intentionally empty in the public template), and install the entire `dsh/` directory using DSH's supported `plugin_manager` `install_bundle` operation for your desktop Profile. Confirm `applied` or restart when `restart-required`. No manual Profile edits, `pnpm add` or `dsh plugin add`. [Full guide](docs/dsh.md).

Offline checks (do not send a message):

```sh
python3 -m unittest discover -s codex/test -v
(cd dsh && node --test test/*.test.js)
(cd dsh && node check.mjs) # requires an existing private ~/.dsh/secrets/wecom_webhook
```

## Privacy and limitations

- Codex forwards task text, final answer, **full working-directory path**, and selected question/approval details to the group. Credential-bearing fields are omitted on a best-effort pattern check; leakage of other sensitive data is still possible. Use only with a trusted group and non-sensitive tasks; disable these hooks/notify for sensitive work.
- DSH defaults to **metadata-only** (`includeExcerpts: false`). Set it to `true` only if you explicitly agree to send bounded task (200 characters) and reply (500 characters) previews. Its conservative filter can still miss sensitive content. Editing the Bundle requires reapplication and, for Host JavaScript, a DSH restart.
- Webhook delivery failure must not decide approval or question outcomes. Neither integration remotely controls your agent. Codex Plan recovery uses a non-stable session JSONL layout and may need updates after Codex upgrades.
- The included offline tests do not prove runtime activation or delivery. Test a harmless real task and confirm receipt yourself; never fabricate a dangerous approval to test alerts.

## License

[CC BY-NC-SA 4.0](LICENSE). The Codex notifier is adapted from [Juse's article](https://biojuse.com/2026/09/15/codex-cli-wecom-notification/); see [NOTICE.md](NOTICE.md) for attribution and modifications. This repository is not affiliated with OpenAI, DeepSeek Harness or WeCom.
