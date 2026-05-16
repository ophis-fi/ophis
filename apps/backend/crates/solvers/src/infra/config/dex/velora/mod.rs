pub mod file;

pub struct Config {
    pub velora: crate::infra::dex::velora::Config,
    pub base: super::Config,
}
