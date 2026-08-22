#!/usr/bin/env node

/**
 * Fail-closed merge gate for Milestone C money-path changes.
 *
 * Codex records findings and blocking state in reviews, and a clean result as
 * a +1 reaction on an explicit review-request comment that names the full head
 * and base SHAs. The reaction must post after the request's latest edit, and no
 * Codex line finding may target that head. Pushes and base edits therefore
 * invalidate earlier evidence without relying on ambiguous issue reactions.
 */

const CODEX_LOGIN = 'chatgpt-codex-connector[bot]';
const GITHUB_API_ORIGIN = 'https://api.github.com';
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

function isScopedFile(file) {
  return [file?.filename, file?.previous_filename].some(
    (path) => typeof path === 'string' && isScopedPath(path),
  );
}

function codexItems(items) {
  return items.filter((item) => item?.user?.login === CODEX_LOGIN);
}

function reviewedCommentSha(comment) {
  return comment.original_commit_id ?? comment.commit_id;
}

function reviewRequestBody(headSha, baseSha) {
  return `@codex review\n\nHead: ${headSha}\nBase: ${baseSha}`;
}

function hasBoundThumb(request, headSha, baseSha) {
  if (
    String(request?.body ?? '')
      .replaceAll('\r\n', '\n')
      .trim() !== reviewRequestBody(headSha, baseSha)
  ) {
    return false;
  }
  const updatedAt = Date.parse(request.updatedAt);
  if (!Number.isFinite(updatedAt)) return false;
  return codexItems(request.reactions ?? []).some(
    (reaction) =>
      reaction.content === '+1' &&
      Number.isFinite(Date.parse(reaction.created_at)) &&
      Date.parse(reaction.created_at) >= updatedAt,
  );
}

