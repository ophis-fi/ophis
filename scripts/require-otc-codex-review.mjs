#!/usr/bin/env node

/**
 * Fail-closed merge gate for Milestone C money-path changes.
 *
 * Codex records either (a) a review tied to a commit, with line comments when
 * it found issues, or (b) a +1 reaction when the review is clean. A reaction
 * must be newer than GitHub's workflow-run creation time (not a contributor-
 * controlled commit timestamp), and no Codex line finding may target that
 * head. Pushes create a new run and therefore invalidate earlier evidence.
 */

const CODEX_LOGIN = 'chatgpt-codex-connector[bot]';
const SCOPED_PATHS = [
  '.github/workflows/frontend-ci.yml',
  '.github/workflows/otc-milestone-c-fork.yml',
  '.github/workflows/otc-milestone-c-gate.yml',
  'apps/frontend/apps/cowswap-frontend-e2e/',
  'apps/frontend/apps/cowswap-frontend/src/ophis/otcWrite/',
  'apps/frontend/apps/cowswap-frontend/src/ophis/otc/',
  'apps/frontend/apps/cowswap-frontend/src/pages/Otc/',
  'apps/frontend/libs/common-const/src/nativeAndWrappedTokens.ts',
  'apps/frontend/libs/common-const/src/tokens.ts',
  'apps/frontend/libs/common-const/src/index.ts',
  'apps/frontend/libs/common-hooks/src/useFeatureFlags.ts',
  'apps/frontend/libs/common-hooks/src/index.ts',
  'apps/frontend/libs/common-utils/src/environments.ts',
  'apps/frontend/libs/common-utils/src/index.ts',
  'apps/frontend/libs/tokens/src/services/tokenPolicy.ts',
  'apps/frontend/libs/tokens/src/services/tokenPolicy.spec.ts',
  'apps/frontend/libs/tokens/src/index.ts',
  'apps/frontend/libs/wallet/',
  'apps/frontend/libs/wallet-provider/',
  'apps/frontend/nx.json',
  'apps/frontend/package.json',
  'apps/frontend/pnpm-lock.yaml',
  'apps/frontend/tsconfig.base.json',
  'apps/frontend/apps/cowswap-frontend/project.json',
  'apps/frontend/apps/cowswap-frontend/tsconfig.app.json',
  'apps/frontend/apps/cowswap-frontend-e2e/project.json',
  'apps/frontend/apps/cowswap-frontend-e2e/tsconfig.json',
  'contracts/foundry.toml',
  'contracts/test/otc-fork/',
  'OPHIS_OTC_MILESTONE_C_APPSEC_REVIEW_2026-08-21.md',
  'OPHIS_OTC_MILESTONE_C_DIFFERENTIAL_REVIEW_2026-08-21.md',
  'docs/superpowers/plans/2026-08-21-ophis-otc-milestone-c.md',
  'scripts/require-otc-codex-review.mjs',
];

function isScopedPath(path) {
  return SCOPED_PATHS.some(
    (scope) => path === scope || (scope.endsWith('/') && path.startsWith(scope)),
  );
}

function codexItems(items) {
  return items.filter((item) => item?.user?.login === CODEX_LOGIN);
}

