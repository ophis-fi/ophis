pub mod file;

pub struct Config {
    pub odos: crate::infra::dex::odos::Config,
    pub base: super::Config,
}
