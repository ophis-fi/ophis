#!/usr/bin/env python3
"""Offline provenance and signing-policy regressions (no keys, containers, or RPC)."""
import importlib.util
import json
import os
import re
import shlex
from pathlib import Path
import subprocess
import tempfile
import tomllib
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
spec = importlib.util.spec_from_file_location("backend_revision", HERE / "backend-revision.py")
revision = importlib.util.module_from_spec(spec)
spec.loader.exec_module(revision)
SHA = "a" * 40


class Provenance(unittest.TestCase):
    def test_builds_each_real_shared_image_once(self):
        for chain, image_count in [("optimism", 6), ("unichain", 6), ("robinhood", 6), ("arc", 2)]:
            compose = ROOT / f"infra/{chain}-mainnet" / ("release/docker-compose.yml" if chain == "arc" else "docker-compose.yml")
            document = compose.read_text()
            # Resolve the actual service aliases with synthetic env only; no keys or daemon.
            env = dict(os.environ)
            for name in re.findall(r"\$\{([A-Z_][A-Z_0-9]*)", document):
                env.pop(name, None)
            for name in re.findall(r"\$\{([A-Z_][A-Z_0-9]*):?\?", document):
                env[name] = "test-only"
            env.update(OPHIS_GIT_SHA=SHA, ARC_RELEASE_TAG=SHA, ARC_RUNTIME_UID="10001", ARC_RUNTIME_GID="10001",
                       ARC_QUICKNODE_CREDIT_ALLOWANCE="1", ARC_SOLVER_KEY_FILE="/test-only/solver.key",
                       ARC_QUICKNODE_RPC_URL="https://example.invalid", ERPC_IMAGE="example.invalid/erpc:test")
            config = subprocess.check_output([
                "docker", "compose", "--env-file", os.devnull, "-f", str(compose), "--profile", "*",
                "config", "--no-env-resolution", "--format", "json"
            ], env=env, text=True, stderr=subprocess.PIPE)
            services = json.loads(config)["services"]
            with self.subTest(chain=chain), patch.object(revision, "output", return_value=config), patch.object(revision.subprocess, "run") as run:
                revision.build_images(compose, SHA)
                built = []
                for call in run.call_args_list:
                    command = call.args[0]
                    self.assertEqual(command[:5], ["docker", "compose", "-f", str(compose), "build"])
                    self.assertEqual(len(command), 6)
                    self.assertEqual(call.kwargs, {"check": True})
                    built.append(services[command[5]]["image"])
                required = {service["image"] for service in services.values() if service.get("build")}
                self.assertEqual(len(built), image_count)
                self.assertEqual(len(built), len(set(built)))
                self.assertEqual(set(built), required)

    def test_conflicting_compose_selection_is_rejected_and_equivalent_selection_is_pinned(self):
        with tempfile.TemporaryDirectory(prefix=".compose-selection-test-", dir=ROOT) as directory:
            root = Path(directory)
            canonical = root / "docker-compose.yml"
            canonical.write_text("services:\n  app:\n    image: reviewed:test\n")
            env = {k: v for k, v in os.environ.items() if not k.startswith("COMPOSE_")}
            command = ["python3", str(HERE / "backend-revision.py"), "compose-file", str(canonical)]

            def checked(extra=None):
                return subprocess.run(command, cwd=root, env={**env, **(extra or {})}, capture_output=True, text=True)

            result = checked()
            self.assertEqual(result.returncode, 0, result.stderr)
            pinned = result.stdout.strip()
            self.assertEqual(pinned, str(canonical))
            for filename in ["compose.yaml", "docker-compose.override.yml", "custom.yml"]:
                conflicting = root / filename
                conflicting.write_text("services:\n  app:\n    image: unreviewed:test\n    environment:\n      EXAMPLE_SECRET: never-print-this\n")
                modes = [{"COMPOSE_FILE": str(conflicting)}, {}] if filename != "custom.yml" else [{"COMPOSE_FILE": str(conflicting)}]
                for override in modes:
                    with self.subTest(filename=filename, override=bool(override)):
                        result = checked(override)
                        self.assertNotEqual(result.returncode, 0)
                        self.assertIn("Compose overrides differ", result.stderr)
                        self.assertNotIn("never-print-this", result.stdout + result.stderr)
                (root / ".env").write_text(f"COMPOSE_FILE={conflicting}\n")
                self.assertNotEqual(checked().returncode, 0)
                # The exported pin dominates env-file and preferred/override-file discovery.
                self.assertEqual(checked({"COMPOSE_FILE": pinned}).returncode, 0)
                (root / ".env").unlink()
                conflicting.unlink()

    def test_symlinked_release_and_unresolved_profile_env_files(self):
        with self.assertRaisesRegex(ValueError, "absolute path"):
            revision.checked_compose_file(Path("docker-compose.yml"))
        with tempfile.TemporaryDirectory(prefix=".compose-symlink-test-", dir=ROOT) as directory:
            root = Path(directory)
            release = root / "release"
            release.mkdir()
            (release / "backend").mkdir()
            (release / "config").mkdir()
            linked = root / "current"
            linked.symlink_to(release, target_is_directory=True)
            service = {"image": f"backend:{SHA}", "pull_policy": "never",
                       "build": {"context": "./backend", "args": {"OPHIS_GIT_SHA": SHA}},
                       "volumes": ["./config:/config:ro"]}
            document = {"services": {"app": service, "monitor": {
                **service, "profiles": ["observability"], "env_file": ["./missing-monitor.env"]}}}
            compose = linked / "docker-compose.yml"
            compose.write_text(json.dumps(document))
            env = {k: v for k, v in os.environ.items() if not k.startswith("COMPOSE_")}
            env["PWD"] = str(linked)
            command = ["python3", str(HERE / "backend-revision.py"), "compose-file", str(compose)]
            result = subprocess.run(command, cwd=linked, env=env, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout.strip(), str(compose))
            probe = "import json,runpy,sys; from pathlib import Path; scope=runpy.run_path(sys.argv[1]); print(json.dumps(scope['backend_builds'](Path(sys.argv[2]),sys.argv[3])))"
            builds = json.loads(subprocess.check_output([
                "python3", "-c", probe, str(HERE / "backend-revision.py"), str(compose), SHA
            ], cwd=linked, env=env, text=True))
            self.assertEqual(list(builds), [f"backend:{SHA}"])
            self.assertEqual(builds[f"backend:{SHA}"]["definition"]["build"]["context"], str(linked / "backend"))
            # Even an inactive profile's env-file path must remain part of the comparison.
            document["services"]["monitor"]["env_file"] = ["./other-missing-monitor.env"]
            different = linked / "custom.yml"
            different.write_text(json.dumps(document))
            result = subprocess.run(command, cwd=linked, env={**env, "COMPOSE_FILE": str(different)}, capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("Compose overrides differ", result.stderr)

    def test_build_failure_and_conflicting_aliases_fail_closed(self):
        backend = {"image": f"backend:{SHA}", "pull_policy": "never",
                   "build": {"context": "/src/apps/backend", "args": {"OPHIS_GIT_SHA": SHA}}}
        other = {**backend, "image": f"other:{SHA}"}
        config = {"services": {"driver": backend, "orderbook": other}}
        with patch.object(revision, "output", return_value=json.dumps(config)), patch.object(revision.subprocess, "run", side_effect=subprocess.CalledProcessError(42, ["docker"])) as run:
            with self.assertRaises(subprocess.CalledProcessError):
                revision.build_images(Path("compose.yml"), SHA)
            self.assertEqual(run.call_count, 1)
        for change in [{"build": {**backend["build"], "target": "different"}},
                       {"build": {**backend["build"], "args": {"OPHIS_GIT_SHA": SHA, "RUSTFLAGS": "different"}}},
                       {"platform": "linux/amd64"}]:
            conflicting = {**backend, **change}
            config = {"services": {"driver": backend, "alias": conflicting}}
            with patch.object(revision, "output", return_value=json.dumps(config)), patch.object(revision.subprocess, "run") as run:
                with self.assertRaisesRegex(ValueError, "conflicting build definitions"):
                    revision.build_images(Path("compose.yml"), SHA)
                run.assert_not_called()

    def test_only_full_canonical_sha_is_a_release(self):
        self.assertEqual(revision.validate_revision(SHA), SHA)
        for value in ["", "main", "edge-registry-20261008", "a" * 39, "a" * 41, "A" * 40, SHA + "\n", "g" * 40]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                revision.validate_revision(value)

    def test_dirty_source_never_receives_release_stamp(self):
        with patch.object(revision, "output", side_effect=[SHA, ""]):
            self.assertEqual(revision.source_revision(ROOT), SHA)
        for state in [" M apps/backend/foo.rs", "?? apps/backend/foo.rs", "M  infra/foo"]:
            with patch.object(revision, "output", side_effect=[SHA, state]), self.assertRaises(ValueError):
                revision.source_revision(ROOT)
        with patch.object(revision, "output", side_effect=subprocess.CalledProcessError(128, ["git"])), self.assertRaises(subprocess.CalledProcessError):
            revision.source_revision(ROOT)

    def test_build_arg_and_every_image_must_match_source(self):
        backend = {"image": f"backend:{SHA}", "pull_policy": "never", "build": {"context": "/src/apps/backend", "args": {"OPHIS_GIT_SHA": SHA}}}
        config = {"services": {"driver": backend, "orderbook": backend}}
        metadata = [{"Id": "sha256:content-address", "Config": {"Labels": {"org.opencontainers.image.revision": SHA}}}]
        with patch.object(revision, "output", side_effect=[json.dumps(config), json.dumps(metadata)]) as call:
            result = revision.verify_images(Path("compose.yml"), SHA)
            self.assertEqual(result["images"], {f"backend:{SHA}": "sha256:content-address"})
            self.assertEqual(call.call_count, 2)
        for label in [None, "edge-registry-20261008", "b" * 40]:
            metadata[0]["Config"]["Labels"] = {"org.opencontainers.image.revision": label}
            with patch.object(revision, "output", side_effect=[json.dumps(config), json.dumps(metadata)]), self.assertRaises(ValueError):
                revision.verify_images(Path("compose.yml"), SHA)
        backend["build"]["args"]["OPHIS_GIT_SHA"] = "b" * 40
        with patch.object(revision, "output", return_value=json.dumps(config)), self.assertRaises(ValueError):
            revision.verify_images(Path("compose.yml"), SHA)
        with patch.object(revision, "output", return_value='{"services":{}}'), self.assertRaises(ValueError):
            revision.verify_images(Path("compose.yml"), SHA)

    def test_all_binary_build_scripts_embed_identical_full_revision(self):
        with tempfile.TemporaryDirectory(prefix=".build-version-test-", dir=ROOT) as directory:
            binary = Path(directory) / "build-version"
            for crate in ["autopilot", "driver", "orderbook", "solvers", "refunder"]:
                manifest_dir = ROOT / "apps/backend/crates" / crate
                subprocess.run(["rustc", "--edition=2024", str(manifest_dir / "build.rs"), "-o", str(binary)], check=True, capture_output=True)
                env = {**os.environ, "OPHIS_GIT_SHA": SHA}
                actual = subprocess.check_output([str(binary)], cwd=manifest_dir, env=env, text=True)
                self.assertIn(f"cargo:rustc-env=VERGEN_GIT_SHA={SHA}\n", actual)
                self.assertIn(f"cargo:rustc-env=VERGEN_GIT_DESCRIBE={SHA}\n", actual)
                for invalid in ["", "edge-registry-20261008", "a" * 39, SHA + "\n"]:
                    result = subprocess.run([str(binary)], cwd=manifest_dir, env={**env, "OPHIS_GIT_SHA": invalid}, capture_output=True)
                    self.assertNotEqual(result.returncode, 0, (crate, invalid))
                local_env = dict(os.environ)
                local_env.pop("OPHIS_GIT_SHA", None)
                local = subprocess.check_output([str(binary)], cwd=manifest_dir, env=local_env, text=True)
                self.assertIn("-dev\n", local)
                archive = Path(directory) / "archive"
                archive.mkdir(exist_ok=True)
                local_env["GIT_CEILING_DIRECTORIES"] = directory
                unversioned = subprocess.check_output([str(binary)], cwd=archive, env=local_env, text=True)
                self.assertIn("VERGEN_GIT_SHA=unversioned-dev\n", unversioned)


    def test_compose_revision_persists_without_reading_or_rewriting_credentials(self):
        with tempfile.TemporaryDirectory(prefix=".compose-revision-test-", dir=ROOT) as directory:
            envfile = Path(directory) / ".env"
            previous = "EXAMPLE_CREDENTIAL='test-only-value'\nOPHIS_GIT_SHA=" + "b" * 40
            envfile.write_text(previous)
            revision.record_compose_revision(directory, SHA)
            document = envfile.read_text()
            self.assertTrue(document.startswith(previous))
            self.assertTrue(document.endswith(f"OPHIS_GIT_SHA={SHA}\n"))
            self.assertEqual(envfile.stat().st_mode & 0o777, 0o600)
            # `config` is offline: no daemon or containers, only this synthetic .env.
            compose = Path(directory) / "compose.yml"
            compose.write_text('services:\n  example:\n    image: "example:${OPHIS_GIT_SHA:?required}"\n')
            env = dict(os.environ)
            env.pop("OPHIS_GIT_SHA", None)
            config = json.loads(subprocess.check_output([
                "docker", "compose", "--project-directory", directory,
                "-f", str(compose), "config", "--format", "json"
            ], cwd=directory, env=env, text=True))
            self.assertEqual(config["services"]["example"]["image"], f"example:{SHA}")

            # A caller cannot turn revision persistence into an arbitrary file write.
            envfile.unlink()
            target = Path(directory) / "other"
            target.write_text("untouched")
            envfile.symlink_to(target)
            with self.assertRaises(OSError):
                revision.record_compose_revision(directory, SHA)
            self.assertEqual(target.read_text(), "untouched")

    def test_robinhood_missing_db_secret_does_not_restore_old_revision(self):
        script = (ROOT / "infra/robinhood-mainnet/compose-up.sh").read_text()
        start = script.index("if [[ ! -s secrets/postgres-password ]]")
        end = script.index("\nfi", start) + len("\nfi")
        check = f"set -eu\nOPHIS_GIT_SHA={SHA}\n" + script[start:end] + '\nprintf "%s\\n" "$OPHIS_GIT_SHA"'
        with tempfile.TemporaryDirectory(prefix=".robinhood-revision-test-", dir=ROOT) as directory:
            (Path(directory) / ".env").write_text("POSTGRES_PASSWORD='test-only-value'\nOPHIS_GIT_SHA=" + "b" * 40 + "\n")
            result = subprocess.run(["/bin/bash", "-c", check], cwd=directory, text=True, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout.splitlines()[-1], SHA)
            secret = Path(directory) / "secrets/postgres-password"
            self.assertEqual(secret.read_text(), "test-only-value")
            self.assertEqual(secret.stat().st_mode & 0o777, 0o600)

    def test_rollout_args_cannot_change_checked_images(self):
        for chain in ["optimism", "unichain", "robinhood"]:
            script = (ROOT / f"infra/{chain}-mainnet/compose-up.sh").read_text()
            start = script.index("UP_ARGS=()")
            end = script.index("\ndone", start) + len("\ndone")
            check = "set -eu\n" + script[start:end] + '\nfor arg in ${UP_ARGS[@]+"${UP_ARGS[@]}"}; do printf "%s\\n" "$arg"; done'
            for args, expected in [([], ""), (["--build"], ""), (["--force-recreate", "driver"], "--force-recreate\ndriver\n")]:
                result = subprocess.run(["/bin/bash", "-c", check, "test", *args], text=True, capture_output=True)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result.stdout, expected)
            for args in [["--pull", "always"], ["--pull=always"]]:
                self.assertNotEqual(subprocess.run(["/bin/bash", "-c", check, "test", *args], capture_output=True).returncode, 0)

    def test_migrations_gate_every_backend_restart(self):
        # Execute the actual rollout tail with fake Compose/provenance commands.
        # The credential/render prefix is excluded; nothing reaches Docker/RPC.
        fake_commands = r"""
set -euo pipefail
UP_ARGS=()
PROFILES_ARG=""
python3() {
  printf 'provenance %s\n' "$2" >> "$ROLLOUT_TEST_LOG"
  if [[ "$2" == compose-file ]]; then
    if [[ "$ROLLOUT_TEST_SELECTION_EXIT" != 0 ]]; then return "$ROLLOUT_TEST_SELECTION_EXIT"; fi
    printf '%s\n' "$SCRIPT_DIR/docker-compose.yml"
  fi
  if [[ "$2" == build ]]; then return "$ROLLOUT_TEST_BUILD_EXIT"; fi
  if [[ "$2" == source ]]; then printf '%s\n' "$OPHIS_GIT_SHA"; fi
}
docker() {
  if [[ "$1" == compose && "$COMPOSE_FILE" != "$SCRIPT_DIR/docker-compose.yml" ]]; then return 99; fi
  printf 'docker %s\n' "$*" >> "$ROLLOUT_TEST_LOG"
  case "$*" in
    "compose run --rm migrations") return "$ROLLOUT_TEST_MIGRATION_EXIT" ;;
    "compose ps --services")
      if [[ "$ROLLOUT_TEST_EXISTING" == 1 ]]; then printf 'rpc-proxy\nalertmanager\nprometheus\n'; fi ;;
    inspect*) printf 'healthy\n' ;;
  esac
  return 0
}
"""
        for chain in ["optimism", "unichain", "robinhood"]:
            stack = ROOT / f"infra/{chain}-mainnet"
            source = (stack / "compose-up.sh").read_text()
            tail = source[source.index('\nPROFILES_ARG=""'):]
            for existing in ["0", "1"]:
                for selection_exit, build_exit, migration_exit in [("0", "0", "0"), ("0", "0", "42"), ("0", "41", "0"), ("43", "0", "0")]:
                    with self.subTest(chain=chain, existing=existing, selection_exit=selection_exit, build_exit=build_exit, migration_exit=migration_exit), tempfile.TemporaryDirectory(prefix=".rollout-test-", dir=ROOT) as directory:
                        log = Path(directory) / "commands.log"
                        observability = existing == "1" and (selection_exit, build_exit, migration_exit) == ("0", "0", "0")
                        if observability:
                            for relative in ["observability-rendered/alertmanager.yml", "observability/prometheus.yml"]:
                                file = Path(directory) / relative
                                file.parent.mkdir(exist_ok=True)
                                file.touch()
                        env = {**os.environ, "OPHIS_GIT_SHA": SHA,
                               "ROLLOUT_TEST_LOG": str(log), "ROLLOUT_TEST_EXISTING": existing,
                               "COMPOSE_FILE": "/conflicting/compose.yaml", "ROLLOUT_TEST_SELECTION_EXIT": selection_exit,
                               "ROLLOUT_TEST_BUILD_EXIT": build_exit,
                               "ROLLOUT_TEST_MIGRATION_EXIT": migration_exit}
                        script = fake_commands + "\nSCRIPT_DIR=" + shlex.quote(str(stack)) + "\n" + tail
                        result = subprocess.run(["/bin/bash", "-c", script], cwd=directory, env=env, text=True, capture_output=True)
                        commands = log.read_text().splitlines()
                        if selection_exit != "0":
                            self.assertEqual(result.returncode, int(selection_exit), result.stderr)
                            self.assertEqual(commands, ["provenance compose-file"])
                            continue
                        if build_exit != "0":
                            self.assertEqual(result.returncode, int(build_exit), result.stderr)
                            self.assertEqual(commands, ["provenance compose-file", "provenance build"])
                            continue
                        migrate = commands.index("docker compose run --rm migrations")
                        self.assertLess(commands.index("provenance build"), migrate)
                        self.assertLess(commands.index("provenance images"), migrate)
                        normalized = [command.replace("docker compose --profile observability ", "docker compose ") for command in commands]
                        changes = [i for i, command in enumerate(normalized)
                                   if command.startswith(("docker compose stop ", "docker compose up "))]
                        if migration_exit == "42":
                            self.assertEqual(result.returncode, 42, result.stderr)
                            self.assertEqual(changes, [])
                            self.assertNotIn("provenance record", commands)
                        else:
                            self.assertEqual(result.returncode, 0, result.stderr)
                            self.assertTrue(changes)
                            self.assertLess(migrate, min(changes))
                            self.assertGreater(commands.index("provenance record"), max(changes))
                            if existing == "1":
                                self.assertTrue(any(c.startswith("docker compose stop driver ") for c in commands))
                            if observability:
                                self.assertIn("docker compose --profile observability up -d --no-build", commands)
                                self.assertIn("docker compose --profile observability up -d --no-deps --force-recreate alertmanager", commands)

    def test_every_mainnet_solver_is_guarded_for_its_settlement(self):
        for chain in ["optimism", "unichain", "robinhood"]:
            document = (ROOT / f"infra/{chain}-mainnet/configs/driver.toml.tmpl").read_text()
            document = document.replace("${OPHIS_DRIVER_SUBMITTER_KEY}", "0x" + "01" * 32)
            config = tomllib.loads(document)
            for solver in config["solver"]:
                with self.subTest(chain=chain, solver=solver["name"]):
                    account = solver["account"]
                    self.assertIsInstance(account, dict)
                    self.assertEqual(account["settlement-targets"], [{"address": config["contracts"]["gp-v2-settlement"], "selectors": ["0x13d79a0b"]}])
                    self.assertTrue(account["require-zero-value"])
                    self.assertFalse(solver.get("submission-accounts"))


if __name__ == "__main__":
    unittest.main()
