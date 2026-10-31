#!/usr/bin/env python3
"""Install and verify Codex CLI notifications for a WeCom group bot.

The installer only uses the Python standard library. It preserves unrelated
Codex settings, creates timestamped backups before changing existing files,
and never stores the webhook in this repository.
"""

from __future__ import annotations

import argparse
import getpass
import json
import os
import re
import shlex
import shutil
import stat
import subprocess
import sys
import tempfile
from datetime import datetime
from pathlib import Path
from typing import Any, NoReturn

try:
    import tomllib
except ModuleNotFoundError:  # pragma: no cover - Python < 3.11
    tomllib = None


SCRIPT_NAME = "codex_notify_wecom.py"
WEBHOOK_PREFIX = "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key="
QUESTION_MATCHER = r"^request_user_input(_async)?$"


def _fail(message: str) -> NoReturn:
    raise SystemExit(f"错误：{message}")


def _backup(path: Path) -> Path:
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S-%f")
    target = path.with_name(f"{path.name}.bak-{stamp}")
    shutil.copy2(path, target)
    return target


def _atomic_write(path: Path, content: str, mode: int, *, backup: bool = True) -> bool:
    old = path.read_text(encoding="utf-8") if path.exists() else None
    if old == content:
        os.chmod(path, mode)
        return False
    path.parent.mkdir(parents=True, exist_ok=True)
    if old is not None and backup:
        saved = _backup(path)
        os.chmod(saved, mode)
        print(f"已备份：{saved}")
    with tempfile.NamedTemporaryFile(
        "w", encoding="utf-8", dir=path.parent, delete=False
    ) as stream:
        stream.write(content)
        temporary = Path(stream.name)
    os.chmod(temporary, mode)
    os.replace(temporary, path)
    return True


def _valid_webhook(value: str) -> bool:
    if not value.startswith(WEBHOOK_PREFIX):
        return False
    key = value.removeprefix(WEBHOOK_PREFIX)
    return bool(re.fullmatch(r"[A-Za-z0-9-]{20,}", key))


def _read_webhook(args: argparse.Namespace, target: Path) -> str:
    try:
        if args.webhook_file:
            value = args.webhook_file.expanduser().read_text(encoding="utf-8").strip()
        elif target.exists():
            value = target.read_text(encoding="utf-8").strip()
        else:
            value = ""
    except OSError as exc:
        _fail(f"无法读取 Webhook 文件：{exc}")

    if not args.webhook_file and target.exists():
        if _valid_webhook(value):
            print(f"沿用已有 Webhook：{target}")
            return value
        print(f"已有 Webhook 文件格式无效，将重新录入：{target}")
        value = getpass.getpass("粘贴企业微信群机器人 Webhook（输入不回显）：").strip()
    elif not args.webhook_file and sys.stdin.isatty():
        value = getpass.getpass("粘贴企业微信群机器人 Webhook（输入不回显）：").strip()
    elif not args.webhook_file:
        _fail("非交互环境必须使用 --webhook-file 提供 Webhook")
    if not _valid_webhook(value):
        _fail("Webhook 必须以企业微信群机器人地址开头，并包含有效 key")
    return value


def _top_level_table_index(lines: list[str]) -> int:
    for index, line in enumerate(lines):
        if line.lstrip().startswith("["):
            return index
    return len(lines)


def _array_value_end(lines: list[str], start: int) -> int:
    """Find the last line of a top-level TOML array value."""
    depth = 0
    in_basic = False
    in_literal = False
    escaped = False
    found_array = False
    for index in range(start, len(lines)):
        for char in lines[index]:
            if escaped:
                escaped = False
                continue
            if char == "\\" and in_basic:
                escaped = True
                continue
            if char == '"' and not in_literal:
                in_basic = not in_basic
                continue
            if char == "'" and not in_basic:
                in_literal = not in_literal
                continue
            if in_basic or in_literal:
                continue
            if char == "#":
                break
            if char == "[":
                depth += 1
                found_array = True
            elif char == "]" and found_array:
                depth -= 1
        if not in_basic and not in_literal and (not found_array or depth <= 0):
            return index
    _fail("config.toml 中现有 notify 数组没有闭合")


