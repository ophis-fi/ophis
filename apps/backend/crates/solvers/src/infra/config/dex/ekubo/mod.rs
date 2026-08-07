pub mod file;
pub struct Config {
    pub ekubo: crate::infra::dex::ekubo::Config,
    pub base: super::Config,
}
