# Runs a command in a pseudo-terminal and answers its prompts in order, for tests/age.mjs: the ceremony asks through
# the terminal (Enter, the YubiKey PIN, the key typed back unseen), as the key holder answers.
# argv: the rules (JSON: [{"when": regex, "send": text, "from": regex}], each used once, in order, on the output after
# the last match; "{from}" in a send is group 1 of "from" on all the output so far, as typed back from a paper), then
# the command. Prints all the command wrote; exits with its status. Run with: python3 -I tests/pty.py RULES /bin/bash script
import json, os, pty, re, select, sys, time

rules, cmd = json.loads(sys.argv[1]), sys.argv[2:]
pid, fd = pty.fork()
if pid == 0:
    os.execv(cmd[0], cmd)
out, i, upto, deadline = b'', 0, 0, time.time() + 90
while time.time() < deadline:
    if select.select([fd], [], [], 0.2)[0]:
        try:
            data = os.read(fd, 4096)
        except OSError:
            break
        if not data:
            break
        out += data
    text = out.decode('utf-8', 'replace')
    while i < len(rules):
        m = re.search(rules[i]['when'], text[upto:])
        if not m:
            break
        upto += m.end()
        f = re.search(rules[i]['from'], text) if 'from' in rules[i] else None
        os.write(fd, rules[i]['send'].replace('{from}', f.group(1) if f else '').encode())
        i += 1
else:
    os.kill(pid, 9)
_, status = os.waitpid(pid, 0)
sys.stdout.write(out.decode('utf-8', 'replace'))
sys.exit(os.waitstatus_to_exitcode(status))
