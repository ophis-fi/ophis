use {
    anyhow::{Context, Result},
    vergen::EmitBuilder,
};

fn main() -> Result<()> {
    // Set environment variable VERGEN_GIT_DESCRIBE for use in the /version API
    // route.
    //
    // Our Docker build context is apps/backend, which has no .git directory, so
    // vergen's `git describe` cannot run and falls back to the literal sentinel
    // "VERGEN_IDEMPOTENT_OUTPUT" — which then leaks out of GET /api/v1/version.
    // Let the deploy inject the real version via OPHIS_GIT_DESCRIBE (set as a
    // Docker build-arg from `git describe` on the host); when it is present we
    // emit it directly and skip vergen's git probe entirely. For normal in-tree
    // builds (where .git exists and the env var is unset) we fall through to
    // vergen's git detection, preserving upstream behaviour.
    println!("cargo:rerun-if-env-changed=OPHIS_GIT_DESCRIBE");
    if let Ok(describe) = std::env::var("OPHIS_GIT_DESCRIBE") {
        let describe = describe.trim();
        if !describe.is_empty() {
            println!("cargo:rustc-env=VERGEN_GIT_DESCRIBE={describe}");
            return Ok(());
        }
    }
    EmitBuilder::builder()
        .git_describe(true, true, None)
        .emit()
        .context("emit")
}
