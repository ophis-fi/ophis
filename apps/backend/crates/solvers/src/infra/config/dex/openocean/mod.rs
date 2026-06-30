pub mod file;

pub struct Config {
    pub openocean: crate::infra::dex::openocean::Config,
    pub base: super::Config,
}