export function assessCodexGate({
  headSha,
  baseSha,
  changedFiles,
  files,
  reviews,
  reviewComments,
  reviewRequests,
}) {
  if (changedFiles !== files.length) {
    return {
      required: true,
      accepted: false,
      reason: `GitHub reported ${changedFiles} changed files but exposed ${files.length}; refusing incomplete scope evidence.`,
    };
  }
  if (!files.some(isScopedFile)) {
    return { required: false, accepted: true, reason: 'No Milestone C money-path file changed.' };
  }

  const shortHead = headSha.slice(0, 10);
  const findings = codexItems(reviewComments).filter(
    (comment) => reviewedCommentSha(comment) === headSha,
  );
  if (findings.length > 0) {
    return {
      required: true,
      accepted: false,
      reason: `Codex left ${findings.length} finding(s) on head ${shortHead}; push fixes and request a fresh review.`,
    };
  }

  const exactReviews = codexItems(reviews).filter((review) => review.commit_id === headSha);
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

  const freshThumb = reviewRequests.some((request) => hasBoundThumb(request, headSha, baseSha));

  if (freshThumb) {
    return {
      required: true,
      accepted: true,
      reason: `Fresh clean Codex evidence covers head ${shortHead}.`,
    };
  }

  return {
    required: true,
    accepted: false,
    reason: `No clean Codex review evidence covers head ${shortHead}. Comment "${reviewRequestBody(headSha, baseSha).replaceAll('\n', ' ')}", then rerun this job.`,
  };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertThrows(callback, message) {
  let threw = false;
  try {
    callback();
  } catch {
    threw = true;
  }
  assert(threw, message);
}

function selfTest() {
  const base = {
    headSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    baseSha: 'cccccccccccccccccccccccccccccccccccccccc',
    changedFiles: 1,
    files: [{ filename: 'apps/frontend/apps/cowswap-frontend/src/ophis/otcWrite/index.ts' }],
    reviews: [],
    reviewComments: [],
    reviewRequests: [],
  };
  assert(!assessCodexGate(base).accepted, 'missing evidence must fail');
  assert(
    assessCodexGate({
      ...base,
      reviewComments: [{ user: { login: CODEX_LOGIN }, commit_id: base.headSha }],
      reviewRequests: [
        {
          body: reviewRequestBody(base.headSha, base.baseSha),
          updatedAt: '2026-08-20T12:00:00Z',
          reactions: [
            { user: { login: CODEX_LOGIN }, content: '+1', created_at: '2026-08-20T12:01:00Z' },
          ],
        },
      ],
    }).accepted === false,
    'head findings must override a reaction',
  );
  assert(
    assessCodexGate({
      ...base,
      reviewComments: [
        {
          user: { login: CODEX_LOGIN },
          commit_id: base.headSha,
          original_commit_id: 'b'.repeat(40),
        },
      ],
      reviewRequests: [
        {
          body: reviewRequestBody(base.headSha, base.baseSha),
          updatedAt: '2026-08-20T12:00:00Z',
          reactions: [
            { user: { login: CODEX_LOGIN }, content: '+1', created_at: '2026-08-20T12:01:00Z' },
          ],
        },
      ],
    }).accepted,
    'a rebased line comment from an earlier head must not block the current head',
  );
  assert(
    assessCodexGate({
      ...base,
      reviewRequests: [
        {
          body: reviewRequestBody(base.headSha, base.baseSha),
          updatedAt: '2026-08-20T12:00:00Z',
          reactions: [
            { user: { login: CODEX_LOGIN }, content: '+1', created_at: '2026-08-20T12:01:00Z' },
          ],
        },
      ],
    }).accepted,
    'a Codex +1 bound to the exact head must pass',
  );
  assert(
    !assessCodexGate({ ...base, changedFiles: 3 }).accepted,
    'an incomplete GitHub file list must fail closed',
  );
  assert(
    !assessCodexGate({
      ...base,
      reviewRequests: [
        {
          body: reviewRequestBody(base.headSha, base.baseSha),
          updatedAt: '2026-08-20T12:00:00Z',
          reactions: [
            { user: { login: CODEX_LOGIN }, content: '+1', created_at: '2026-08-20T11:59:59Z' },
          ],
        },
      ],
    }).accepted,
    'a reaction older than the exact-head request edit must fail',
  );
  assert(
    !assessCodexGate({
      ...base,
      reviewRequests: [
        {
          body: reviewRequestBody('b'.repeat(40), base.baseSha),
          updatedAt: '2026-08-20T12:00:00Z',
          reactions: [
            { user: { login: CODEX_LOGIN }, content: '+1', created_at: '2026-08-20T12:01:00Z' },
          ],
        },
      ],
    }).accepted,
    'a reaction bound to an earlier head must fail after a push',
  );
  assert(
    !assessCodexGate({
      ...base,
      reviewRequests: [
        {
          body: reviewRequestBody(base.headSha, 'd'.repeat(40)),
          updatedAt: '2026-08-20T12:00:00Z',
          reactions: [
            { user: { login: CODEX_LOGIN }, content: '+1', created_at: '2026-08-20T12:01:00Z' },
          ],
        },
      ],
    }).accepted,
    'a reaction bound to an earlier base must fail after a base edit',
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
    !assessCodexGate({
      ...base,
      reviews: [
        { user: { login: CODEX_LOGIN }, state: 'APPROVED', commit_id: base.headSha, body: '' },
      ],
    }).accepted,
    'an approval without exact head-and-base reaction evidence must fail',
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
      files: [
        { filename: 'archive/retired-write-module.ts', previous_filename: base.files[0].filename },
      ],
    }).accepted,
    'renaming a scoped file out of scope must still require Codex evidence',
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
  assertThrows(
    () => nextPageUrl('<https://example.invalid/repos/ophis-fi/ophis?page=2>; rel="next"'),
    'pagination must stay on the GitHub API origin',
  );
  assertThrows(
    () => requireApiSegment('ophis-fi/other', 'repository'),
    'repository path segments must reject separators',
  );
  assertThrows(
    () => requirePositiveInteger('../1227', 'pull request number'),
    'numeric API path segments must reject traversal',
  );
  process.stdout.write('OTC Codex review gate self-test passed\n');
}

function requireApiSegment(value, label) {
  const segment = String(value);
  if (!/^[A-Za-z0-9_.-]+$/.test(segment)) throw new Error(`Invalid GitHub ${label}`);
  return segment;
}

function requirePositiveInteger(value, label) {
  const integer = String(value);
  if (!/^[1-9][0-9]*$/.test(integer)) throw new Error(`Invalid GitHub ${label}`);
  return integer;
}

