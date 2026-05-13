pub mod file;

pub struct Config {
    pub kyberswap: crate::infra::dex::kyberswap::Config,
    pub base: super::Config,
}
