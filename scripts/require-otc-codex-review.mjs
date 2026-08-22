#!/usr/bin/env node

/**
 * Fail-closed merge gate for Milestone C money-path changes.
 *
 * Codex records findings as line comments and a clean result as an
 * authenticated issue comment naming the reviewed commit. Evidence must post
 * after the newest explicit request naming the full head and base SHAs, and no
 * Codex line finding may target that head. Pushes and base edits therefore
 * invalidate earlier evidence. Mutable review approvals are never evidence.
 */

const CODEX_LOGIN = 'chatgpt-codex-connector[bot]';
const ACTIONS_LOGIN = 'github-actions[bot]';
const GITHUB_API_ORIGIN = 'https://api.github.com';
const TRUSTED_REQUEST_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
const SCOPED_PATHS = [
  '.github/',
  'apps/frontend/',
  'contracts/foundry.toml',
  'contracts/test/otc-fork/',
  'functions/',
  'OPHIS_OTC_DIFFERENTIAL_REVIEW_2026-08-19.md',
  'OPHIS_OTC_MILESTONE_C_APPSEC_REVIEW_2026-08-21.md',
  'OPHIS_OTC_MILESTONE_C_DIFFERENTIAL_REVIEW_2026-08-21.md',
  'docs/development/plans/2026-08-18-ophis-otc.md',
  'docs/development/specs/2026-08-18-ophis-otc-plan.md',
  'docs/superpowers/plans/2026-08-19-ophis-otc-milestone-ab.md',
  'docs/superpowers/plans/2026-08-21-ophis-otc-milestone-c.md',
  'scripts/',
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

function isBoundInvalidation(comment, headSha, baseSha) {
  if (comment?.user?.login !== ACTIONS_LOGIN) return false;
  return new RegExp(
    `^OTC Codex gate invalidated\\.\\n\\nHead: ${headSha}\\nBase: ${baseSha}\\nSource comment: [1-9][0-9]*$`,
  ).test(
    String(comment.body ?? '')
      .replaceAll('\r\n', '\n')
      .trim(),
  );
}

function cleanCommentHeadPrefix(comment) {
  const match = String(comment?.body ?? '').match(
    /^Codex Review: Didn't find any major issues\. :\+1:\s*\n+\*\*Reviewed commit:\*\* `([0-9a-f]{10}|[0-9a-f]{40})`(?:\n|$)/,
  );
  return match?.[1];
}

function hasBoundCleanEvidence(request, headSha, baseSha) {
  if (
    String(request?.body ?? '')
      .replaceAll('\r\n', '\n')
      .trim() !== reviewRequestBody(headSha, baseSha)
  ) {
    return false;
  }
  const updatedAt = Date.parse(request.updatedAt);
  if (!Number.isFinite(updatedAt)) return false;
  const freshCleanComment = codexItems(request.cleanComments ?? []).some((comment) => {
    const displayedSha = cleanCommentHeadPrefix(comment);
    const createdAt = Date.parse(comment.created_at);
    return (
      displayedSha &&
      headSha.startsWith(displayedSha) &&
      comment.resolved_commit_id === headSha &&
      Number.isFinite(createdAt) &&
      createdAt > updatedAt
    );
  });
  return freshCleanComment;
}

function newestReviewRequest(requests) {
  return requests.reduce((newest, request) => {
    if (!newest) return request;
    const requestTime = Date.parse(request.updatedAt);
    const newestTime = Date.parse(newest.updatedAt);
    if (requestTime !== newestTime) return requestTime > newestTime ? request : newest;
    return Number(request.id ?? 0) > Number(newest.id ?? 0) ? request : newest;
  }, undefined);
}

export function assessCodexGate({
  headSha,
  baseSha,
  changedFiles,
  files,
  reviewComments,
  reviewRequests,
  invalidatedAt,
  invalidationId,
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

  const latestRequest = newestReviewRequest(reviewRequests);
  const requestTime = Date.parse(latestRequest?.updatedAt);
  const invalidationTime = Date.parse(invalidatedAt);
  const requestId = Number(latestRequest?.id);
  const markerId = Number(invalidationId);
  const requestFollowsInvalidation =
    !Number.isFinite(invalidationTime) ||
    (Number.isFinite(requestTime) &&
      Number.isSafeInteger(requestId) &&
      requestId > 0 &&
      Number.isSafeInteger(markerId) &&
      markerId > 0 &&
      (requestTime > invalidationTime ||
        (requestTime === invalidationTime && requestId > markerId)));
  const cleanEvidence = latestRequest
    ? requestFollowsInvalidation && hasBoundCleanEvidence(latestRequest, headSha, baseSha)
    : false;

  if (cleanEvidence) {
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
          cleanComments: [
            {
              user: { login: CODEX_LOGIN },
              body: `Codex Review: Didn't find any major issues. :+1:\n\n**Reviewed commit:** \`${base.headSha.slice(0, 10)}\`\n`,
              created_at: '2026-08-20T12:01:00Z',
              resolved_commit_id: base.headSha,
            },
          ],
        },
      ],
    }).accepted === false,
    'head findings must override clean evidence',
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
          cleanComments: [
            {
              user: { login: CODEX_LOGIN },
              body: `Codex Review: Didn't find any major issues. :+1:\n\n**Reviewed commit:** \`${base.headSha.slice(0, 10)}\`\n`,
              created_at: '2026-08-20T12:01:00Z',
              resolved_commit_id: base.headSha,
            },
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
    }).accepted === false,
    'mutable reaction-only evidence must fail closed',
  );
  assert(
    !assessCodexGate({
      ...base,
      reviews: [{ user: { login: CODEX_LOGIN }, state: 'APPROVED', commit_id: base.headSha }],
      reviewRequests: [
        {
          body: reviewRequestBody(base.headSha, base.baseSha),
          updatedAt: '2026-08-20T12:00:00Z',
          cleanComments: [],
        },
      ],
    }).accepted,
    'mutable review approvals must not count as clean evidence',
  );
  const cleanComment = {
    user: { login: CODEX_LOGIN },
    body: `Codex Review: Didn't find any major issues. :+1:\n\n**Reviewed commit:** \`${base.headSha.slice(0, 10)}\`\n`,
    created_at: '2026-08-20T12:01:00Z',
    resolved_commit_id: base.headSha,
  };
  assert(
    assessCodexGate({
      ...base,
      reviewRequests: [
        {
          body: reviewRequestBody(base.headSha, base.baseSha),
          updatedAt: '2026-08-20T12:00:00Z',
          cleanComments: [cleanComment],
        },
      ],
    }).accepted,
    'an authenticated clean comment naming the current head must pass',
  );
  assert(
    !assessCodexGate({
      ...base,
      reviewRequests: [
        {
          body: reviewRequestBody(base.headSha, base.baseSha),
          updatedAt: '2026-08-20T12:00:00Z',
          cleanComments: [{ ...cleanComment, resolved_commit_id: 'b'.repeat(40) }],
        },
      ],
    }).accepted,
    'a clean comment whose short SHA resolves to another commit must fail',
  );
  assert(
    !assessCodexGate({
      ...base,
      reviewRequests: [
        {
          body: reviewRequestBody(base.headSha, base.baseSha),
          updatedAt: '2026-08-20T12:00:00Z',
          cleanComments: [{ ...cleanComment, user: { login: 'contributor' } }],
        },
      ],
    }).accepted,
    'a contributor-authored clean comment must fail',
  );
  assert(
    !assessCodexGate({
      ...base,
      reviewRequests: [
        {
          body: reviewRequestBody(base.headSha, base.baseSha),
          updatedAt: '2026-08-20T12:00:00Z',
          cleanComments: [
            {
              ...cleanComment,
              body: cleanComment.body.replace(base.headSha.slice(0, 10), 'bbbbbbbbbb'),
            },
          ],
        },
      ],
    }).accepted,
    'a clean comment naming another head must fail',
  );
  assert(
    !assessCodexGate({
      ...base,
      reviewRequests: [
        {
          body: reviewRequestBody(base.headSha, base.baseSha),
          updatedAt: '2026-08-20T12:01:00Z',
          cleanComments: [cleanComment],
        },
      ],
    }).accepted,
    'a same-second clean comment must fail as ambiguous',
  );
  assert(
    !assessCodexGate({
      ...base,
      invalidatedAt: '2026-08-20T12:02:00Z',
      invalidationId: 2,
      reviewRequests: [
        {
          id: 1,
          body: reviewRequestBody(base.headSha, base.baseSha),
          updatedAt: '2026-08-20T12:00:00Z',
          cleanComments: [cleanComment],
        },
      ],
    }).accepted,
    'deleting accepted evidence must require a newer exact request',
  );
  assert(
    assessCodexGate({
      ...base,
      invalidatedAt: '2026-08-20T12:00:00Z',
      invalidationId: 1,
      reviewRequests: [
        {
          id: 2,
          body: reviewRequestBody(base.headSha, base.baseSha),
          updatedAt: '2026-08-20T12:00:00Z',
          cleanComments: [cleanComment],
        },
      ],
    }).accepted,
    'a same-second request with a larger ID must supersede an invalidation marker',
  );
  assert(
    !assessCodexGate({
      ...base,
      invalidatedAt: '2026-08-20T12:00:00Z',
      invalidationId: 3,
      reviewRequests: [
        {
          id: 2,
          body: reviewRequestBody(base.headSha, base.baseSha),
          updatedAt: '2026-08-20T12:00:00Z',
          cleanComments: [cleanComment],
        },
      ],
    }).accepted,
    'a same-second invalidation marker with a larger ID must remain blocking',
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
          id: 1,
          body: reviewRequestBody(base.headSha, base.baseSha),
          updatedAt: '2026-08-20T12:00:00Z',
          cleanComments: [cleanComment],
        },
        {
          id: 2,
          body: reviewRequestBody(base.headSha, base.baseSha),
          updatedAt: '2026-08-20T12:02:00Z',
          cleanComments: [],
        },
      ],
    }).accepted,
    'an older approved request must not override a newer request',
  );
  assert(
    !assessCodexGate({
      ...base,
      reviewRequests: [
        {
          body: reviewRequestBody('b'.repeat(40), base.baseSha),
          updatedAt: '2026-08-20T12:00:00Z',
          cleanComments: [cleanComment],
        },
      ],
    }).accepted,
    'clean evidence requested for an earlier head must fail after a push',
  );
  assert(
    !assessCodexGate({
      ...base,
      reviewRequests: [
        {
          body: reviewRequestBody(base.headSha, 'd'.repeat(40)),
          updatedAt: '2026-08-20T12:00:00Z',
          cleanComments: [cleanComment],
        },
      ],
    }).accepted,
    'clean evidence requested for an earlier base must fail after a base edit',
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
    '.github/workflows/cloudflare-deploy.yml',
    '.github/workflows/future-frontend-deploy.yml',
    'apps/frontend/apps/cowswap-frontend-e2e/package.json',
    'apps/frontend/apps/cowswap-frontend/package.json',
    'apps/frontend/apps/cowswap-frontend/index.html',
    'apps/frontend/apps/cowswap-frontend/.env',
    'apps/frontend/apps/cowswap-frontend/.env.barn',
    'apps/frontend/apps/cowswap-frontend/.env.barn.local',
    'apps/frontend/apps/cowswap-frontend/.env.dev',
    'apps/frontend/apps/cowswap-frontend/.env.dev.local',
    'apps/frontend/apps/cowswap-frontend/.env.local',
    'apps/frontend/apps/cowswap-frontend/.env.production',
    'apps/frontend/apps/cowswap-frontend/.env.production.local',
    'apps/frontend/apps/cowswap-frontend/.env.staging',
    'apps/frontend/apps/cowswap-frontend/.env.staging.local',
    'apps/frontend/apps/cowswap-frontend/patches/@ethersproject+providers+5.7.2.patch',
    'apps/frontend/apps/cowswap-frontend/public/emergency.js',
    'apps/frontend/apps/cowswap-frontend/public/seo-fallback.js',
    'apps/frontend/apps/cowswap-frontend/src/main.tsx',
    'apps/frontend/apps/cowswap-frontend/src/service-worker.ts',
    'apps/frontend/apps/cowswap-frontend/src/serviceWorker/index.ts',
    'apps/frontend/apps/cowswap-frontend/src/serviceWorkerRegistration.ts',
    'apps/frontend/apps/cowswap-frontend/src/ophis/ds/index.ts',
    'apps/frontend/apps/cowswap-frontend/tsconfig.app.json',
    'apps/frontend/apps/cowswap-frontend/tsconfig.json',
    'apps/frontend/apps/cowswap-frontend/vite.config.mts',
    'apps/frontend/apps/cowswap-frontend/public/_headers',
    'apps/frontend/lingui.config.ts',
    'apps/frontend/apps/cowswap-frontend/src/modules/application/containers/App/RoutesApp.tsx',
    'apps/frontend/apps/cowswap-frontend/src/common/constants/routes.ts',
    'apps/frontend/libs/common-const/package.json',
    'apps/frontend/libs/common-const/src/index.ts',
    'apps/frontend/libs/common-hooks/package.json',
    'apps/frontend/libs/common-hooks/src/index.ts',
    'apps/frontend/libs/common-utils/package.json',
    'apps/frontend/libs/common-utils/src/environments.ts',
    'apps/frontend/libs/common-utils/src/index.ts',
    'apps/frontend/libs/tokens/package.json',
    'apps/frontend/libs/tokens/src/index.ts',
    'apps/frontend/libs/wallet-provider/src/hooks/useWalletProvider.ts',
    'apps/frontend/package.json',
    'apps/frontend/pnpm-lock.yaml',
    'apps/frontend/pnpm-workspace.yaml',
    'apps/frontend/tools/getReactProcessEnv.ts',
    'functions/_middleware.ts',
    'scripts/otc-mainnet-canary.mjs',
    'scripts/require-otc-codex-review.mjs',
    'OPHIS_OTC_DIFFERENTIAL_REVIEW_2026-08-19.md',
    'docs/development/plans/2026-08-18-ophis-otc.md',
    'docs/development/specs/2026-08-18-ophis-otc-plan.md',
    'docs/superpowers/plans/2026-08-19-ophis-otc-milestone-ab.md',
  ]) {
    assert(
      !assessCodexGate({ ...base, files: [{ filename }] }).accepted,
      `${filename} changes must require Codex evidence`,
    );
  }
  assertThrows(
    () =>
      nextPageUrl(
        '<https://example.invalid/repos/ophis-fi/ophis?page=2>; rel="next"',
        '/repos/ophis-fi/ophis/',
        '123',
      ),
    'pagination must stay on the GitHub API origin',
  );
  assert(
    nextPageUrl(
      '<https://api.github.com/repositories/123/pulls/1227/files?page=2>; rel="next"',
      '/repos/ophis-fi/ophis/',
      '123',
    ).pathname === '/repositories/123/pulls/1227/files',
    'canonical repository-id pagination must be accepted',
  );
  assertThrows(
    () =>
      nextPageUrl(
        '<https://api.github.com/repositories/124/pulls/1227/files?page=2>; rel="next"',
        '/repos/ophis-fi/ophis/',
        '123',
      ),
    'canonical pagination for another repository must fail',
  );
  assertThrows(
    () => requireApiSegment('ophis-fi/other', 'repository'),
    'repository path segments must reject separators',
  );
  assertThrows(
    () => requirePositiveInteger('../1227', 'pull request number'),
    'numeric API path segments must reject traversal',
  );
  assert(
    currentPullContext({
      head: { sha: base.headSha },
      base: { sha: base.baseSha, ref: 'main', repo: { default_branch: 'main' } },
      changed_files: base.changedFiles,
      draft: false,
    }).baseSha === base.baseSha,
    'current PR state must supply the reviewed base',
  );
  assertThrows(
    () =>
      currentPullContext({
        head: { sha: base.headSha },
        base: { sha: base.baseSha, ref: 'main', repo: { default_branch: 'main' } },
        changed_files: base.changedFiles,
        draft: 'false',
      }),
    'mutable PR state must be validated before use',
  );
  assert(
    isTrustedReviewRequester({ author_association: 'MEMBER' }),
    'repository members must be allowed to request a superseding review',
  );
  assert(
    !isTrustedReviewRequester({ author_association: 'CONTRIBUTOR' }),
    'untrusted commenters must not supersede accepted evidence',
  );
  assert(
    baseIsIncludedInHead(
      { status: 'ahead', merge_base_commit: { sha: base.baseSha } },
      base.baseSha,
    ),
    'a reviewed head containing the exact base must pass topology validation',
  );
  assert(
    !baseIsIncludedInHead(
      { status: 'diverged', merge_base_commit: { sha: 'd'.repeat(40) } },
      base.baseSha,
    ),
    'a head that omits the current base must fail topology validation',
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

function currentPullContext(pull) {
  const headSha = String(pull?.head?.sha ?? '');
  const baseSha = String(pull?.base?.sha ?? '');
  const baseRef = String(pull?.base?.ref ?? '');
  const defaultBranch = String(pull?.base?.repo?.default_branch ?? '');
  const changedFiles = pull?.changed_files;
  const draft = pull?.draft;
  if (!/^[0-9a-f]{40}$/.test(headSha)) throw new Error('Invalid current pull request head SHA');
  if (!/^[0-9a-f]{40}$/.test(baseSha)) throw new Error('Invalid current pull request base SHA');
  if (!Number.isSafeInteger(changedFiles) || changedFiles < 0)
    throw new Error('Invalid current changed-file count');
  if (typeof draft !== 'boolean') throw new Error('Invalid current pull request draft state');
  if (!baseRef || !defaultBranch) throw new Error('Invalid current pull request base branch');
  return { headSha, baseSha, baseRef, defaultBranch, changedFiles, draft };
}

function isTrustedReviewRequester(comment) {
  return TRUSTED_REQUEST_ASSOCIATIONS.has(String(comment?.author_association ?? ''));
}

function baseIsIncludedInHead(comparison, baseSha) {
  return (
    ['ahead', 'identical'].includes(comparison?.status) &&
    comparison?.merge_base_commit?.sha === baseSha
  );
}

function githubApiUrl(segments) {
  const url = new URL(GITHUB_API_ORIGIN);
  url.pathname = segments.map((segment) => encodeURIComponent(segment)).join('/');
  url.searchParams.set('per_page', '100');
  return url;
}

function nextPageUrl(link, repositoryPath, repositoryId) {
  const value = link
    .split(',')
    .map((part) => part.trim().match(/^<([^>]+)>; rel="next"$/)?.[1])
    .find(Boolean);
  if (!value) return undefined;
  const url = new URL(value);
  const canonicalRepositoryPath = `/repositories/${repositoryId}/`;
  if (
    url.origin !== GITHUB_API_ORIGIN ||
    url.username ||
    url.password ||
    (!url.pathname.startsWith(repositoryPath) && !url.pathname.startsWith(canonicalRepositoryPath))
  ) {
    throw new Error('Refusing untrusted GitHub pagination URL');
  }
  return url;
}

async function api(segments, token, repositoryId) {
  const items = [];
  const repositoryPath = `/${segments
    .slice(0, 3)
    .map((segment) => encodeURIComponent(segment))
    .join('/')}/`;
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
    url = nextPageUrl(response.headers.get('link') ?? '', repositoryPath, repositoryId);
  }
  return items;
}

