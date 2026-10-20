pub mod file;
pub struct Config {
    pub base: super::Config,
    pub metric: crate::infra::dex::metric::Config,
}
