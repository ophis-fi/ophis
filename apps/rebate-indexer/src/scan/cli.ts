// Dedicated entrypoint (NOT src/cli.ts) so we never import ./db/index.js,
// which throws without DATABASE_URL and connects to the rebate DB.

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: pnpm scan --since <48h|2d|90m> [--chains a,b] [--telegram] [--json <path>]');
    return;
  }
  console.log('scan: not yet implemented');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