async function resolveCleanCommentHeads(issueComments, headSha, prefix, token, repositoryId) {
  return Promise.all(
    issueComments.map(async (comment) => {
      if (comment?.user?.login !== CODEX_LOGIN) return comment;
      const shortSha = cleanCommentHeadPrefix(comment);
      if (!shortSha || !headSha.startsWith(shortSha)) return comment;
      const commit =
        shortSha.length === 40
          ? { sha: shortSha }
          : await api([...prefix, 'commits', shortSha], token, repositoryId);
      const resolvedSha = String(commit?.sha ?? '');
      if (!/^[0-9a-f]{40}$/.test(resolvedSha)) {
        throw new Error('Invalid commit resolved from Codex clean evidence');
      }
      return { ...comment, resolved_commit_id: resolvedSha };
    }),
  );
}

async function runLive() {
  const repository = process.env.GITHUB_REPOSITORY ?? '';
  const numberValue = process.env.PULL_REQUEST_NUMBER ?? '';
  const token = process.env.GITHUB_TOKEN ?? '';
  if (!repository || !numberValue || !token)
    throw new Error('Missing GitHub Actions review-gate context');
  const repositoryParts = repository.split('/');
  if (repositoryParts.length !== 2) throw new Error('Invalid GitHub repository');
  const [owner, name] = repositoryParts.map((part) => requireApiSegment(part, 'repository'));
  const number = requirePositiveInteger(numberValue, 'pull request number');
  const prefix = ['repos', owner, name];
  const currentPull = await api([...prefix, 'pulls', number], token);
  const repositoryId = requirePositiveInteger(currentPull?.base?.repo?.id, 'repository id');
  const { headSha, baseSha, baseRef, defaultBranch, changedFiles, draft } =
    currentPullContext(currentPull);
  if (draft) {
    process.stdout.write('Draft PR: Codex merge evidence will be required when marked ready.\n');
    return;
  }
  if (baseRef !== defaultBranch) {
    throw new Error('Codex merge gate only accepts pull requests targeting the default branch');
  }
  const comparison = await api(
    [...prefix, 'compare', `${baseSha}...${headSha}`],
    token,
    repositoryId,
  );
  if (!baseIsIncludedInHead(comparison, baseSha)) {
    throw new Error('Current base is not included in the pull request head; update the branch');
  }

  const [files] = await Promise.all([
    api([...prefix, 'pulls', number, 'files'], token, repositoryId),
    api([...prefix, 'pulls', number, 'comments'], token, repositoryId),
    api([...prefix, 'issues', number, 'comments'], token, repositoryId),
  ]);
  const confirmedContext = currentPullContext(
    await api([...prefix, 'pulls', number], token, repositoryId),
  );
  if (
    confirmedContext.headSha !== headSha ||
    confirmedContext.baseSha !== baseSha ||
    confirmedContext.baseRef !== baseRef ||
    confirmedContext.defaultBranch !== defaultBranch ||
    confirmedContext.changedFiles !== changedFiles ||
    confirmedContext.draft !== draft
  ) {
    throw new Error('Pull request state changed during gate evaluation; rerun against fresh state');
  }

  // Evidence can change without changing PR metadata. Fetch the mutable
  // collections again after the first snapshot and assess only this fresh copy.
  const [reviewComments, rawIssueComments] = await Promise.all([
    api([...prefix, 'pulls', number, 'comments'], token, repositoryId),
    api([...prefix, 'issues', number, 'comments'], token, repositoryId),
  ]);
  const issueComments = await resolveCleanCommentHeads(
    rawIssueComments,
    headSha,
    prefix,
    token,
    repositoryId,
  );
  const latestInvalidation = issueComments
    .filter((comment) => isBoundInvalidation(comment, headSha, baseSha))
    .sort((left, right) => {
      const timeOrder = String(left.created_at).localeCompare(String(right.created_at));
      return timeOrder || Number(left.id) - Number(right.id);
    })
    .at(-1);
  const matchingRequests = issueComments
    .filter(
      (comment) =>
        isTrustedReviewRequester(comment) &&
        /^@codex review(?:\s|$)/.test(
          String(comment.body ?? '')
            .replaceAll('\r\n', '\n')
            .trim(),
        ),
    )
    .sort((left, right) => {
      const timeOrder = String(right.updated_at).localeCompare(String(left.updated_at));
      return timeOrder || Number(right.id) - Number(left.id);
    })
    .slice(0, 1);
  const reviewRequests = matchingRequests.map((comment) => ({
    id: comment.id,
    body: comment.body,
    updatedAt: comment.updated_at,
    cleanComments: issueComments,
  }));
  const finalContext = currentPullContext(
    await api([...prefix, 'pulls', number], token, repositoryId),
  );
  if (
    finalContext.headSha !== headSha ||
    finalContext.baseSha !== baseSha ||
    finalContext.baseRef !== baseRef ||
    finalContext.defaultBranch !== defaultBranch ||
    finalContext.changedFiles !== changedFiles ||
    finalContext.draft !== draft
  ) {
    throw new Error('Pull request state changed during gate evaluation; rerun against fresh state');
  }
  const result = assessCodexGate({
    headSha,
    baseSha,
    changedFiles,
    files,
    reviewComments,
    reviewRequests,
    invalidatedAt: latestInvalidation?.created_at,
    invalidationId: latestInvalidation?.id,
  });
  process.stdout.write(`${result.reason}\n`);
  if (!result.accepted) process.exitCode = 1;
}

if (process.argv.includes('--self-test')) {
  selfTest();
} else {
  await runLive();
}
