#!/usr/bin/env python3
"""Exercise recovery orchestration with fake commands, never real keys or services."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).with_name('mac-restore-backends.sh')


class RecoveryTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.op, self.arc, self.bin = [self.root / name for name in ['op', 'arc', 'bin']]
        for p in [self.op / 'rendered', self.op / 'observability-rendered', self.op / 'scripts', self.arc, self.bin]:
            p.mkdir(parents=True, exist_ok=True)
        for name in ['driver.toml', 'erpc.yaml', 'okx.toml', 'enso.toml', 'curve.toml', 'woofi.toml']:
            (self.op / 'rendered' / name).touch()
        (self.op / 'observability-rendered/telegram-token').touch()
        (self.arc / 'mac-key.cjs').touch()
        (self.root / 'dummy-key').touch()
        self.write(self.op / 'scripts/op-boot-start.sh', 'echo boot >> "$EVENTS"')
        self.write(self.op / 'render-configs.sh', '''if [ "${1:-}" = --check-rendered ]; then
 echo rpc-proof >> "$EVENTS"; exit "${RPC_EXIT:-0}"
fi
echo render >> "$EVENTS"; exit "${RENDER_EXIT:-0}"''')
        self.write(self.bin / 'node', 'echo key-proof >> "$EVENTS"; exit "${KEY_EXIT:-0}"')
        self.write(self.bin / 'osascript', 'echo terminal >> "$EVENTS"; cat >/dev/null')
        self.write(self.bin / 'sleep', 'exit 0')
        self.write(self.bin / 'docker', '''case "$1" in
info)
 count=$(cat "$INFO_COUNT" 2>/dev/null || echo 0)
 echo "$((count+1))" > "$INFO_COUNT"
 [ "$count" -ge "${READY_AFTER:-0}" ];;
inspect)
 if [ "${2:-}" != --format ]; then exit "${INVENTORY_EXIT:-0}"; fi
 case "$3" in
 *Mounts*) echo "$DUMMY_KEY";;
 *) if [ "${STOPPED:-0}" = 1 ] && [ "$4" = ophis-arc-driver-1 ]; then echo false; else echo true; fi;;
 esac;;
start) echo "start $2" >> "$EVENTS";;
*) echo unexpected-docker-command >> "$EVENTS"; exit 99;;
esac''')
        self.env = {**os.environ, 'PATH': str(self.bin) + ':/usr/bin:/bin',
                    'OPHIS_OP_DEPLOY_DIR': str(self.op), 'OPHIS_ARC_DEPLOY_DIR': str(self.arc),
                    'EVENTS': str(self.root / 'events'), 'DUMMY_KEY': str(self.root / 'dummy-key'),
                    'INFO_COUNT': str(self.root / 'docker-info-count')}

    def write(self, file, body):
        file.write_text('#!/bin/bash\nset -eu\n' + body + '\n')
        file.chmod(0o700)

    def run_recovery(self, mode, **env):
        result = subprocess.run(['/bin/bash', str(SCRIPT), mode], env={**self.env, **env},
                                text=True, capture_output=True)
        events = (self.root / 'events').read_text().splitlines() if (self.root / 'events').exists() else []
        return result, events

    def test_healthy_login_does_not_prompt_or_restart(self):
        result, events = self.run_recovery('--login')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(events, ['boot'])

    def test_missing_ram_opens_terminal_without_reading_keys(self):
        (self.op / 'rendered/erpc.yaml').unlink()
        result, events = self.run_recovery('--login')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(events, ['boot', 'terminal'])

    def test_login_waits_for_docker_socket(self):
        result, events = self.run_recovery('--login', READY_AFTER='2')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(events, ['boot'])
        self.assertGreaterEqual(int((self.root / 'docker-info-count').read_text()), 3)

    def test_unavailable_docker_never_prompts_or_changes_services(self):
        result, events = self.run_recovery('--login', READY_AFTER='100')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(events, ['boot'])

    def test_stopped_driver_prompts_at_login(self):
        result, events = self.run_recovery('--login', STOPPED='1')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(events, ['boot', 'terminal'])

    def test_restore_starts_only_stopped_container_after_proofs(self):
        result, events = self.run_recovery('--restore', STOPPED='1')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(events, ['render', 'key-proof', 'rpc-proof', 'start ophis-arc-driver-1'])

    def test_failed_inventory_changes_nothing(self):
        result, events = self.run_recovery('--restore', INVENTORY_EXIT='1')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(events, [])

    def test_authentication_or_mount_failure_never_starts_services(self):
        for env, expected in [({'RENDER_EXIT': '1'}, ['render']),
                              ({'KEY_EXIT': '1'}, ['render', 'key-proof']),
                              ({'RPC_EXIT': '1'}, ['render', 'key-proof', 'rpc-proof'])]:
            with self.subTest(env=env):
                (self.root / 'events').unlink(missing_ok=True)
                result, events = self.run_recovery('--restore', STOPPED='1', **env)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(events, expected)


if __name__ == '__main__':
    unittest.main()
