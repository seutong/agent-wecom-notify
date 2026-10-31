"""Offline smoke tests; never read or send a real webhook."""
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

BASE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BASE))
import codex_notify_wecom as notify
import install_codex_wecom as installer


class NotifyTests(unittest.TestCase):
    def test_formats_preview_without_network(self):
        preview = subprocess.run([sys.executable, str(BASE / 'codex_notify_wecom.py'), '--preview'], capture_output=True, text=True, check=True)
        self.assertIn('Codex 本轮已结束', preview.stdout)
        self.assertIn('等待权限审批', preview.stdout)
        self.assertNotIn('example-secret-token', preview.stdout)
        self.assertIn('内容已省略', preview.stdout)

    def test_installer_keeps_unrelated_config(self):
        with tempfile.TemporaryDirectory(prefix='wecom-codex-test-') as tmp:
            target = Path(tmp) / '.codex' / 'codex_notify_wecom.py'
            config = installer._notify_config('model = "example"\n\n[features]\nhooks = true\n', target)
            self.assertIn('model = "example"', config)
            self.assertIn('notify = ["python3",', config)
            self.assertIn('[features]\nhooks = true', config)
            hooks = installer._hooks_config('{"hooks":{"PreToolUse":[{"matcher":"^other$","hooks":[{"type":"command","command":"echo unrelated"}]}]}}', target)
            self.assertIn('echo unrelated', hooks)
            self.assertIn('PermissionRequest', hooks)

    def test_private_source_and_synthetic_events(self):
        self.assertTrue(installer._valid_webhook('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=12345678-1234-1234-1234-123456789abc'))
        self.assertFalse(installer._valid_webhook('https://evil.example/send?key=12345678-1234-1234-1234-123456789abc'))
        text = notify._format_content(notify._sample_permission())
        self.assertNotIn('example-secret-token', text)
        self.assertIn('内容已省略', text)

    def test_sensitive_content_is_omitted_in_every_forwarded_event(self):
        completion = notify._sample_completion()
        completion['cwd'] = '/home/example/token=PRIVATE_PATH/project'
        completion['input-messages'] = ['OPENAI_API_KEY=FAKE_PROMPT_VALUE']
        completion['last-assistant-message'] = '{"password":"FAKE_REPLY_VALUE"}'
        text = notify._format_content(completion)
        for secret in ('PRIVATE_PATH', 'FAKE_PROMPT_VALUE', 'FAKE_REPLY_VALUE'):
            self.assertNotIn(secret, text)
        self.assertIn('内容已省略', text)

        question = notify._sample_user_input()
        question['tool_input']['questions'][0].update({
            'header': '密码 FAKE_HEADER_VALUE',
            'question': 'token: FAKE_QUESTION_VALUE',
            'options': [{'label': 'API_KEY=FAKE_LABEL_VALUE', 'description': 'secret=FAKE_OPTION_VALUE'}],
        })
        text = notify._format_content(question)
        for secret in ('FAKE_HEADER_VALUE', 'FAKE_QUESTION_VALUE', 'FAKE_LABEL_VALUE', 'FAKE_OPTION_VALUE'):
            self.assertNotIn(secret, text)
        self.assertIn('内容已省略', text)
        self.assertNotIn('example-secret-token', notify._format_content(notify._sample_permission()))

    def test_chinese_adjacent_credentials_never_leave_machine(self):
        completion = notify._sample_completion()
        completion['cwd'] = '/home/example/我的password=FAKE_PATH_VALUE/project'
        completion['input-messages'] = ['请用API_KEY=FAKE_PROMPT_VALUE']
        completion['last-assistant-message'] = '我的password=FAKE_REPLY_VALUE'
        question = notify._sample_user_input()
        question['tool_input']['questions'][0]['question'] = '请用token=FAKE_QUESTION_VALUE'
        approval = notify._sample_permission()
        approval['tool_input']['description'] = '我的secret=FAKE_REASON_VALUE'
        approval['tool_input']['command'] = '请用Bearer FAKE_COMMAND_VALUE'
        for event, words in (
            (completion, ('FAKE_PATH_VALUE', 'FAKE_PROMPT_VALUE', 'FAKE_REPLY_VALUE')),
            (question, ('FAKE_QUESTION_VALUE',)),
            (approval, ('FAKE_REASON_VALUE', 'FAKE_COMMAND_VALUE')),
        ):
            message = notify._format_content(event)
            self.assertIn('内容已省略', message)
            for word in words:
                self.assertNotIn(word, message)


if __name__ == '__main__':
    unittest.main()
