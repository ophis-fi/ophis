pub mod file;

pub struct Config {
    pub dodo: crate::infra::dex::dodo::Config,
    pub base: super::Config,
}
