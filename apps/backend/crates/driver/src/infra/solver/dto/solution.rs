use {
    crate::{
        domain::{
            self,
            competition::{self},
            liquidity,
        },
        infra::Solver,
    },
    alloy::primitives::Bytes,
    app_data::AppDataHash,
    eth_domain_types as eth,
    itertools::Itertools,
    model::{
        DomainSeparator,
        order::{BuyTokenDestination, OrderData, OrderKind, SellTokenSource},
    },
    simulator::encoding::WrapperCall,
    std::{collections::HashMap, str::FromStr},
};

fn required_custom_amounts(
    solution: &solvers_dto::solution::Solution,
    orders: &[competition::Order],
) -> Result<Option<competition::solution::custom_allowlist::RequiredAmounts>, super::Error> {
    const FXUSD: alloy::primitives::Address =
        alloy::primitives::address!("085780639CC2cACd35E474e71f4d000e2405d8f6");
    const OPTIMISM_CURVE_3POOL: alloy::primitives::Address =
        alloy::primitives::address!("1337BedC9D22ecbe766dF105c9623922A27963EC");
    const OPTIMISM_WOOFI_ROUTER: alloy::primitives::Address =
        alloy::primitives::address!("4c4AF8DBc524681930a27b2F1Af5bcC8062E6fB7");
    const OPTIMISM_UNISWAP_V4_ADAPTER: alloy::primitives::Address =
        alloy::primitives::address!("d882da9CB91EB458337413E5846824CDCADB2Ddc");
    let protected_interactions: Vec<_> = solution
        .interactions
        .iter()
        .filter_map(|interaction| {
            let solvers_dto::solution::Interaction::Custom(custom) = interaction else {
                return None;
            };
            [
                FXUSD,
                OPTIMISM_CURVE_3POOL,
                OPTIMISM_WOOFI_ROUTER,
                OPTIMISM_UNISWAP_V4_ADAPTER,
            ]
            .contains(&custom.target)
            .then_some(custom.target)
        })
        .collect();
    if protected_interactions.is_empty() {
        return Ok(None);
    }
    if solution.trades.len() != 1
        || solution.interactions.len() != 1
        || protected_interactions.len() != 1
    {
        return Err(super::Error(
            "protected direct-liquidity solutions require exactly one fulfillment and one \
             interaction"
                .to_owned(),
        ));
    }
    let solvers_dto::solution::Trade::Fulfillment(fulfillment) = &solution.trades[0] else {
        return Ok(None);
    };
    let Some(order) = orders.iter().find(|order| order.uid == fulfillment.order.0) else {
        return Ok(None);
    };
    let sell = alloy::primitives::Address::from(order.sell.token);
    let buy = alloy::primitives::Address::from(order.buy.token);
    if order.side != competition::order::Side::Sell
        || (protected_interactions[0] == FXUSD && sell != FXUSD)
    {
        return Err(super::Error(
            "protected direct-liquidity interaction does not match a SELL fulfillment".to_owned(),
        ));
    }
    let sell_price = solution
        .prices
        .get(&sell)
        .copied()
        .ok_or_else(|| super::Error("missing protected sell clearing price".to_owned()))?;
    let buy_price = solution
        .prices
        .get(&buy)
        .copied()
        .filter(|price| !price.is_zero())
        .ok_or_else(|| super::Error("missing or zero protected buy clearing price".to_owned()))?;
    let executed = eth::U256::from(fulfillment.executed_amount);
    let amount_in = executed
        .checked_add(fulfillment.fee.unwrap_or_default())
        .ok_or_else(|| super::Error("protected fulfillment input overflow".to_owned()))?;
    let numerator = executed
        .checked_mul(sell_price)
        .ok_or_else(|| super::Error("protected clearing amount overflow".to_owned()))?;
    let quotient = numerator / buy_price;
    let required = quotient
        .checked_add(eth::U256::from(
            (numerator % buy_price != eth::U256::ZERO) as u8,
        ))
        .ok_or_else(|| super::Error("protected clearing amount overflow".to_owned()))?;
    Ok(Some(
        competition::solution::custom_allowlist::RequiredAmounts {
            sell_token: sell,
            buy_token: buy,
            max_input: amount_in,
            min_output: required,
        },
    ))
}

