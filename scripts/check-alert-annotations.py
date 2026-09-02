#!/usr/bin/env python3
"""Reject alert annotations Telegram cannot render.

WHY THIS EXISTS: alertmanager.yml.tmpl sends both receivers with
`parse_mode: HTML` and interpolates {{ .Annotations.description }} raw. Telegram
rejects a message containing an unsupported tag, so a placeholder written in
angle brackets -- `<distro>`, `<each upstream>` -- does not render as literal
text: it makes the ENTIRE notification fail to send. The alert still fires, the
operator is simply never told. On 2026-09-02 five annotations across all three
chains were in that state, including both Cadia disk alerts -- the only warning
for a filesystem with roughly three weeks of runway.

Backticks do not help; Telegram parses HTML before any Markdown convention.
Write the real value, or spell the placeholder without angle brackets.
"""
import re
import sys
from pathlib import Path

try:
    import yaml
except ImportError:  # pragma: no cover - CI bootstrap
    import subprocess
    subprocess.run([sys.executable, "-m", "pip", "install", "-q", "pyyaml"], check=True)
    import yaml

# Tags Telegram's HTML parse mode accepts (Bot API "Formatting options").
ALLOWED = {
    "b", "strong", "i", "em", "u", "ins", "s", "strike", "del",
    "span", "tg-spoiler", "a", "tg-emoji", "code", "pre", "blockquote",
}
TAG = re.compile(r"<(/?)([A-Za-z0-9_-]+)([^>]*)>")


def offenders(doc):
    """Yield (alert, annotation_key, offending_text) for every unrenderable tag."""
    for group in (doc or {}).get("groups") or []:
        for rule in group.get("rules") or []:
            name = rule.get("alert") or rule.get("record") or "<unnamed>"
            for key, value in (rule.get("annotations") or {}).items():
                for m in TAG.finditer(str(value)):
                    if m.group(2).lower() not in ALLOWED:
                        yield name, key, m.group(0)


def self_test():
    bad = {"groups": [{"rules": [{"alert": "A", "annotations": {"description": "run wsl --manage <distro> --resize"}}]}]}
    good = {"groups": [{"rules": [{"alert": "A", "annotations": {"description": "run wsl --manage Ubuntu-24.04 --resize 1845GB"}}]}]}
    allowed_html = {"groups": [{"rules": [{"alert": "A", "annotations": {"description": "<b>bold</b> and <code>x</code>"}}]}]}
    templated = {"groups": [{"rules": [{"alert": "A", "annotations": {"summary": "{{ $labels.instance }} disk full"}}]}]}
    assert list(offenders(bad)), "must catch an angle-bracket placeholder"
    assert not list(offenders(good)), "must accept a concrete value"
    assert not list(offenders(allowed_html)), "must accept Telegram's own tags"
    assert not list(offenders(templated)), "must not trip on Prometheus templating"
    assert list(offenders({"groups": [{"rules": [{"alert": "B", "annotations": {"d": "a <each upstream> b"}}]}]})), \
        "must catch a multi-word placeholder"
    print("self-test: 5/5 assertions hold")


def main():
    if "--self-test" in sys.argv:
        return self_test() or 0
    failures = 0
    for path in sorted(Path("infra").glob("*/observability/alerts.yml")):
        doc = yaml.safe_load(path.read_text())
        for name, key, text in offenders(doc):
            print(f"{path}: {name} [{key}] contains {text!r} — Telegram will reject the whole message", file=sys.stderr)
            failures += 1
    if failures:
        print(f"\n{failures} unrenderable annotation(s). Write the real value, or drop the angle brackets.", file=sys.stderr)
        return 1
    print("all alert annotations are Telegram-renderable")
    return 0


if __name__ == "__main__":
    sys.exit(main())
