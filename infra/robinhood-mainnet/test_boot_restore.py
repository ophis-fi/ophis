#!/usr/bin/env python3
"""Run without Docker/root: python3 infra/robinhood-mainnet/test_boot_restore.py."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile


def executable(path, body):
    path.write_text("#!/usr/bin/env bash\nset -eu\n" + body)
    path.chmod(0o755)


with tempfile.TemporaryDirectory() as temporary:
    root = Path(temporary)
    shutil.copy2(Path(__file__).with_name("boot-restore.sh"), root)
    for name in ("rendered", "observability-rendered", "bin", "ram"):
        (root / name).mkdir()
    (root / "rendered/driver.toml").symlink_to(root / "ram/driver.toml")
    (root / "rendered/erpc.yaml").write_text("original quorum\n")
    (root / "observability-rendered/token").write_text("original token\n")
    (root / "rendered/driver.toml.BAK").write_text("historical artifact\n")
    executable(root / "render-configs.sh", '''
printf 'changed quorum\n' > rendered/erpc.yaml
rm -f observability-rendered/token rendered/driver.toml.BAK
touch rendered/new.yaml
if [ "${FAIL_RENDER:-0}" = 1 ]; then exit 1; fi
printf 'fake test config\n' > ram/driver.toml
''')
    executable(root / "bin/sudo", 'shift 3\nexec "$@"\n')
    executable(root / "bin/docker", '''
case "$1" in
  info) ;;
  start) test -f rendered/driver.toml; touch started; echo "$2" >> starts ;;
  inspect)
    case "${3:-}" in
      *State.Running*) if [ -f started ]; then echo true; else echo false; fi ;;
      *State.Health*) echo healthy ;;
      *HostPort*) echo 8411 ;;
    esac ;;
  *) exit 99 ;;
esac
''')
    executable(root / "bin/curl", "printf '%s\\n' '{\"ok\":true}'\n")
    env = dict(os.environ, PATH=f"{root / 'bin'}:{os.environ['PATH']}")
    subprocess.run(["bash", "boot-restore.sh"], cwd=root, env=env, check=True)
    assert (root / "rendered/erpc.yaml").read_text() == "original quorum\n"
    assert (root / "observability-rendered/token").read_text() == "original token\n"
    assert not (root / "rendered/new.yaml").exists()
    assert not (root / "rendered/driver.toml.BAK").exists()
    assert (root / "starts").read_text() == "robinhood-mainnet-driver-1\n"
    subprocess.run(["bash", "boot-restore.sh"], cwd=root, env=env, check=True)
    assert len((root / "starts").read_text().splitlines()) == 1
    (root / "started").unlink()
    result = subprocess.run(["bash", "boot-restore.sh"], cwd=root,
                            env=dict(env, FAIL_RENDER="1"))
    assert result.returncode == 4 and not (root / "started").exists()
    assert (root / "rendered/erpc.yaml").read_text() == "original quorum\n"
    assert (root / "observability-rendered/token").read_text() == "original token\n"
    assert not (root / "rendered/new.yaml").exists()
print("PASS: missing RAM config recovery, preserved configs, idempotency, fail-closed startup")
