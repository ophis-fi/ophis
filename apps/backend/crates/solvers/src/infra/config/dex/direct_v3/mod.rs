pub mod file;
pub struct Config {
    pub base: super::Config,
    pub direct_v3: crate::infra::dex::direct_v3::Config,
}
