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

A bare ">" is left alone deliberately, and so is a bare "&" that does not form
an entity ("R&D"); what is rejected is an entity-shaped token Telegram lacks,
such as "&nbsp;". Otherwise this -- Telegram tolerates both, and
this corpus has 77 legitimate ">" characters ("over 80%", "> 5/s").
"""
import re
import sys
from pathlib import Path

try:
    import yaml
except ImportError:  # pragma: no cover
    sys.exit("PyYAML is required. CI installs it explicitly; locally: pip install pyyaml")

# Telegram Bot API "Formatting options", HTML style.
ALLOWED = {
    "b", "strong", "i", "em", "u", "ins", "s", "strike", "del",
    "span", "tg-spoiler", "a", "tg-emoji", "code", "pre", "blockquote",
}
TAG = re.compile(r"<(/?)([A-Za-z][A-Za-z0-9_-]*)((?:\"[^\"]*\"|[^>\"])*)>")
TEMPLATE = re.compile(r"\{\{(.*?)\}\}", re.S)
# Anything shaped like an entity ("&word;" / "&#123;") must be one Telegram knows.
ENTITY = re.compile(r"&(#[0-9]+|#[xX][0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]*);")
ENTITY_OK = {"lt", "gt", "amp", "quot"}
# Prometheus renders annotations with these four fields in scope; $labels, $value,
# $externalLabels and $externalURL are aliases for them. Any OTHER dotted root
# (.Annotations, .State, .CommonLabels) is Alertmanager-side and fails at
# notification time after parsing cleanly.
DOTTED_ROOT = re.compile(r"(?:^|[\s(|])\.([A-Za-z][A-Za-z0-9_]*)")
PROM_FIELDS = {"Labels", "Value", "ExternalLabels", "ExternalURL"}


def html_problems(text):
    """Yield every reason Telegram would reject this string."""
    stack, pos = [], 0
    for m in TAG.finditer(text):
        # Any "<" not starting a well-formed tag is fatal on its own.
        for stray in re.finditer(r"<", text[pos:m.start()]):
            yield f"unescaped {text[pos + stray.start():pos + stray.start() + 12]!r}"
        pos = m.end()
        closing, name, attrs = m.group(1), m.group(2).lower(), m.group(3)
        if name not in ALLOWED:
            yield f"unsupported tag {m.group(0)!r}"
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
    for e in ENTITY.finditer(text):
        body = e.group(1)
        if not body.startswith("#") and body not in ENTITY_OK:
            yield f"unsupported entity {e.group(0)!r}; Telegram knows only &lt; &gt; &amp; &quot; and numeric"


def template_problems(text):
    for m in TEMPLATE.finditer(text):
        for root in DOTTED_ROOT.findall(m.group(1)):
            if root not in PROM_FIELDS:
                yield (f"template {m.group(0)!r} references .{root}, which Prometheus does not "
                       f"provide; it has only {', '.join('.' + f for f in sorted(PROM_FIELDS))}")


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
        ("line one<br>line two", "<br> is not a Telegram tag"),
        ("hard&nbsp;space", "unsupported named entity"),
        ("saw {{ .Annotations.description }}", "Alertmanager-only template"),
        ("state {{ .State.Status }} now", "Alertmanager-only dotted root"),
    ]
    cases_good = [
        "wsl --manage Ubuntu-24.04 --resize 1845GB",
        "<b>bold</b> and <code>x</code> nested fine",
        '<span class="tg-spoiler">hidden</span>',
        "{{ $labels.instance }} disk {{ $value | humanize }} full",
        "{{ .Labels.instance }} at {{ .Value }} on {{ .ExternalURL }}",
        "consensus over 80% and > 5/s and R&D and &amp; and &#8212;",
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
