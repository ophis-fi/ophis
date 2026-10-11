// Shared by every deployed backend binary. Docker supplies the verified full
// commit; local builds are explicitly marked as development builds.
use std::{env, error::Error, path::PathBuf, process::Command};

fn main() -> Result<(), Box<dyn Error>> {
    println!("cargo:rerun-if-env-changed=OPHIS_GIT_SHA");
    println!("cargo:rerun-if-changed=../../build-version.rs");
    let revision = match env::var("OPHIS_GIT_SHA") {
        Ok(sha) => {
            if sha.len() != 40
                || !sha
                    .bytes()
                    .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
            {
                return Err("OPHIS_GIT_SHA must be a full lowercase 40-hex commit SHA".into());
            }
            sha
        }
        Err(env::VarError::NotPresent) => {
            let output = Command::new("git").args(["rev-parse", "HEAD"]).output()?;
            if !output.status.success() {
                // Local bind-mounted playgrounds have no .git. They must be
                // visibly unversioned, never confused with a release. Docker
                // release builds always set OPHIS_GIT_SHA (empty is rejected).
                "unversioned-dev".to_owned()
            } else {
                // Watch the worktree HEAD and its ref so switching/updating branches
                // cannot leave a cached build script reporting the previous commit.
                for name in [
                    "HEAD".to_owned(),
                    "packed-refs".to_owned(),
                    String::from_utf8(
                        Command::new("git")
                            .args(["symbolic-ref", "-q", "HEAD"])
                            .output()?
                            .stdout,
                    )?
                    .trim()
                    .to_owned(),
                ] {
                    if name.is_empty() {
                        continue;
                    }
                    let path = Command::new("git")
                        .args(["rev-parse", "--git-path", &name])
                        .output()?;
                    if !path.status.success() {
                        return Err("cannot locate Git revision metadata".into());
                    }
                    let path = PathBuf::from(String::from_utf8(path.stdout)?.trim());
                    println!("cargo:rerun-if-changed={}", path.display());
                }
                format!("{}-dev", String::from_utf8(output.stdout)?.trim())
            }
        }
        Err(error) => return Err(error.into()),
    };
    // Keep the existing log/API variable names, with the same immutable value.
    println!("cargo:rustc-env=VERGEN_GIT_SHA={revision}");
    println!("cargo:rustc-env=VERGEN_GIT_DESCRIBE={revision}");
    Ok(())
}
