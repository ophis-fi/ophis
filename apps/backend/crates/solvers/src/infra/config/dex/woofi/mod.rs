pub mod file;

pub struct Config {
    pub woofi: crate::infra::dex::woofi::Config,
    pub base: super::Config,
}
