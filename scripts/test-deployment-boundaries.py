#!/usr/bin/env python3
"""Guard the workflow side of protected deployment environments."""
from pathlib import Path
import unittest
import yaml


ROOT = Path(__file__).resolve().parents[1]
MAIN = "github.ref == 'refs/heads/main'"
PREVIEW = "${{ github.ref == 'refs/heads/main' && 'Production' || 'Preview' }}"
SECRETS = ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_WORKERS_TOKEN', 'FORMSPREE_DEPLOY_KEY', 'OTC_CONTROL_TOKEN']


class DeploymentBoundaries(unittest.TestCase):
    def test_every_deployment_credential_is_environment_scoped(self):
        seen = set()
        for path in (ROOT / '.github/workflows').glob('*.yml'):
            workflow = yaml.safe_load(path.read_text())
            for name, job in (workflow.get('jobs') or {}).items():
                if not any(f'secrets.{secret}' in str(job) for secret in SECRETS):
                    continue
                seen.add(path.name)
                with self.subTest(workflow=path.name, job=name):
                    environment = job.get('environment')
                    if path.name == 'mcp-registry-release.yml':
                        self.assertEqual(environment, 'MCP Registry')
                        self.assertEqual(job.get('needs'), 'validate')
                    elif environment == PREVIEW:
                        for step in job.get('steps', []):
                            if any(f'secrets.{secret}' in str(step) for secret in SECRETS):
                                self.assertIn(MAIN, step.get('if', ''))
                    else:
                        self.assertEqual(environment, 'Production')
                        self.assertIn(MAIN, job.get('if', ''))
        self.assertEqual(seen, {
            'cloudflare-deploy.yml', 'safe-app-deploy.yml', 'docs-deploy.yml',
            'landing-deploy.yml', 'mcp-deploy.yml', 'compat-api-deploy.yml',
            'otc-runtime-control.yml', 'mcp-registry-release.yml',
        })

    def test_other_control_plane_credentials_are_environment_scoped(self):
        expected = {
            'TS_OIDC_CLIENT_ID': 'Production',
            'TS_OIDC_AUDIENCE': 'Production',
            'MCP_PRIVATE_KEY': 'MCP Registry',
            'NPM_TOKEN': 'Package Release',
        }
        counts = dict.fromkeys(expected, 0)
        for path in (ROOT / '.github/workflows').glob('*.yml'):
            workflow = yaml.safe_load(path.read_text())
            for name, job in (workflow.get('jobs') or {}).items():
                for secret, environment in expected.items():
                    if f'secrets.{secret}' not in str(job):
                        continue
                    counts[secret] += 1
                    with self.subTest(workflow=path.name, job=name, secret=secret):
                        self.assertEqual(job.get('environment'), environment)
                        if environment == 'Package Release':
                            trigger = workflow.get('on', workflow.get(True))
                            self.assertTrue(trigger['push']['tags'])
                            self.assertIn('git merge-base --is-ancestor', str(job))
        self.assertEqual(counts, {
            'TS_OIDC_CLIENT_ID': 1, 'TS_OIDC_AUDIENCE': 1,
            'MCP_PRIVATE_KEY': 1, 'NPM_TOKEN': 5,
        })

    def test_indexer_keeps_host_credentials_on_main(self):
        workflow = yaml.safe_load((ROOT / '.github/workflows/rebate-indexer-deploy.yml').read_text())
        job = workflow['jobs']['deploy']
        self.assertEqual(job['environment'], 'Production')
        self.assertIn(MAIN, job['if'])

    def test_pull_requests_still_build_without_production_credentials(self):
        for name in ['landing-deploy', 'mcp-deploy', 'compat-api-deploy']:
            workflow = yaml.safe_load((ROOT / f'.github/workflows/{name}.yml').read_text())
            job = workflow['jobs']['build-deploy']
            self.assertNotIn('if', job)
            self.assertEqual(job['environment'], PREVIEW)


if __name__ == '__main__':
    unittest.main()