/// Validate a solver-supplied raw `Call`-style interaction (used for
/// `pre_interactions` and `post_interactions`) against the driver-level
/// allowlist + value cap. Emits the `custom_interaction_rejected` metric
/// plus structured warn on rejection, and returns a deserialization-style
/// error so the caller propagates it via the standard `?` chain.
///
/// Phase 2 audit C2 layer-2 / PR-E Codex HIGH closure (2026-05-22):
/// without this check, a solver could route arbitrary calls through
/// pre/post slots and bypass the `Custom` allowlist entirely.
///
/// WIRING INVARIANT — DO NOT REMOVE WITHOUT REPLACEMENT:
/// Every solver-supplied `Call` mapping in this file must call this
/// function. The two known sites are tagged on their first line with
/// a curly-brace token (intentionally unusual so it cannot appear in
/// prose by accident). A unit test in `custom_allowlist::tests::
/// wiring_markers_present_*` asserts exactly 2 such tags exist; if you
/// remove or split a wiring site, update both the tag count and that
/// test in lockstep.
fn validate_raw_interaction(
    target: alloy::primitives::Address,
    value: alloy::primitives::U256,
    solver: &crate::infra::Solver,
    kind: &'static str,
) -> Result<(), super::Error> {
    let chain_id = solver.eth.chain().id();
    // Precedence: target check first (broader gate), then value cap.
    // Intentional — mirrors the ordering in `custom_allowlist::validate()`
    // for Custom interactions. On combined failure the metric labels the
    // broader violation (`target_not_allowed`), matching the principle of
    // surfacing the structural mistake rather than the numeric one.
    let validate = competition::solution::custom_allowlist::validate_target(target, chain_id)
        .and_then(|()| competition::solution::custom_allowlist::validate_value(value));
    if let Err(err) = validate {
        crate::infra::observe::metrics::get()
            .custom_interaction_rejected
            .with_label_values(&[
                solver.name().as_str(),
                &chain_id.to_string(),
                err.metric_reason(),
            ])
            .inc();
        tracing::warn!(
            solver = %solver.name(),
            chain_id,
            kind,
            reason = err.metric_reason(),
            error = %err,
            "rejecting solver raw interaction"
        );
        return Err(super::Error(format!(
            "Solver {kind} rejected by driver allowlist: {err}"
        )));
    }
    Ok(())
}

#[derive(derive_more::From)]
pub struct Solutions(Vec<solvers_dto::solution::Solution>);

impl Solutions {
    const MAX_BASE_POINT: u32 = 10000;

