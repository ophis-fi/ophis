#!/usr/bin/env python3
"""Fail closed on ambiguous backend build/deployment provenance; never prints config secrets."""
import json
import os
import re
import stat
import subprocess
import sys
from pathlib import Path


def output(*args):
    return subprocess.check_output(args, text=True, stderr=subprocess.PIPE).strip()


def validate_revision(revision):
    if not re.fullmatch(r"[0-9a-f]{40}", revision):
        raise ValueError("backend revision must be a full lowercase 40-hex commit SHA")
    return revision


def source_revision(root):
    revision = validate_revision(output("git", "-C", str(root), "rev-parse", "HEAD"))
    dirty = output("git", "-C", str(root), "status", "--porcelain", "--untracked-files=all", "--", "apps/backend", "infra")
    if dirty:
        raise ValueError("backend/infra source is dirty; build and deploy a clean reviewed commit")
    return revision


def verify_images(compose_file, revision):
    validate_revision(revision)
    # Do not log resolved Compose JSON: it can contain service credentials.
    config = json.loads(output("docker", "compose", "-f", str(compose_file), "config", "--format", "json"))
    images = {}
    for service in config["services"].values():
        build = service.get("build", {})
        if not build or Path(build["context"]).name != "backend":
            continue
        if build.get("args", {}).get("OPHIS_GIT_SHA") != revision:
            raise ValueError("backend Compose build revision differs from reviewed source")
        if service.get("pull_policy") != "never":
            raise ValueError("backend images must disable pulling after verification")
        name = service["image"]
        if name in images:
            continue
        metadata = json.loads(output("docker", "image", "inspect", name))[0]
        if (metadata["Config"].get("Labels") or {}).get("org.opencontainers.image.revision") != revision:
            raise ValueError(f"backend image {name} has missing or mismatched source revision")
        images[name] = metadata["Id"]
    if not images:
        raise ValueError("no backend images found in Compose configuration")
    return {"revision": revision, "images": images}


def record_compose_revision(directory, revision):
    """Preserve the checked rollout revision for later bare Compose operations.

    Compose takes the last assignment in .env. Append without reading or
    rewriting any existing credentials; the next build still verifies source.
    """
    validate_revision(revision)
    descriptor = os.open(Path(directory) / ".env", os.O_WRONLY | os.O_APPEND |
                         os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
    with os.fdopen(descriptor, "a") as file:
        if not stat.S_ISREG(os.fstat(file.fileno()).st_mode):
            raise ValueError("Compose .env must be a regular file")
        os.fchmod(file.fileno(), 0o600)
        file.write(f"\n# Verified backend rollout revision\nOPHIS_GIT_SHA={revision}\n")
        file.flush()
        os.fsync(file.fileno())


def main():
    if len(sys.argv) == 3 and sys.argv[1] == "source":
        print(source_revision(Path(sys.argv[2])))
    elif len(sys.argv) == 4 and sys.argv[1] == "images":
        print(json.dumps(verify_images(Path(sys.argv[2]), sys.argv[3]), sort_keys=True))
    elif len(sys.argv) == 4 and sys.argv[1] == "record":
        record_compose_revision(Path(sys.argv[2]), sys.argv[3])
    else:
        raise ValueError("usage: backend-revision.py source REPO | images COMPOSE FULL_SHA | record DIRECTORY FULL_SHA")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, KeyError, OSError, subprocess.CalledProcessError) as error:
        # CalledProcessError omits captured stderr/stdout (potential secrets).
        sys.exit(f"backend provenance check failed: {error}")
