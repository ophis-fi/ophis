#!/usr/bin/env python3
"""Offline provenance and signing-policy regressions (no keys, containers, or RPC)."""
import importlib.util
import json
import os
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
