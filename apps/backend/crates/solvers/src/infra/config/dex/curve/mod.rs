pub mod file;

pub struct Config {
    pub curve: crate::infra::dex::curve::Config,
    pub base: super::Config,
}