def _notify_config(content: str, notify_script: Path) -> str:
    command = f'notify = ["python3", {json.dumps(str(notify_script))}]\n'
    lines = content.splitlines(keepends=True)
    table_index = _top_level_table_index(lines)
    notify_index = None
    for index, line in enumerate(lines[:table_index]):
        if re.match(r"^\s*notify\s*=", line):
            notify_index = index
            break

    if notify_index is not None:
        end = _array_value_end(lines, notify_index)
        lines[notify_index : end + 1] = [command]
    else:
        insertion = table_index
        prefix = command
        if lines and insertion == 0:
            prefix += "\n"
        elif insertion > 0 and lines[insertion - 1].strip():
            prefix = "\n" + prefix
        lines.insert(insertion, prefix)

    updated = "".join(lines)
    if tomllib is not None:
        tomllib.loads(updated)
    return updated


def _is_our_hook(handler: Any) -> bool:
    if not isinstance(handler, dict):
        return False
    command = handler.get("command")
    return (
        isinstance(command, str)
        and SCRIPT_NAME in command
        and re.search(r"(?:^|\s)--hook(?:\s|$)", command) is not None
    )


def _remove_old_handlers(groups: Any) -> list[dict[str, Any]]:
    if groups is None:
        return []
    if not isinstance(groups, list):
        _fail("hooks.json 中事件配置必须是数组")
    cleaned: list[dict[str, Any]] = []
    for group in groups:
        if not isinstance(group, dict):
            _fail("hooks.json 中的 matcher 组必须是对象")
        handlers = group.get("hooks")
        if not isinstance(handlers, list):
            _fail("hooks.json 中 matcher 组的 hooks 必须是数组")
        retained = [handler for handler in handlers if not _is_our_hook(handler)]
        if retained:
            copy = dict(group)
            copy["hooks"] = retained
            cleaned.append(copy)
    return cleaned


def _hooks_config(content: str, notify_script: Path) -> str:
    try:
        data = json.loads(content) if content.strip() else {}
    except json.JSONDecodeError as exc:
        _fail(f"现有 hooks.json 不是有效 JSON：{exc}")
    if not isinstance(data, dict):
        _fail("hooks.json 顶层必须是对象")
    hooks = data.setdefault("hooks", {})
    if not isinstance(hooks, dict):
        _fail("hooks.json 的 hooks 字段必须是对象")

    command = f"python3 {shlex.quote(str(notify_script))} --hook"
    handler = {
        "type": "command",
        "command": command,
        "async": True,
        "timeout": 15,
    }
    pre_tool = _remove_old_handlers(hooks.get("PreToolUse"))
    pre_tool.append(
        {
            "matcher": QUESTION_MATCHER,
            "hooks": [
                {
                    **handler,
                    "statusMessage": "Sending WeCom decision notification",
                }
            ],
        }
    )
    permission = _remove_old_handlers(hooks.get("PermissionRequest"))
    permission.append(
        {
            "hooks": [
                {
                    **handler,
                    "statusMessage": "Sending WeCom approval notification",
                }
            ],
        }
    )
    hooks["PreToolUse"] = pre_tool
    hooks["PermissionRequest"] = permission
    data.setdefault(
        "description", "Forward Codex user-input and permission requests to WeCom."
    )
    return json.dumps(data, ensure_ascii=False, indent=2) + "\n"


def _mode(path: Path) -> int:
    return stat.S_IMODE(path.stat().st_mode)