    pub fn into_domain(
        self,
        auction: &competition::Auction,
        liquidity: &[liquidity::Liquidity],
        weth: eth::WrappedNativeToken,
        solver: Solver,
        flashloan_hints: &HashMap<competition::order::Uid, domain::flashloan::Flashloan>,
    ) -> Result<Vec<competition::Solution>, super::Error> {
        let haircut_bps = solver.haircut_bps();

        self.0
            .into_iter()
            .map(|solution| {
                let required_custom_amounts = required_custom_amounts(&solution, auction.orders())?;
                competition::Solution::new(
                    competition::solution::Id::new(solution.id),
                    solution
                        .trades
                        .iter()
                        .map(|trade| match trade {
                            solvers_dto::solution::Trade::Fulfillment(fulfillment) => {
                                let order = auction
                                    .orders()
                                    .iter()
                                    .find(|order| order.uid == fulfillment.order.0)
                                    // TODO this error should reference the UID
                                    .ok_or(super::Error(
                                        "invalid order UID specified in fulfillment".to_owned(),
                                    ))?
                                    .clone();

                                // Calculate haircut fee for conservative bidding.
                                // This reduces reported surplus without affecting executed amounts.
                                let haircut_fee = if haircut_bps > 0 {
                                    eth::U256::from(fulfillment.executed_amount)
                                        .checked_mul(eth::U256::from(haircut_bps))
                                        .and_then(|v| {
                                            v.checked_div(eth::U256::from(Self::MAX_BASE_POINT))
                                        })
                                        .unwrap_or_default()
                                } else {
                                    Default::default()
                                };

                                competition::solution::trade::Fulfillment::new(
                                    order,
                                    fulfillment.executed_amount.into(),
                                    match fulfillment.fee {
                                        Some(fee) => competition::solution::trade::Fee::Dynamic(
                                            competition::order::SellAmount(fee),
                                        ),
                                        None => competition::solution::trade::Fee::Static,
                                    },
                                    haircut_fee,
                                )
                                    .map(competition::solution::Trade::Fulfillment)
                                    .map_err(|err| super::Error(format!("invalid fulfillment: {err}")))
                            }
                            solvers_dto::solution::Trade::Jit(jit) => {
                                let jit_order: JitOrder = jit.order.clone().into();
                                Ok(competition::solution::Trade::Jit(
                                    competition::solution::trade::Jit::new(
                                        competition::order::Jit {
                                            uid: jit_order.uid(
                                                solver.eth.contracts().settlement_domain_separator(),
                                            )?,
                                            sell: eth::Asset {
                                                amount: jit_order.0.sell_amount.into(),
                                                token: jit_order.0.sell_token.into(),
                                            },
                                            buy: eth::Asset {
                                                amount: jit_order.0.buy_amount.into(),
                                                token: jit_order.0.buy_token.into(),
                                            },
                                            receiver: jit_order.0.receiver,
                                            partially_fillable: jit_order.0.partially_fillable,
                                            valid_to: jit_order.0.valid_to.into(),
                                            app_data: jit_order.0.app_data.into(),
                                            side: match jit_order.0.kind {
                                                solvers_dto::solution::Kind::Sell => {
                                                    competition::order::Side::Sell
                                                }
                                                solvers_dto::solution::Kind::Buy => {
                                                    competition::order::Side::Buy
                                                }
                                            },
                                            sell_token_balance: match jit_order.0.sell_token_balance {
                                                solvers_dto::solution::SellTokenBalance::Erc20 => {
                                                    competition::order::SellTokenBalance::Erc20
                                                }
                                                solvers_dto::solution::SellTokenBalance::Internal => {
                                                    competition::order::SellTokenBalance::Internal
                                                }
                                                solvers_dto::solution::SellTokenBalance::External => {
                                                    competition::order::SellTokenBalance::External
                                                }
                                            },
                                            buy_token_balance: match jit_order.0.buy_token_balance {
                                                solvers_dto::solution::BuyTokenBalance::Erc20 => {
                                                    competition::order::BuyTokenBalance::Erc20
                                                }
                                                solvers_dto::solution::BuyTokenBalance::Internal => {
                                                    competition::order::BuyTokenBalance::Internal
                                                }
                                            },
                                            signature: jit_order.signature(
                                                solver.eth.contracts().settlement_domain_separator(),
                                            )?,
                                        },
                                        jit.executed_amount.into(),
                                        jit.fee.unwrap_or_default().into(),
                                    )
                                        .map_err(|err| super::Error(format!("invalid JIT trade: {err}")))?,
                                ))
                            }
                        })
                        .try_collect()?,
                    solution
                        .prices
                        .into_iter()
                        .map(|(address, price)| (address.into(), price))
                        .collect(),
                    solution
                        .pre_interactions
                        .into_iter()
                        .map(|interaction| {
                            // {PR-E-WIRING-CALL}
                            // Solver pre_interactions go straight into
                            // settlement calldata via encoding.rs and
                            // would otherwise bypass the Custom allowlist.
                            validate_raw_interaction(
                                interaction.target,
                                interaction.value,
                                &solver,
                                "pre_interaction",
                            )?;
                            Ok::<_, super::Error>(domain::Interaction {
                                target: interaction.target,
                                value: interaction.value.into(),
                                call_data: Bytes::from(interaction.calldata),
                            })
                        })
                        .collect::<Result<Vec<_>, _>>()?,
                    solution
                        .interactions
                        .into_iter()
                        .map(|interaction| match interaction {
                            solvers_dto::solution::Interaction::Custom(interaction) => {
                                let custom = competition::solution::interaction::Custom {
                                    target: interaction.target.into(),
                                    value: interaction.value.into(),
                                    call_data: interaction.calldata.into(),
                                    allowances: interaction
                                        .allowances
                                        .into_iter()
                                        .map(|allowance| {
                                            eth::Allowance {
                                                token: allowance.token.into(),
                                                spender: allowance.spender,
                                                amount: allowance.amount,
                                            }
                                            .into()
                                        })
                                        .collect(),
                                    inputs: interaction
                                        .inputs
                                        .into_iter()
                                        .map(|input| eth::Asset {
                                            amount: input.amount.into(),
                                            token: input.token.into(),
                                        })
                                        .collect(),
                                    outputs: interaction
                                        .outputs
                                        .into_iter()
                                        .map(|input| eth::Asset {
                                            amount: input.amount.into(),
                                            token: input.token.into(),
                                        })
                                        .collect(),
                                    internalize: interaction.internalize,
                                };

                                // C2 layer 2 — driver-level allowlist for
                                // `Custom` interactions. Rejects target /
                                // spender addresses not on the per-chain
                                // allowlist + caps allowance amounts.
                                // Defense-in-depth on top of per-solver
                                // ALLOWLISTs in solvers/src/infra/dex/*.
                                let chain_id = solver.eth.chain().id();
                                if let Err(err) =
                                    competition::solution::custom_allowlist::validate_with_required_output(
                                        &custom, chain_id, required_custom_amounts,
                                    )
                                {
                                    crate::infra::observe::metrics::get()
                                        .custom_interaction_rejected
                                        .with_label_values(&[
                                            solver.name().as_str(),
                                            &chain_id.to_string(),
                                            err.metric_reason(),
                                        ])
                                        .inc();
                                    tracing::warn!(
                                        solver = %solver.name(),
                                        chain_id,
                                        reason = err.metric_reason(),
                                        error = %err,
                                        "rejecting Custom interaction from solver"
                                    );
                                    return Err(super::Error(format!(
                                        "Custom interaction rejected by driver allowlist: {err}"
                                    )));
                                }

                                Ok(competition::solution::Interaction::Custom(custom))
                            }
                            solvers_dto::solution::Interaction::Liquidity(interaction) => {
                                let liquidity_id = usize::from_str(&interaction.id).map_err(|_| super::Error("invalid liquidity ID format".to_owned()))?;
                                let liquidity = liquidity
                                    .iter()
                                    .find(|liquidity| liquidity.id == liquidity_id)
                                    .ok_or(super::Error(
                                        "invalid liquidity ID specified in interaction".to_owned(),
                                    ))?
                                    .to_owned();
                                Ok(competition::solution::Interaction::Liquidity(
                                    competition::solution::interaction::Liquidity {
                                        liquidity,
                                        input: eth::Asset {
                                            amount: interaction.input_amount.into(),
                                            token: interaction.input_token.into(),
                                        },
                                        output: eth::Asset {
                                            amount: interaction.output_amount.into(),
                                            token: interaction.output_token.into(),
                                        },
                                        internalize: interaction.internalize,
                                    },
                                ))
                            }
                        })
                        .try_collect()?,
                    solution
                        .post_interactions
                        .into_iter()
                        .map(|interaction| {
                            // {PR-E-WIRING-CALL}
                            validate_raw_interaction(
                                interaction.target,
                                interaction.value,
                                &solver,
                                "post_interaction",
                            )?;
                            Ok::<_, super::Error>(domain::Interaction {
                                target: interaction.target,
                                value: interaction.value.into(),
                                call_data: interaction.calldata.into(),
                            })
                        })
                        .collect::<Result<Vec<_>, _>>()?,
                    solver.clone(),
                    weth,
                    solution.gas.map(eth::Gas::from),
                    solution
                        .gas_fee_override
                        .map(|o| {
                            Ok(competition::solution::GasFeeOverride {
                                max_fee_per_gas: o.max_fee_per_gas.try_into().map_err(|_| {
                                    super::Error("max_fee_per_gas overflow".to_owned())
                                })?,
                                max_priority_fee_per_gas: o
                                    .max_priority_fee_per_gas
                                    .try_into()
                                    .map_err(|_| {
                                        super::Error(
                                            "max_priority_fee_per_gas overflow".to_owned(),
                                        )
                                    })?,
                            })
                        })
                        .transpose()?,
                    solver.config().fee_handler,
                    auction.surplus_capturing_jit_order_owners(),
                    solution.flashloans
                        // convert the flashloan info provided by the solver
                        .map(|f| f.iter().map(|(order, loan)| (order.into(), loan.clone())).collect())
                        // or copy over the relevant flashloan hints from the solve request
                        .unwrap_or_else(|| solution.trades.iter()
                            .filter_map(|t| {
                                let solvers_dto::solution::Trade::Fulfillment(trade) = &t else {
                                    // we don't have any flashloan data on JIT orders
                                    return None;
                                };
                                let uid = competition::order::Uid::from(&trade.order);
                                Some((
                                    uid,
                                    flashloan_hints.get(&uid)?.into(),
                                ))
                            }).collect()),
                    solution.wrappers.iter().cloned().map(|w| WrapperCall {
                        address: w.address,
                        data: w.data.into(),
                    }).collect(),
                )
                .map_err(|err| match err {
                    competition::solution::error::Solution::InvalidClearingPrices => {
                        super::Error("invalid clearing prices".to_owned())
                    }
                    competition::solution::error::Solution::ProtocolFee(err) => {
                        super::Error(format!("could not incorporate protocol fee: {err}"))
                    }
                    competition::solution::error::Solution::InvalidJitTrade(err) => {
                        super::Error(format!("invalid jit trade: {err}"))
                    }
                })
            })
            .collect()
    }
}

