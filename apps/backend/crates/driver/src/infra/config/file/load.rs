use {
    crate::{
        domain::competition::risk_detector,
        infra::{
            self,
            blockchain,
            config::file,
            liquidity,
            mempool,
            notify,
            solver::{self, Account, BadOrderDetection, SolutionMerging},
        },
    },
    alloy::signers::{aws::AwsSigner, local::PrivateKeySigner},
    chain::Chain,
    eth_domain_types as eth,
    futures::future::join_all,
    number::conversions::big_decimal_to_big_rational,
    std::path::Path,
    tokio::fs,
};

/// Load the driver configuration from a TOML file for the specifed Ethereum
/// network.
///
/// # Panics
///
/// This method panics if the config is invalid or on I/O errors.
pub async fn load(chain: Chain, path: &Path) -> infra::Config {
    let data = fs::read_to_string(path)
        .await
        .unwrap_or_else(|e| panic!("I/O error while reading {path:?}: {e:?}"));

    let config: file::Config = toml::de::from_str(&data).unwrap_or_else(|err| {
        if std::env::var("TOML_TRACE_ERROR").is_ok_and(|v| v == "1") {
            panic!("failed to parse TOML config at {path:?}: {err:#?}")
        } else {
            panic!(
                "failed to parse TOML config at: {path:?}. Set TOML_TRACE_ERROR=1 to print \
                 parsing error but this may leak secrets."
            )
        }
    });

    assert_eq!(
        config
            .chain_id
            .map(|id| Chain::try_from(id).expect("unsupported chain ID"))
            .unwrap_or(chain),
        chain,
        "The configured chain ID does not match the connected Ethereum node"
    );

    // Phase 2 audit C4 sub-pieces + L1 + sharp-edges PR-228 MED
    // (2026-05-22): config-time range validation on six previously-
    // unchecked numeric fields:
    //   - tx_gas_limit, haircut_bps (C4)
    //   - solving_share_of_deadline (L1)
    //   - additional_tip_percentage, reward_percentile,
    //     metrics_strategy_failure_ratio (sharp-edges MED, same class)
    // Each validator returns a structured error message naming the
    // field + bad value + accepted range. Aggregated under
    // `validate_config_for_load`.
    if let Err(e) = super::validate_config_for_load(&config) {
        panic!("config: {e}");
    }
    infra::Config {
        solvers: join_all(config.solvers.into_iter().map(|solver_config| async move {
            let account = load_account(solver_config.account, config.chain_id).await;
            solver::Config {
                endpoint: solver_config.endpoint,
                name: solver::Name::try_new(solver_config.name).unwrap_or_else(|err| {
                    // Panic message includes the offending name via Display
                    // impl (mod.rs:InvalidName), so operators don't have to
                    // grep the TOML to find it.
                    panic!("invalid solver name in config: {err}")
                }),
                slippage: solver::Slippage {
                    relative: big_decimal_to_big_rational(&solver_config.slippage.relative),
                    absolute: solver_config.slippage.absolute.map(eth::Ether),
                },
                liquidity: if solver_config.skip_liquidity {
                    solver::Liquidity::Skip
                } else {
                    solver::Liquidity::Fetch
                },
                account,
                timeouts: solver::Timeouts {
                    http_delay: chrono::Duration::from_std(solver_config.timeouts.http_time_buffer)
                        .unwrap(),
                    solving_share_of_deadline: solver_config
                        .timeouts
                        .solving_share_of_deadline
                        .try_into()
                        .unwrap(),
                },
                request_headers: solver_config.request_headers,
                fee_handler: solver_config.fee_handler,
                quote_using_limit_orders: solver_config.quote_using_limit_orders,
                merge_solutions: match solver_config.merge_solutions {
                    true => SolutionMerging::Allowed {
                        max_orders_per_merged_solution: solver_config
                            .max_orders_per_merged_solution,
                    },
                    false => SolutionMerging::Forbidden,
                },
                s3: solver_config.s3.map(Into::into),
                solver_native_token: solver_config.manage_native_token.to_domain(),
                quote_tx_origin: solver_config.quote_tx_origin,
                response_size_limit_max_bytes: solver_config.response_size_limit_max_bytes,
                bad_order_detection: BadOrderDetection {
                    tokens_supported: solver_config
                        .bad_order_detection
                        .token_supported
                        .iter()
                        .map(|(token, supported)| {
                            (
                                eth::TokenAddress::from(*token),
                                match supported {
                                    true => risk_detector::Quality::Supported,
                                    false => risk_detector::Quality::Unsupported,
                                },
                            )
                        })
                        .collect(),
                    enable_simulation_strategy: solver_config
                        .bad_order_detection
                        .enable_simulation_strategy,
                    enable_metrics_strategy: solver_config
                        .bad_order_detection
                        .enable_metrics_strategy,
                    metrics_strategy_failure_ratio: solver_config
                        .bad_order_detection
                        .metrics_strategy_failure_ratio,
                    metrics_strategy_required_measurements: solver_config
                        .bad_order_detection
                        .metrics_strategy_required_measurements,
                    metrics_strategy_log_only: solver_config
                        .bad_order_detection
                        .metrics_strategy_log_only,
                    metrics_strategy_order_freeze_time: solver_config
                        .bad_order_detection
                        .metrics_strategy_freeze_time,
                    metrics_strategy_cache_gc_interval: solver_config
                        .bad_order_detection
                        .metrics_strategy_gc_interval,
                    metrics_strategy_cache_max_age: solver_config
                        .bad_order_detection
                        .metrics_strategy_gc_max_age,
                },
                settle_queue_size: solver_config.settle_queue_size,
                flashloans_enabled: config.flashloans_enabled,
                fetch_liquidity_at_block: match config.liquidity.fetch_at_block {
                    file::AtBlock::Latest => liquidity::AtBlock::Latest,
                    file::AtBlock::Finalized => liquidity::AtBlock::Finalized,
                },
                haircut_bps: solver_config.haircut_bps,
                submission_accounts: join_all(
                    solver_config
                        .submission_accounts
                        .into_iter()
                        .map(|acc| load_account(acc, config.chain_id)),
                )
                .await,
                forwarder_contract: solver_config.forwarder_contract,
                max_solutions_to_propose: solver_config.max_solutions_to_propose,
            }
        }))
        .await,
        liquidity: liquidity::Config {
            base_tokens: config
                .liquidity
                .base_tokens
                .iter()
                .copied()
                .map(eth::TokenAddress::from)
                .collect(),
            uniswap_v2: config
                .liquidity
                .uniswap_v2
                .iter()
                .cloned()
                .map(|config| match config {
                    file::UniswapV2Config::Preset { preset } => match preset {
                        file::UniswapV2Preset::UniswapV2 => {
                            liquidity::config::UniswapV2::uniswap_v2(chain)
                        }
                        file::UniswapV2Preset::SushiSwap => {
                            liquidity::config::UniswapV2::sushi_swap(chain)
                        }
                        file::UniswapV2Preset::Honeyswap => {
                            liquidity::config::UniswapV2::honeyswap(chain)
                        }
                        file::UniswapV2Preset::Baoswap => {
                            liquidity::config::UniswapV2::baoswap(chain)
                        }
                        file::UniswapV2Preset::PancakeSwap => {
                            liquidity::config::UniswapV2::pancake_swap(chain)
                        }
                        file::UniswapV2Preset::TestnetUniswapV2 => {
                            liquidity::config::UniswapV2::testnet_uniswapv2(chain)
                        }
                    }
                    .expect("no Uniswap V2 preset for current network"),
                    file::UniswapV2Config::Manual {
                        router,
                        pool_code,
                        missing_pool_cache_time,
                    } => liquidity::config::UniswapV2 {
                        router: router.into(),
                        pool_code: pool_code.into(),
                        missing_pool_cache_time,
                    },
                })
                .collect(),
            swapr: config
                .liquidity
                .swapr
                .iter()
                .cloned()
                .map(|config| match config {
                    file::SwaprConfig::Preset { preset } => match preset {
                        file::SwaprPreset::Swapr => liquidity::config::Swapr::swapr(chain),
                    }
                    .expect("no Swapr preset for current network"),
                    file::SwaprConfig::Manual {
                        router,
                        pool_code,
                        missing_pool_cache_time,
                    } => liquidity::config::Swapr {
                        router: router.into(),
                        pool_code: pool_code.into(),
                        missing_pool_cache_time,
                    },
                })
                .collect(),
            uniswap_v3: config
                .liquidity
                .uniswap_v3
                .iter()
                .cloned()
                .map(|config| match config {
                    file::UniswapV3Config::Preset {
                        preset,
                        max_pools_to_initialize,
                        graph_url,
                        reinit_interval,
                        max_pools_per_tick_query,
                    } => liquidity::config::UniswapV3 {
                        max_pools_to_initialize,
                        reinit_interval,
                        ..match preset {
                            file::UniswapV3Preset::UniswapV3 => {
                                liquidity::config::UniswapV3::uniswap_v3(
                                    &graph_url,
                                    chain,
                                    max_pools_per_tick_query,
                                )
                            }
                        }
                        .expect("no Uniswap V3 preset for current network")
                    },
                    file::UniswapV3Config::Manual {
                        router,
                        max_pools_to_initialize,
                        graph_url,
                        reinit_interval,
                        max_pools_per_tick_query,
                    } => liquidity::config::UniswapV3 {
                        router: router.into(),
                        max_pools_to_initialize,
                        graph_url,
                        reinit_interval,
                        max_pools_per_tick_query,
                    },
                })
                .collect(),
            balancer_v2: config
                .liquidity
                .balancer_v2
                .iter()
                .cloned()
                .map(|config| match config {
                    file::BalancerV2Config::Preset {
                        preset,
                        pool_deny_list,
                        graph_url,
                        reinit_interval,
                    } => liquidity::config::BalancerV2 {
                        pool_deny_list: pool_deny_list.clone(),
                        reinit_interval,
                        ..match preset {
                            file::BalancerV2Preset::BalancerV2 => {
                                liquidity::config::BalancerV2::balancer_v2(&graph_url, chain)
                            }
                        }
                        .expect("no Balancer V2 preset for current network")
                    },
                    file::BalancerV2Config::Manual {
                        vault,
                        weighted,
                        weighted_v3plus,
                        stable,
                        liquidity_bootstrapping,
                        composable_stable,
                        pool_deny_list,
                        graph_url,
                        reinit_interval,
                    } => liquidity::config::BalancerV2 {
                        vault: vault.into(),
                        weighted,
                        weighted_v3plus,
                        stable,
                        liquidity_bootstrapping,
                        composable_stable,
                        pool_deny_list: pool_deny_list.clone(),
                        graph_url,
                        reinit_interval,
                    },
                })
                .collect(),
            zeroex: config
                .liquidity
                .zeroex
                .map(|config| liquidity::config::ZeroEx {
                    base_url: config.base_url,
                    api_key: config.api_key,
                    http_timeout: config.http_timeout,
                }),
        },
        liquidity_sources_notifier: config.liquidity_sources_notifier.map(|notifier| {
            notify::liquidity_sources::config::Config {
                liquorice: notifier.liquorice.map(|liquorice_config| {
                    notify::liquidity_sources::config::Liquorice {
                        base_url: liquorice_config.base_url,
                        api_key: liquorice_config.api_key,
                        http_timeout: liquorice_config.http_timeout,
                    }
                }),
            }
        }),
        mempools: config
            .submission
            .mempools
            .iter()
            .enumerate()
            .map(|(index, mempool)| mempool::Config {
                min_priority_fee: config.submission.min_priority_fee,
                gas_price_cap: config.submission.gas_price_cap,
                target_confirm_time: config.submission.target_confirm_time,
                retry_interval: config.submission.retry_interval,
                nonce_block_number: config.submission.nonce_block_number.map(Into::into),
                name: mempool
                    .name
                    .clone()
                    .unwrap_or_else(|| format!("mempool_{index}")),
                url: mempool.url.clone(),
                revert_protection: match mempool.mines_reverting_txs {
                    true => mempool::RevertProtection::Disabled,
                    false => mempool::RevertProtection::Enabled,
                },
                max_additional_tip: mempool.max_additional_tip,
                additional_tip_percentage: mempool.additional_tip_percentage,
            })
            .collect(),
        simulator: config.simulator,
        contracts: blockchain::contracts::Addresses {
            settlement: config.contracts.gp_v2_settlement.map(Into::into),
            weth: config.contracts.weth.map(Into::into),
            balances: config.contracts.balances.map(Into::into),
            signatures: config.contracts.signatures.map(Into::into),
            cow_amm_helper_by_factory: config
                .contracts
                .cow_amms
                .into_iter()
                .map(|cfg| (cfg.factory.into(), cfg.helper.into()))
                .collect(),
            flashloan_router: config.contracts.flashloan_router.map(Into::into),
        },
        disable_access_list_simulation: config.disable_access_list_simulation,
        disable_gas_simulation: config.disable_gas_simulation.map(Into::into),
        gas_estimator: config.gas_estimator,
        order_priority_strategies: config.order_priority_strategies,
        simulation_bad_token_max_age: config.simulation_bad_token_max_age,
        app_data_fetching: config.app_data_fetching,
        tx_gas_limit: config.tx_gas_limit,
        http: config.http,
    }
}

