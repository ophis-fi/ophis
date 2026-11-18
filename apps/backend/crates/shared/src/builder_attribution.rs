//! Ophis settlement attribution, explicitly referencing Base's builder-code registry.

// ERC-8021 schema 1: registry address, Base chain ID, code, then the schema marker.
// Registry: base/builder-codes/script/DeployBuilderCodes.s.sol at f4c883a4.
pub const SETTLEMENT_SUFFIX: [u8; 52] = hex_literal::hex!(
    "000000bc7e6457e610fe52dcc0ca5b3ce59c8e8021050262635f386a3467743578360b01
     80218021802180218021802180218021"
);

pub fn append_to_settlement(calldata: &mut Vec<u8>, chain_id: u64) {
    if matches!(chain_id, 10 | 4663 | 5042)
        && calldata.len() >= 4
        && !calldata.ends_with(&SETTLEMENT_SUFFIX)
    {
        calldata.extend_from_slice(&SETTLEMENT_SUFFIX);
    }
}

pub fn without_attribution(calldata: &[u8]) -> &[u8] {
    // Only our exact suffix may displace the auction ID; arbitrary tails remain untouched.
    calldata
        .strip_suffix(&SETTLEMENT_SUFFIX)
        .unwrap_or(calldata)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cross_chain_identity_matches_erc8021_schema_one() {
        assert_eq!(
            &SETTLEMENT_SUFFIX[..20],
            &hex_literal::hex!("000000bc7e6457e610fe52dcc0ca5b3ce59c8e80")
        );
        assert_eq!(&SETTLEMENT_SUFFIX[20..23], &[0x21, 0x05, 2]);
        assert_eq!(&SETTLEMENT_SUFFIX[23..34], b"bc_8j4gt5x6");
        assert_eq!(&SETTLEMENT_SUFFIX[34..36], &[11, 1]);
        assert_eq!(
            &SETTLEMENT_SUFFIX[36..],
            &hex_literal::hex!("80218021802180218021802180218021")
        );
    }

    #[test]
    fn attribution_preserves_auction_metadata_and_is_chain_scoped() {
        let mut original = hex_literal::hex!("13d79a0b").to_vec();
        original.extend_from_slice(&8655372i64.to_be_bytes());
        for chain in [10, 4663, 5042] {
            let mut calldata = original.clone();
            append_to_settlement(&mut calldata, chain);
            assert_eq!(calldata.len(), original.len() + 52);
            assert!(calldata.ends_with(&SETTLEMENT_SUFFIX));
            assert_eq!(without_attribution(&calldata), original);
            append_to_settlement(&mut calldata, chain);
            assert_eq!(calldata.len(), original.len() + 52);
        }
        for chain in [1, 130, 8453, 11155420, 31337] {
            let mut calldata = original.clone();
            append_to_settlement(&mut calldata, chain);
            assert_eq!(calldata, original);
        }
        let mut cancellation = Vec::new();
        append_to_settlement(&mut cancellation, 10);
        assert!(cancellation.is_empty());
    }

    #[test]
    fn stripping_does_not_guess_at_unknown_or_truncated_metadata() {
        for length in 0..SETTLEMENT_SUFFIX.len() {
            let data = &SETTLEMENT_SUFFIX[..length];
            assert_eq!(without_attribution(data), data);
        }
        let mut foreign = SETTLEMENT_SUFFIX.to_vec();
        foreign[23] = b'x';
        assert_eq!(without_attribution(&foreign), foreign);
    }
}
