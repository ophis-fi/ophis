# Release dependency review — 2026-11-01

The rebate recovery release encountered advisories already present on main.
Upgrade `decode-uri-component` to 0.5.1, `follow-redirects` to 1.16.2, and the
documentation workspace's Joi to 17.13.9. Retain the decoder's CommonJS patch.
Regression checks cover legacy query-string 5/7, malformed decoding with many
distinct runs, and cross-realm sensitive-header stripping across redirects.
Joi's valid/invalid multi-email and 100 KB whitespace inputs passed a smoke test.

Upstream advisories: [decoder](https://github.com/advisories/GHSA-qr28-fpjm-wq7f),
[redirects](https://github.com/advisories/GHSA-mrwp-f3q8-3g9p),
[Joi](https://github.com/advisories/GHSA-4528-x5fx-h6hg).

[GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249) declares
all minimatch versions below 11.0.1 affected, but describes amplification in
`firstPhasePreProcess()` and `secondPhasePreProcess()` with optimization level 2
in 10.2.6. Inspection of the installed 3.1.5 and 5.1.9 packages confirms that
neither implements these methods. The legacy recursive-readdir and Mocha
consumers retain the callable minimatch API that 11 would break.

Record only these two exact version/advisory fingerprints in the contracts
baseline. `test:dependencies` checks the installed consumer versions, absence
of both preprocessing methods, and that a repeated `**/../` pattern creates
one alternative even with optimization level 2. This is a source-based
non-applicability assessment, not a claim that arbitrary glob input is safe.
Re-review by 2026-11-15; remove the fingerprints and reduce the moderate ceiling
when the advisory range is corrected or the legacy toolchain is replaced.