function githubApiUrl(segments) {
  const url = new URL(GITHUB_API_ORIGIN);
  url.pathname = segments.map((segment) => encodeURIComponent(segment)).join('/');
  url.searchParams.set('per_page', '100');
  return url;
}

function nextPageUrl(link) {
  const value = link
    .split(',')
    .map((part) => part.trim().match(/^<([^>]+)>; rel="next"$/)?.[1])
    .find(Boolean);
  if (!value) return undefined;
  const url = new URL(value);
  if (
    url.origin !== GITHUB_API_ORIGIN ||
    url.username ||
    url.password ||
    !url.pathname.startsWith('/repos/')
  ) {
    throw new Error('Refusing untrusted GitHub pagination URL');
  }
  return url;
}

async function api(segments, token) {
  const items = [];
  let url = githubApiUrl(segments);
  while (url) {
    const response = await fetch(url, {
      redirect: 'error',
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'x-github-api-version': '2022-11-28',
      },
    });
    if (!response.ok) throw new Error(`GitHub API ${response.status} for ${url.pathname}`);
    const body = await response.json();
    if (!Array.isArray(body)) return body;
    items.push(...body);
    url = nextPageUrl(response.headers.get('link') ?? '');
  }
  return items;
}

async function runLive() {
  const repository = process.env.GITHUB_REPOSITORY ?? '';
  const numberValue = process.env.PULL_REQUEST_NUMBER ?? '';
  const headSha = process.env.PULL_REQUEST_HEAD_SHA ?? '';
  const baseSha = process.env.PULL_REQUEST_BASE_SHA ?? '';
  const changedFilesValue = process.env.PULL_REQUEST_CHANGED_FILES ?? '';
  const draft = process.env.PULL_REQUEST_DRAFT ?? '';
  const token = process.env.GITHUB_TOKEN ?? '';
  if (!repository || !numberValue || !headSha || !baseSha || !changedFilesValue || !draft || !token)
    throw new Error('Missing GitHub Actions review-gate context');
  const repositoryParts = repository.split('/');
  if (repositoryParts.length !== 2) throw new Error('Invalid GitHub repository');
  const [owner, name] = repositoryParts.map((part) => requireApiSegment(part, 'repository'));
  const number = requirePositiveInteger(numberValue, 'pull request number');
  if (!/^[0-9a-f]{40}$/.test(headSha)) throw new Error('Invalid pull request head SHA');
  if (!/^[0-9a-f]{40}$/.test(baseSha)) throw new Error('Invalid pull request base SHA');
  if (!/^(0|[1-9][0-9]*)$/.test(changedFilesValue)) throw new Error('Invalid changed-file count');
  if (!['true', 'false'].includes(draft)) throw new Error('Invalid pull request draft state');
  if (draft === 'true') {
    process.stdout.write('Draft PR: Codex merge evidence will be required when marked ready.\n');
    return;
  }

  const prefix = ['repos', owner, name];
  const [files, reviews, reviewComments, issueComments] = await Promise.all([
    api([...prefix, 'pulls', number, 'files'], token),
    api([...prefix, 'pulls', number, 'reviews'], token),
    api([...prefix, 'pulls', number, 'comments'], token),
    api([...prefix, 'issues', number, 'comments'], token),
  ]);
  const matchingRequests = issueComments.filter(
    (comment) =>
      String(comment.body ?? '')
        .replaceAll('\r\n', '\n')
        .trim() === reviewRequestBody(headSha, baseSha),
  );
  const reviewRequests = await Promise.all(
    matchingRequests.map(async (comment) => ({
      body: comment.body,
      updatedAt: comment.updated_at,
      reactions: await api(
        [
          ...prefix,
          'issues',
          'comments',
          requirePositiveInteger(comment.id, 'comment id'),
          'reactions',
        ],
        token,
      ),
    })),
  );
  const result = assessCodexGate({
    headSha,
    baseSha,
    changedFiles: Number(changedFilesValue),
    files,
    reviews,
    reviewComments,
    reviewRequests,
  });
  process.stdout.write(`${result.reason}\n`);
  if (!result.accepted) process.exitCode = 1;
}

if (process.argv.includes('--self-test')) {
  selfTest();
} else {
  await runLive();
}
