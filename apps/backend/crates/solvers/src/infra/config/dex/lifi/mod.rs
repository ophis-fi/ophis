pub mod file;

pub struct Config {
    pub lifi: crate::infra::dex::lifi::Config,
    pub base: super::Config,
}