def _check(codex_home: Path, *, send_test: bool) -> None:
    notify_script = codex_home / SCRIPT_NAME
    webhook_file = codex_home / "wecom_webhook"
    config_file = codex_home / "config.toml"
    hooks_file = codex_home / "hooks.json"
    required = (notify_script, webhook_file, config_file, hooks_file)
    missing = [str(path) for path in required if not path.is_file()]
    if missing:
        _fail("缺少安装文件：" + "、".join(missing))

    source = notify_script.read_text(encoding="utf-8")
    compile(source, str(notify_script), "exec")
    if not _valid_webhook(webhook_file.read_text(encoding="utf-8").strip()):
        _fail(f"Webhook 文件无效：{webhook_file}")
    if _mode(webhook_file) != 0o600:
        _fail(f"Webhook 文件权限过宽，应为 600：{webhook_file}")
    if _mode(notify_script) != 0o700:
        _fail(f"通知脚本权限过宽，应为 700：{notify_script}")

    config_text = config_file.read_text(encoding="utf-8")
    expected_line = f'notify = ["python3", {json.dumps(str(notify_script))}]'
    if expected_line not in config_text.splitlines():
        _fail("config.toml 中 notify 配置与已安装脚本不一致")
    if tomllib is not None:
        config = tomllib.loads(config_text)
        expected = ["python3", str(notify_script)]
        if config.get("notify") != expected:
            _fail("config.toml 中 notify 配置与已安装脚本不一致")
        if isinstance(config.get("features"), dict) and config["features"].get("hooks") is False:
            _fail("config.toml 显式关闭了 features.hooks，请删除该设置或改为 true")

    hooks = json.loads(hooks_file.read_text(encoding="utf-8"))
    events = hooks.get("hooks", {})
    for event in ("PreToolUse", "PermissionRequest"):
        groups = events.get(event, [])
        if not any(
            _is_our_hook(handler)
            for group in groups
            if isinstance(group, dict)
            for handler in group.get("hooks", [])
        ):
            _fail(f"hooks.json 缺少 {event} 企业微信通知")

    preview = subprocess.run(
        [sys.executable, str(notify_script), "--preview"],
        check=False,
        capture_output=True,
        text=True,
        env={**os.environ, "CODEX_HOME": str(codex_home)},
    )
    if preview.returncode or not all(
        marker in preview.stdout for marker in ("本轮已结束", "等待你的决策", "等待权限审批")
    ):
        _fail("通知脚本预览检查失败")
    if send_test:
        result = subprocess.run(
            [sys.executable, str(notify_script), "--test"],
            check=False,
            env={**os.environ, "CODEX_HOME": str(codex_home)},
        )
        if result.returncode:
            _fail("企业微信真实测试消息发送失败")
        print("真实测试消息已发送，请检查企业微信群。")
    print("检查通过：脚本、Webhook、config.toml、hooks.json 和消息预览均有效。")


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="安装 Codex CLI 企业微信通知")
    parser.add_argument(
        "--webhook-file",
        type=Path,
        help="从本地文件读取 Webhook；适合无交互配置，避免密钥出现在命令历史中",
    )
    parser.add_argument(
        "--check", action="store_true", help="只检查当前安装，不修改任何文件"
    )
    parser.add_argument(
        "--send-test", action="store_true", help="检查通过后向企业微信群发送一条真实测试消息"
    )
    return parser.parse_args()


def main() -> int:
    if os.name == "nt":
        _fail("当前安装器面向 macOS/Linux；Windows 请按笔记中的手动配置执行")
    args = _parse_args()
    source_script = Path(__file__).with_name(SCRIPT_NAME).resolve()
    if not source_script.is_file():
        _fail(f"安装器旁缺少通知脚本：{source_script}")
    compile(source_script.read_text(encoding="utf-8"), str(source_script), "exec")

    codex_home = Path(os.environ.get("CODEX_HOME", "~/.codex")).expanduser().resolve()
    notify_script = codex_home / SCRIPT_NAME
    webhook_file = codex_home / "wecom_webhook"
    config_file = codex_home / "config.toml"
    hooks_file = codex_home / "hooks.json"

    if args.check:
        _check(codex_home, send_test=args.send_test)
        return 0

    webhook = _read_webhook(args, webhook_file)
    codex_home.mkdir(parents=True, exist_ok=True)
    _atomic_write(
        notify_script,
        source_script.read_text(encoding="utf-8"),
        0o700,
    )
    _atomic_write(webhook_file, webhook + "\n", 0o600)

    config_content = config_file.read_text(encoding="utf-8") if config_file.exists() else ""
    hooks_content = hooks_file.read_text(encoding="utf-8") if hooks_file.exists() else ""
    _atomic_write(config_file, _notify_config(config_content, notify_script), 0o600)
    _atomic_write(hooks_file, _hooks_config(hooks_content, notify_script), 0o600)

    _check(codex_home, send_test=args.send_test)
    print("下一步：重启 Codex CLI，输入 /hooks，审查并信任新增 Hooks。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
