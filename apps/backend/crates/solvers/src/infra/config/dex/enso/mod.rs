pub mod file;

pub struct Config {
    pub enso: crate::infra::dex::enso::Config,
    pub base: super::Config,
}