#[derive(derive_more::From)]
pub struct JitOrder(solvers_dto::solution::JitOrder);

impl JitOrder {
    fn raw_order_data(&self) -> OrderData {
        OrderData {
            sell_token: self.0.sell_token,
            buy_token: self.0.buy_token,
            receiver: Some(self.0.receiver),
            sell_amount: self.0.sell_amount,
            buy_amount: self.0.buy_amount,
            valid_to: self.0.valid_to,
            app_data: AppDataHash(self.0.app_data),
            fee_amount: alloy::primitives::U256::ZERO,
            kind: match self.0.kind {
                solvers_dto::solution::Kind::Sell => OrderKind::Sell,
                solvers_dto::solution::Kind::Buy => OrderKind::Buy,
            },
            partially_fillable: self.0.partially_fillable,
            sell_token_balance: match self.0.sell_token_balance {
                solvers_dto::solution::SellTokenBalance::Erc20 => SellTokenSource::Erc20,
                solvers_dto::solution::SellTokenBalance::Internal => SellTokenSource::Internal,
                solvers_dto::solution::SellTokenBalance::External => SellTokenSource::External,
            },
            buy_token_balance: match self.0.buy_token_balance {
                solvers_dto::solution::BuyTokenBalance::Erc20 => BuyTokenDestination::Erc20,
                solvers_dto::solution::BuyTokenBalance::Internal => BuyTokenDestination::Internal,
            },
        }
    }