async fn load_account(account: file::Account, chain_id: Option<u64>) -> Account {
    match account {
        file::Account::PrivateKey(pk) => PrivateKeySigner::from_bytes(&pk)
            .expect("invalid private key")
            .into(),
        file::Account::PrivateKeyFile { path } => {
            let bytes = load_private_key_file(&path)
                .await
                .unwrap_or_else(|e| panic!("failed to load private key from {path:?}: {e:#}"));
            PrivateKeySigner::from_bytes(&bytes)
                .unwrap_or_else(|e| panic!("invalid private key in {path:?}: {e}"))
                .into()
        }
        file::Account::Kms(arn) => {
            let sdk_config = alloy::signers::aws::aws_config::load_from_env().await;
            let client = alloy::signers::aws::aws_sdk_kms::Client::new(&sdk_config);
            AwsSigner::new(client, arn.0, chain_id)
                .await
                .expect("unable to load kms account")
                .into()
        }
        file::Account::Address(address) => Account::Address(address),
    }
}

/// Read a 32-byte hex-encoded private key from disk.
///
/// On Unix this:
///   1. Rejects symlinks via `symlink_metadata` (avoids "swap the symlink
///      target after permission check" attacks),
///   2. Opens the file once and validates the permission mode against the
///      open file descriptor (closes the TOCTOU window between stat and
///      read), refusing group/world-readable files (`mode & 0o077 != 0`),
///   3. Reads from the same FD.
///
/// On Windows the symlink + permission checks are skipped — operator must
/// rely on NTFS ACLs.
///
/// The key encoding accepts `0x` / `0X` prefix or raw hex, trims surrounding
/// whitespace (so `echo $KEY > file` works without `tr -d '\n'`), and
/// enforces exactly 32 decoded bytes.
///
/// **Security note:** this enforces *filesystem-level* secrecy only. If
/// other processes run under the same UID (e.g. a shared `systemd User=`
/// account), they can read the key freely. For true key isolation use
/// `account.kms`.
async fn load_private_key_file(path: &Path) -> anyhow::Result<eth_domain_types::B256> {
    use anyhow::Context;
    use tokio::io::AsyncReadExt;

    #[cfg(unix)]
    {
        // Reject symlinks *before* opening — fstat-on-FD can't tell us this.
        let symlink_meta = tokio::fs::symlink_metadata(path)
            .await
            .with_context(|| format!("stat {}", path.display()))?;
        anyhow::ensure!(
            !symlink_meta.file_type().is_symlink(),
            "private key file {} is a symlink; refusing to follow (point the \
             config at the real file)",
            path.display()
        );
    }

    let mut file = tokio::fs::File::open(path)
        .await
        .with_context(|| format!("open {}", path.display()))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        // metadata() on the open File uses fstat against the FD — no
        // path-based re-resolution, so a concurrent rename/replace can't
        // make us read a different file than we validated.
        let fd_meta = file
            .metadata()
            .await
            .with_context(|| format!("fstat {}", path.display()))?;
        let mode = fd_meta.permissions().mode() & 0o777;
        anyhow::ensure!(
            mode & 0o077 == 0,
            "private key file {} has insecure permissions {:o}; must not be \
             group- or world-readable (try `chmod 600`)",
            path.display(),
            mode
        );
    }

    let mut contents = String::new();
    file.read_to_string(&mut contents)
        .await
        .with_context(|| format!("read {}", path.display()))?;
    let trimmed = contents.trim();
    let hex = trimmed
        .strip_prefix("0x")
        .or_else(|| trimmed.strip_prefix("0X"))
        .unwrap_or(trimmed);
    let bytes =
        const_hex::decode(hex).with_context(|| format!("decode hex in {}", path.display()))?;
    anyhow::ensure!(
        bytes.len() == 32,
        "private key file {} must decode to 32 bytes, got {}",
        path.display(),
        bytes.len()
    );
    Ok(eth_domain_types::B256::from_slice(&bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    const VALID_HEX: &str =
        "0101010101010101010101010101010101010101010101010101010101010101";

    async fn write_key(contents: &str, mode: u32) -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("key");
        tokio::fs::write(&path, contents).await.unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perm = tokio::fs::metadata(&path).await.unwrap().permissions();
            perm.set_mode(mode);
            tokio::fs::set_permissions(&path, perm).await.unwrap();
        }
        let _ = mode;
        (dir, path)
    }

    #[tokio::test]
    async fn loads_with_0x_prefix() {
        let (_d, path) = write_key(&format!("0x{VALID_HEX}\n"), 0o600).await;
        let key = load_private_key_file(&path).await.unwrap();
        assert_eq!(key.as_slice(), &[1u8; 32]);
    }

    #[tokio::test]
    async fn loads_raw_hex() {
        let (_d, path) = write_key(VALID_HEX, 0o600).await;
        load_private_key_file(&path).await.unwrap();
    }

    #[tokio::test]
    async fn rejects_short() {
        let (_d, path) = write_key("0xdeadbeef", 0o600).await;
        let err = load_private_key_file(&path).await.unwrap_err();
        assert!(format!("{err:#}").contains("32 bytes"));
    }

    #[tokio::test]
    async fn rejects_non_hex() {
        let (_d, path) = write_key("not hex at all xyz", 0o600).await;
        load_private_key_file(&path).await.unwrap_err();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn rejects_world_readable() {
        let (_d, path) = write_key(VALID_HEX, 0o644).await;
        let err = load_private_key_file(&path).await.unwrap_err();
        assert!(format!("{err:#}").contains("insecure permissions"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn rejects_group_readable() {
        let (_d, path) = write_key(VALID_HEX, 0o640).await;
        load_private_key_file(&path).await.unwrap_err();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn rejects_symlink() {
        let (_d, real) = write_key(VALID_HEX, 0o600).await;
        let link_dir = tempfile::tempdir().unwrap();
        let link = link_dir.path().join("key-link");
        tokio::fs::symlink(&real, &link).await.unwrap();
        let err = load_private_key_file(&link).await.unwrap_err();
        assert!(format!("{err:#}").contains("symlink"));
    }

}
