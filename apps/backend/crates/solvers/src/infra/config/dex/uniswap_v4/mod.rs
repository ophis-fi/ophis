pub mod file;

pub struct Config {
    pub uniswap_v4: crate::infra::dex::uniswap_v4::Config,
    pub base: super::Config,
}
