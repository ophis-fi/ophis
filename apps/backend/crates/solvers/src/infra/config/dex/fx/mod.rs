pub mod file;

pub struct Config {
    pub fx: crate::infra::dex::fx::Config,
    pub base: super::Config,
}