export function assessCodexGate({
  headSha,
  gateCreatedAt,
  changedFiles,
  files,
  reviews,
  reviewComments,
  issueReactions,
}) {
  if (changedFiles !== files.length) {
    return {
      required: true,
      accepted: false,
      reason: `GitHub reported ${changedFiles} changed files but exposed ${files.length}; refusing incomplete scope evidence.`,
    };
  }
  if (!files.some(({ filename }) => isScopedPath(filename))) {
    return { required: false, accepted: true, reason: 'No Milestone C money-path file changed.' };
  }

  const shortHead = headSha.slice(0, 10);
  const findings = codexItems(reviewComments).filter((comment) => comment.commit_id === headSha);
  if (findings.length > 0) {
    return {
      required: true,
      accepted: false,
      reason: `Codex left ${findings.length} finding(s) on head ${shortHead}; push fixes and request a fresh review.`,
    };
  }

  const exactReviews = codexItems(reviews).filter(
    (review) => review.commit_id === headSha || String(review.body ?? '').includes(shortHead),
  );
  const blockedReview = exactReviews.some((review) =>
    ['CHANGES_REQUESTED', 'DISMISSED'].includes(String(review.state ?? '').toUpperCase()),
  );
  if (blockedReview) {
    return {
      required: true,
      accepted: false,
      reason: `Codex review state blocks head ${shortHead}; push fixes and request a fresh review.`,
    };
  }

  const exactReview = exactReviews.some(
    (review) => String(review.state ?? '').toUpperCase() === 'APPROVED',
  );
  const gateTime = Date.parse(gateCreatedAt);
  const freshThumb = codexItems(issueReactions).some(
    (reaction) => reaction.content === '+1' && Date.parse(reaction.created_at) >= gateTime,
  );

  if (exactReview || freshThumb) {
    return {
      required: true,
      accepted: true,
      reason: `Fresh clean Codex evidence covers head ${shortHead}.`,
    };
  }

  return {
    required: true,
    accepted: false,
    reason: `No clean Codex review evidence covers head ${shortHead}. Request @codex review, then rerun this job.`,
  };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function selfTest() {
  const base = {
    headSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    gateCreatedAt: '2026-08-20T12:00:00Z',
    changedFiles: 1,
    files: [{ filename: 'apps/frontend/apps/cowswap-frontend/src/ophis/otcWrite/index.ts' }],
    reviews: [],
    reviewComments: [],
    issueReactions: [],
  };
  assert(!assessCodexGate(base).accepted, 'missing evidence must fail');
  assert(
    assessCodexGate({
      ...base,
      reviewComments: [{ user: { login: CODEX_LOGIN }, commit_id: base.headSha }],
      issueReactions: [
        { user: { login: CODEX_LOGIN }, content: '+1', created_at: '2026-08-20T12:01:00Z' },
      ],
    }).accepted === false,
    'head findings must override a reaction',
  );
  assert(
    assessCodexGate({
      ...base,
      issueReactions: [
        { user: { login: CODEX_LOGIN }, content: '+1', created_at: '2026-08-20T12:01:00Z' },
      ],
    }).accepted,
    'fresh Codex +1 must pass',
  );
  assert(
    !assessCodexGate({ ...base, changedFiles: 3 }).accepted,
    'an incomplete GitHub file list must fail closed',
  );
  assert(
    !assessCodexGate({
      ...base,
      issueReactions: [
        { user: { login: CODEX_LOGIN }, content: '+1', created_at: '2026-08-20T11:59:59Z' },
      ],
    }).accepted,
    'a reaction older than the gate run must fail',
  );
  assert(
    !assessCodexGate({
      ...base,
      reviews: [
        { user: { login: CODEX_LOGIN }, state: 'COMMENTED', commit_id: 'b'.repeat(40), body: '' },
      ],
    }).accepted,
    'a review of an earlier head must fail after a push',
  );
  assert(
    assessCodexGate({
      ...base,
      reviews: [
        { user: { login: CODEX_LOGIN }, state: 'APPROVED', commit_id: base.headSha, body: '' },
      ],
    }).accepted,
    'exact-head clean review must pass',
  );
  assert(
    !assessCodexGate({
      ...base,
      reviews: [
        { user: { login: CODEX_LOGIN }, state: 'COMMENTED', commit_id: base.headSha, body: '' },
      ],
    }).accepted,
    'a comment-only review must not be treated as clean evidence',
  );
  assert(
    !assessCodexGate({
      ...base,
      reviews: [
        {
          user: { login: CODEX_LOGIN },
          state: 'CHANGES_REQUESTED',
          commit_id: base.headSha,
          body: '',
        },
      ],
    }).accepted,
    'an exact-head changes-requested review must fail',
  );
  assert(
    !assessCodexGate({
      ...base,
      reviews: [
        { user: { login: CODEX_LOGIN }, state: 'DISMISSED', commit_id: base.headSha, body: '' },
      ],
    }).accepted,
    'an exact-head dismissed review must fail',
  );
  assert(
    assessCodexGate({ ...base, files: [{ filename: 'README.md' }] }).accepted,
    'unrelated PR must pass without requiring Codex',
  );
  assert(
    !assessCodexGate({
      ...base,
      files: [{ filename: 'apps/frontend/libs/tokens/src/services/tokenPolicy.ts' }],
    }).accepted,
    'token policy changes must require Codex evidence',
  );
  for (const filename of [
    '.github/workflows/frontend-ci.yml',
    'apps/frontend/apps/cowswap-frontend-e2e/package.json',
    'apps/frontend/apps/cowswap-frontend/tsconfig.app.json',
    'apps/frontend/libs/common-const/src/index.ts',
    'apps/frontend/libs/common-hooks/src/index.ts',
    'apps/frontend/libs/common-utils/src/environments.ts',
    'apps/frontend/libs/common-utils/src/index.ts',
    'apps/frontend/libs/tokens/src/index.ts',
    'apps/frontend/libs/wallet-provider/src/hooks/useWalletProvider.ts',
    'apps/frontend/package.json',
    'apps/frontend/pnpm-lock.yaml',
  ]) {
    assert(
      !assessCodexGate({ ...base, files: [{ filename }] }).accepted,
      `${filename} changes must require Codex evidence`,
    );
  }
  process.stdout.write('OTC Codex review gate self-test passed\n');
}

async function api(path, token) {
  const items = [];
  let url = `https://api.github.com${path}`;
  while (url) {
    const response = await fetch(url, {
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'x-github-api-version': '2022-11-28',
      },
    });
    if (!response.ok) throw new Error(`GitHub API ${response.status} for ${path}`);
    const body = await response.json();
    if (!Array.isArray(body)) return body;
    items.push(...body);
    const link = response.headers.get('link') ?? '';
    const next = link
      .split(',')
      .map((part) => part.trim().match(/^<([^>]+)>; rel="next"$/)?.[1])
      .find(Boolean);
    url = next ?? '';
  }
  return items;
}

