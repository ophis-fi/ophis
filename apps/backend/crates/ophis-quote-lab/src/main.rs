use {
    alloy_primitives::{Address, U256},
    clap::{Parser, Subcommand},
    ophis_quote_lab::{BenchmarkMatrix, Error, Manifest, QuoteLabClient},
    std::{path::PathBuf, str::FromStr},
};

#[derive(Parser)]
#[command(about = "Read-only, block-pinned Ophis quote measurements")]
struct Arguments {
    #[arg(long, default_value = "crates/ophis-quote-lab/config/ethereum.toml")]
    manifest: PathBuf,

    #[arg(long, env = "ETHEREUM_RPC_URL")]
    rpc_url: url::Url,

    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Verify all pinned runtime code hashes at one canonical block.
    Verify,
    /// Record one exact-input aggregate quote. Never builds or submits calldata.
    Quote {
        #[arg(long)]
        source: String,
        #[arg(long)]
        token_in: Address,
        #[arg(long)]
        token_out: Address,
        /// Raw token amount in base units.
        #[arg(long)]
        amount: String,
    },
    /// Compare several exact-input aggregate quotes at one canonical block.
    Compare {
        #[arg(long, required = true)]
        source: Vec<String>,
        #[arg(long)]
        token_in: Address,
        #[arg(long)]
        token_out: Address,
        /// Raw token amount in base units.
        #[arg(long)]
        amount: String,
    },
    /// Run a bounded quote matrix at one canonical block and summarize it.
    Matrix {
        #[arg(
            long,
            default_value = "crates/ophis-quote-lab/config/ethereum-matrix.toml"
        )]
        matrix: PathBuf,
        #[arg(long, required = true)]
        source: Vec<String>,
    },
    /// Repeat a matrix across advancing Ethereum blocks and aggregate it.
    Series {
        #[arg(
            long,
            default_value = "crates/ophis-quote-lab/config/ethereum-matrix.toml"
        )]
        matrix: PathBuf,
        #[arg(long, required = true)]
        source: Vec<String>,
        #[arg(long, default_value_t = 3)]
        samples: usize,
        #[arg(long, default_value_t = 60)]
        interval_seconds: u64,
    },
}

#[tokio::main]
async fn main() -> Result<(), Error> {
    let arguments = Arguments::parse();
    let manifest = Manifest::load(&arguments.manifest)?;
    let client = QuoteLabClient::try_new(arguments.rpc_url, manifest.network.chain_id)?;

    match arguments.command {
        Command::Verify => {
            let verification = client.verify_manifest(&manifest).await?;
            println!("{}", serde_json::to_string_pretty(&verification).unwrap());
            if !verification.all_match() {
                return Err(Error::VerificationFailed);
            }
        }
        Command::Quote {
            source,
            token_in,
            token_out,
            amount,
        } => {
            let amount = U256::from_str(&amount).map_err(|_| Error::InvalidAmount)?;
            let observation = client
                .observe_exact_in(&manifest, &source, token_in, token_out, amount)
                .await?;
            println!("{}", serde_json::to_string_pretty(&observation).unwrap());
        }
        Command::Compare {
            source,
            token_in,
            token_out,
            amount,
        } => {
            let amount = U256::from_str(&amount).map_err(|_| Error::InvalidAmount)?;
            let comparison = client
                .compare_exact_in(&manifest, &source, token_in, token_out, amount)
                .await?;
            println!("{}", serde_json::to_string_pretty(&comparison).unwrap());
        }
        Command::Matrix { matrix, source } => {
            let matrix = BenchmarkMatrix::load(&matrix)?;
            let run = client.run_matrix(&manifest, &matrix, &source).await?;
            println!("{}", serde_json::to_string_pretty(&run).unwrap());
        }
        Command::Series {
            matrix,
            source,
            samples,
            interval_seconds,
        } => {
            let matrix = BenchmarkMatrix::load(&matrix)?;
            let series = client
                .run_matrix_series(&manifest, &matrix, &source, samples, interval_seconds)
                .await?;
            println!("{}", serde_json::to_string_pretty(&series).unwrap());
        }
    }
    Ok(())
}