    fn signature(
        &self,
        domain_separator: &eth::DomainSeparator,
    ) -> Result<competition::order::Signature, super::Error> {
        let mut signature = competition::order::Signature {
            scheme: match self.0.signing_scheme {
                solvers_dto::solution::SigningScheme::Eip712 => {
                    competition::order::signature::Scheme::Eip712
                }
                solvers_dto::solution::SigningScheme::EthSign => {
                    competition::order::signature::Scheme::EthSign
                }
                solvers_dto::solution::SigningScheme::PreSign => {
                    competition::order::signature::Scheme::PreSign
                }
                solvers_dto::solution::SigningScheme::Eip1271 => {
                    competition::order::signature::Scheme::Eip1271
                }
            },
            data: self.0.signature.clone().into(),
            signer: Default::default(),
        };

        let signer = signature
            .to_boundary_signature()
            .and_then(|sig| {
                sig.recover_owner(
                    self.0.signature.as_slice(),
                    &DomainSeparator(domain_separator.0),
                    &self.raw_order_data().hash_struct(),
                )
            })
            .map_err(|e| super::Error(e.to_string()))?;

        if matches!(
            self.0.signing_scheme,
            solvers_dto::solution::SigningScheme::Eip1271
        ) {
            // For EIP-1271 signatures the encoding logic prepends the signer to the raw
            // signature bytes. This leads to the owner being encoded twice in
            // the final settlement calldata unless we remove that from the raw
            // data.
            //
            // Audit Phase 2 finding M4: explicit length check before slicing.
            // Pre-PR `&self.0.signature[20..]` panicked on a malformed EIP-1271
            // signature shorter than 20 bytes (single-solver-induced auction
            // abort, sustained → DoS). Now returns a typed Err that the
            // caller maps to a solver-specific failure metric.
            let sig = self.0.signature.get(20..).ok_or_else(|| {
                super::Error(format!(
                    "EIP-1271 signature too short to strip prepended signer: got {} bytes, need \
                     >= 20",
                    self.0.signature.len()
                ))
            })?;
            signature.data = Bytes::copy_from_slice(sig);
        }

        signature.signer = signer;

        Ok(signature)
    }

