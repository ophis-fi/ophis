pub mod file;

pub struct Config {
    pub pons: crate::infra::dex::pons::Config,
    pub base: super::Config,
}
