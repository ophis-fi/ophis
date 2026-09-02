#!/usr/bin/env python3
"""Reject alert annotations Prometheus or Telegram cannot deliver.

WHY THIS EXISTS: promtool validates that an annotation PARSES. It never checks
that the resulting notification can be SENT. Two ways that fails here:

1. Telegram. alertmanager.yml.tmpl uses parse_mode HTML and interpolates
   {{ .Annotations.description }} raw, so an unescaped "<" is not literal text:
   Telegram tries to parse a tag, fails, and rejects the ENTIRE message. The
   alert fires and the operator is never told. On 2026-09-02 eight annotations
   across all three chains were in that state -- "<distro>", "<each upstream>",
   and "<1s of solve-time" -- including both Cadia disk alerts, the only warning
   for a filesystem with weeks of runway. Backticks do not help; HTML is parsed
   first. Write the real value, or say it without angle brackets.

2. Prometheus templating. Annotations are Go templates with only $labels,
   $value, $externalLabels and $externalURL in scope. A dotted field such as
   .Annotations.description or .State.Status is Alertmanager-side data: it
   parses fine and fails at notification time.

A bare ">" or "&" is left alone deliberately -- Telegram tolerates both, and
this corpus has 77 legitimate ">" characters ("over 80%", "> 5/s").
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

# Telegram Bot API "Formatting options", HTML style.
ALLOWED = {
    "b", "strong", "i", "em", "u", "ins", "s", "strike", "del",
    "span", "tg-spoiler", "a", "tg-emoji", "code", "pre", "blockquote",
}
VOID = {"br"}
TAG = re.compile(r"<(/?)([A-Za-z][A-Za-z0-9_-]*)((?:\"[^\"]*\"|[^>\"])*)>")
TEMPLATE = re.compile(r"\{\{(.*?)\}\}", re.S)
# A dotted root (".Foo") is Alertmanager context, absent when Prometheus renders.
DOTTED_ROOT = re.compile(r"(?:^|[\s(|])\.[A-Za-z]")


def html_problems(text):
    """Yield every reason Telegram would reject this string."""
    stack, pos = [], 0
    for m in TAG.finditer(text):
        # Any "<" not starting a well-formed tag is fatal on its own.
        for stray in re.finditer(r"<", text[pos:m.start()]):
            yield f"unescaped {text[pos + stray.start():pos + stray.start() + 12]!r}"
        pos = m.end()
        closing, name, attrs = m.group(1), m.group(2).lower(), m.group(3)
        if name not in ALLOWED and name not in VOID:
            yield f"unsupported tag {m.group(0)!r}"
        elif name in VOID:
            pass
        elif closing:
            if not stack or stack[-1] != name:
                yield f"unbalanced closing {m.group(0)!r}"
            else:
                stack.pop()
        else:
            # Telegram accepts <span> only as a spoiler; the class is required.
            if name == "span" and "tg-spoiler" not in attrs:
                yield f"span without class=\"tg-spoiler\" {m.group(0)!r}"
            stack.append(name)
    for stray in re.finditer(r"<", text[pos:]):
        yield f"unescaped {text[pos + stray.start():pos + stray.start() + 12]!r}"
    for name in stack:
        yield f"unclosed <{name}>"


def template_problems(text):
    for m in TEMPLATE.finditer(text):
        if DOTTED_ROOT.search(m.group(1)):
            yield f"template {m.group(0)!r} uses Alertmanager-only context; Prometheus has $labels/$value only"


def offenders(doc):
    for group in (doc or {}).get("groups") or []:
        for rule in group.get("rules") or []:
            name = rule.get("alert") or rule.get("record") or "(unnamed)"
            for key, value in (rule.get("annotations") or {}).items():
                text = str(value)
                for problem in list(html_problems(text)) + list(template_problems(text)):
                    yield name, key, problem


def self_test():
    def one(desc):
        return {"groups": [{"rules": [{"alert": "A", "annotations": {"description": desc}}]}]}
    cases_bad = [
        ("wsl --manage <distro> --resize", "angle-bracket placeholder"),
        ("cast --rpc-url <each upstream>", "multi-word placeholder"),
        ("responses <1s of solve-time", "bare < before a digit"),
        ("<b>unclosed bold", "unclosed allowed tag"),
        ("</b>stray close", "unbalanced closing tag"),
        ("<span>no spoiler class</span>", "span without tg-spoiler"),
        ("<script>x</script>", "disallowed tag"),
        ("saw {{ .Annotations.description }}", "Alertmanager-only template"),
        ("state {{ .State.Status }} now", "dotted root template"),
    ]
    cases_good = [
        "wsl --manage Ubuntu-24.04 --resize 1845GB",
        "<b>bold</b> and <code>x</code> and <br> void",
        '<span class="tg-spoiler">hidden</span>',
        "{{ $labels.instance }} disk {{ $value | humanize }} full",
        "consensus over 80% and > 5/s and R&D",
    ]
    for text, why in cases_bad:
        assert list(offenders(one(text))), f"must catch: {why}"
    for text in cases_good:
        assert not list(offenders(one(text))), f"must accept: {text!r}"
    print(f"self-test: {len(cases_bad)} rejections + {len(cases_good)} acceptances all hold")


def main():
    if "--self-test" in sys.argv:
        self_test()
        return 0
    failures = 0
    for path in sorted(Path("infra").glob("*/observability/alerts.yml")):
        for name, key, problem in offenders(yaml.safe_load(path.read_text())):
            print(f"{path}: {name} [{key}] — {problem}", file=sys.stderr)
            failures += 1
    if failures:
        print(f"\n{failures} undeliverable annotation(s); the notification would fail, not degrade.", file=sys.stderr)
        return 1
    print("all alert annotations are deliverable")
    return 0


if __name__ == "__main__":
    sys.exit(main())