    fn uid(&self, domain: &eth::DomainSeparator) -> Result<competition::order::Uid, super::Error> {
        let order_data = self.raw_order_data();
        let signature = self.signature(domain)?;
        Ok(order_data
            .uid(&DomainSeparator(domain.0), signature.signer)
            .0
            .into())
    }
}

#[cfg(test)]
mod protected_interaction_tests {
    use {
        super::*,
        alloy::primitives::{Address, U256, address},
    };

    #[test]
    fn protected_optimism_interactions_receive_fulfillment_context() {
        let sell = address!("4200000000000000000000000000000000000006");
        let buy = address!("0b2C639c533813f4Aa9D7837CAf62653d097Ff85");
        let targets = [
            address!("4c4AF8DBc524681930a27b2F1Af5bcC8062E6fB7"),
            address!("d882da9CB91EB458337413E5846824CDCADB2Ddc"),
        ];
        let uid = competition::order::Uid::default();
        let order = competition::Order {
            uid,
            receiver: None,
            created: 0.into(),
            valid_to: u32::MAX.into(),
            buy: eth::Asset {
                token: buy.into(),
                amount: eth::TokenAmount(U256::from(990)),
            },
            sell: eth::Asset {
                token: sell.into(),
                amount: eth::TokenAmount(U256::from(1_000)),
            },
            side: competition::order::Side::Sell,
            kind: competition::order::Kind::Market,
            app_data: Default::default(),
            partial: competition::order::Partial::No,
            pre_interactions: vec![],
            post_interactions: vec![],
            sell_token_balance: competition::order::SellTokenBalance::Erc20,
            buy_token_balance: competition::order::BuyTokenBalance::Erc20,
            signature: competition::order::Signature {
                scheme: competition::order::signature::Scheme::PreSign,
                data: Bytes::new(),
                signer: Address::ZERO,
            },
            protocol_fees: vec![],
            quote: None,
        };
        for target in targets {
            let solution: solvers_dto::solution::Solution =
                serde_json::from_value(serde_json::json!({
                    "id": 1,
                    "prices": {
                        format!("{sell:#x}"): "990",
                        format!("{buy:#x}"): "1000"
                    },
                    "trades": [{
                        "kind": "fulfillment",
                        "order": format!("0x{}", "00".repeat(56)),
                        "executedAmount": "1000"
                    }],
                    "interactions": [{
                        "kind": "custom",
                        "internalize": false,
                        "target": format!("{target:#x}"),
                        "value": "0",
                        "callData": "0x",
                        "allowances": [],
                        "inputs": [],
                        "outputs": []
                    }]
                }))
                .unwrap();

            let context = required_custom_amounts(&solution, std::slice::from_ref(&order))
                .unwrap()
                .unwrap();
            assert_eq!(context.sell_token, sell);
            assert_eq!(context.buy_token, buy);
            assert_eq!(context.max_input, U256::from(1_000));
            assert_eq!(context.min_output, U256::from(990));
        }
    }

    #[test]
    fn protected_solution_rejects_an_extra_unprotected_interaction() {
        let protected = address!("d882da9CB91EB458337413E5846824CDCADB2Ddc");
        let unprotected = address!("0000000000000000000000000000000000000001");
        let solution: solvers_dto::solution::Solution =
            serde_json::from_value(serde_json::json!({
                "id": 1,
                "prices": {},
                "trades": [{
                    "kind": "fulfillment",
                    "order": format!("0x{}", "00".repeat(56)),
                    "executedAmount": "1"
                }],
                "interactions": [
                    {
                        "kind": "custom",
                        "internalize": false,
                        "target": format!("{protected:#x}"),
                        "value": "0",
                        "callData": "0x",
                        "allowances": [],
                        "inputs": [],
                        "outputs": []
                    },
                    {
                        "kind": "custom",
                        "internalize": false,
                        "target": format!("{unprotected:#x}"),
                        "value": "0",
                        "callData": "0x",
                        "allowances": [],
                        "inputs": [],
                        "outputs": []
                    }
                ]
            }))
            .unwrap();

        let err = required_custom_amounts(&solution, &[]).unwrap_err();
        assert!(err.0.contains("exactly one fulfillment and one interaction"));
    }
}
