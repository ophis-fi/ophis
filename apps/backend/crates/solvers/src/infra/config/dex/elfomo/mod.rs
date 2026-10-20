pub mod file;

pub struct Config {
    pub base: crate::infra::config::dex::Config,
    pub elfomo: crate::infra::dex::elfomo::Config,
}