async function runLive() {
  const repository = process.env.GITHUB_REPOSITORY ?? '';
  const eventPath = process.env.GITHUB_EVENT_PATH ?? '';
  const runId = process.env.GITHUB_RUN_ID ?? '';
  const token = process.env.GITHUB_TOKEN ?? '';
  if (!repository || !eventPath || !runId || !token)
    throw new Error('Missing GitHub Actions review-gate context');

  const { readFile } = await import('node:fs/promises');
  const event = JSON.parse(await readFile(eventPath, 'utf8'));
  const pull = event.pull_request;
  if (!pull) throw new Error('Codex gate must run from a pull_request event');
  if (pull.draft) {
    process.stdout.write('Draft PR: Codex merge evidence will be required when marked ready.\n');
    return;
  }

  const number = pull.number;
  const [files, reviews, reviewComments, issueReactions, workflowRun] = await Promise.all([
    api(`/repos/${repository}/pulls/${number}/files?per_page=100`, token),
    api(`/repos/${repository}/pulls/${number}/reviews?per_page=100`, token),
    api(`/repos/${repository}/pulls/${number}/comments?per_page=100`, token),
    api(`/repos/${repository}/issues/${number}/reactions?per_page=100`, token),
    api(`/repos/${repository}/actions/runs/${runId}`, token),
  ]);
  const result = assessCodexGate({
    headSha: pull.head.sha,
    gateCreatedAt: workflowRun.created_at,
    changedFiles: pull.changed_files,
    files,
    reviews,
    reviewComments,
    issueReactions,
  });
  process.stdout.write(`${result.reason}\n`);
  if (!result.accepted) process.exitCode = 1;
}

if (process.argv.includes('--self-test')) {
  selfTest();
} else {
  await runLive();
}
