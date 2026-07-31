//! `GET /api/v1/orders/{uid}/pathviz` (JSON) and
//! `GET /api/v1/orders/{uid}/pathviz.svg` (raw SVG).
//!
//! Both are gated by the pathviz kill switch: when the feature is disabled
//! the service is absent and the routes answer 404, exactly as if they did
//! not exist. The `.svg` variant is served self-contained under a strict CSP
//! so a viewer can embed it without any external fetch.

use {
    crate::{
        api::AppState,
        dto::order::{SolutionInclusion, Status},
        pathviz::{OrderVizParams, PathVizService, VizContext},
    },
    axum::{
        extract::{Path, Query, State},
        http::{HeaderMap, HeaderValue, StatusCode, header},
        response::{IntoResponse, Json, Response},
    },
    model::{
        order::{Order, OrderKind, OrderUid},
        pathviz::{PathVizGraph, PathVizImageConfig, PathVizSolverBid},
    },
    serde::{Deserialize, Serialize},
    std::sync::Arc,
};

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PathVizQuery {
    /// Include the rendered base64 SVG in the JSON response.
    #[serde(default)]
    path_viz_image: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PathVizResponse {
    /// Lifecycle stage the graph describes (`quotedOnly`..`traded`).
    context: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    settlement_tx_hash: Option<String>,
    graph: PathVizGraph,
    #[serde(skip_serializing_if = "Option::is_none")]
    svg_base64: Option<String>,
    /// ISO-8601 UTC generation timestamp (the I/O layer's clock; the render
    /// crate itself stays clockless).
    generated_at: String,
}

/// Turn the competition's solution list into one solver bid per DISTINCT
/// solver, with the winner correctly identified.
///
/// WINNER (F3): the winner is the solution that actually executed THIS ORDER,
/// not the highest-scoring solution overall. `executed_amounts` is present only
/// on a solution that included the requested order; the list is sorted
/// ascending by score, so the winner is the LAST such solution. The fallback to
/// the final entry keeps a sane default when none carries executed_amounts
/// (non-traded statuses), though a Traded order always has at least one.
///
/// DEDUP (F5): a solver may appear in several ranked solutions (autopilot allows
/// up to max-solutions-per-solver = 3). Emitting a bid per solution produces
/// duplicate `solver:{name}` node ids downstream, which PathVizGraph::validate
/// rejects, 500ing the .svg endpoint. De-duplicate by name, first-seen order,
/// promoting the kept entry to winner (with the winning solution's executed
/// amounts) when the winning solution is a later occurrence of that name.
fn solver_bids(solutions: &[SolutionInclusion]) -> Vec<PathVizSolverBid> {
    let winner_idx = solutions
        .iter()
        .rposition(|s| s.executed_amounts.is_some())
        .unwrap_or_else(|| solutions.len().saturating_sub(1));

    let mut seen = std::collections::HashSet::new();
    let mut out: Vec<PathVizSolverBid> = Vec::new();
    for (i, s) in solutions.iter().enumerate() {
        let is_winner = i == winner_idx;
        if seen.insert(s.solver.clone()) {
            out.push(PathVizSolverBid {
                name: s.solver.clone(),
                winner: is_winner,
                executed_sell_atoms: s.executed_amounts.as_ref().map(|a| a.sell.to_string()),
                executed_buy_atoms: s.executed_amounts.as_ref().map(|a| a.buy.to_string()),
            });
        } else if is_winner {
            if let Some(existing) = out.iter_mut().find(|b| b.name == s.solver) {
                existing.winner = true;
                existing.executed_sell_atoms = s.executed_amounts.as_ref().map(|a| a.sell.to_string());
                existing.executed_buy_atoms = s.executed_amounts.as_ref().map(|a| a.buy.to_string());
            }
        }
    }
    out
}

fn context_and_solvers(status: &Status) -> (VizContext, Vec<PathVizSolverBid>) {
    match status {
        Status::Traded(s) => (VizContext::Traded, solver_bids(s)),
        Status::Executing(s) => (VizContext::Executing, solver_bids(s)),
        Status::Solved(s) => (VizContext::QuotedOnly, solver_bids(s)),
        _ => (VizContext::QuotedOnly, Vec::new()),
    }
}

struct Assembled {
    context: VizContext,
    graph: PathVizGraph,
    settlement_tx: Option<String>,
}

/// Shared gather + assemble path for both handlers. Returns `Err(status)`
/// when the feature is off (the caller turns that into 404) or the order is
/// unknown.
async fn assemble(
    state: &Arc<AppState>,
    service: &PathVizService,
    uid: &OrderUid,
) -> Result<Assembled, StatusCode> {
    let order: Order = state
        .orderbook
        .get_order(uid)
        .await
        .map_err(|err| {
            tracing::error!(?err, "pathviz: get_order failed");
            StatusCode::INTERNAL_SERVER_ERROR
        })?
        .ok_or(StatusCode::NOT_FOUND)?;

    let status = state.orderbook.get_order_status(uid).await.ok();
    let (context, solvers) = status
        .as_ref()
        .map(context_and_solvers)
        .unwrap_or((VizContext::QuotedOnly, Vec::new()));

    let settlement_tx = if context == VizContext::Traded {
        state
            .orderbook
            .settlement_tx_hash(uid)
            .await
            .unwrap_or(None)
    } else {
        None
    };

    let is_sell_order = matches!(order.data.kind, OrderKind::Sell);
    let params = OrderVizParams {
        uid: uid.to_string(),
        sell_token: order.data.sell_token,
        buy_token: order.data.buy_token,
        is_sell_order,
        signed_sell_atoms: order.data.sell_amount.to_string(),
        signed_buy_atoms: order.data.buy_amount.to_string(),
        executed_sell_atoms: Some(order.metadata.executed_sell_amount.to_string()),
        executed_buy_atoms: Some(order.metadata.executed_buy_amount.to_string()),
        solvers,
        context,
        owner: order.metadata.owner,
        settlement_tx,
        fee: None,
    };
    let graph = service.build_order_graph(params).await;
    Ok(Assembled {
        context,
        graph,
        settlement_tx: settlement_tx.map(|h| h.to_string()),
    })
}

/// `GET /api/v1/orders/{uid}/pathviz`.
pub async fn get_order_pathviz_handler(
    State(state): State<Arc<AppState>>,
    Path(uid): Path<OrderUid>,
    Query(query): Query<PathVizQuery>,
) -> Response {
    let Some(service) = state.pathviz.clone() else {
        return not_found();
    };
    let assembled = match assemble(&state, &service, &uid).await {
        Ok(a) => a,
        Err(StatusCode::NOT_FOUND) => return not_found(),
        Err(status) => return status.into_response(),
    };

    let svg_base64 = if query.path_viz_image {
        match service.render(&assembled.graph, None, assembled.context) {
            Ok(svg) => Some(pathviz::svg_to_base64(&svg)),
            Err(err) => {
                tracing::warn!(?err, "pathviz: render failed; omitting svgBase64");
                None
            }
        }
    } else {
        None
    };

    Json(PathVizResponse {
        context: assembled.context.as_str(),
        settlement_tx_hash: assembled.settlement_tx,
        graph: assembled.graph,
        svg_base64,
        generated_at: chrono::Utc::now().to_rfc3339(),
    })
    .into_response()
}

/// `GET /api/v1/orders/{uid}/pathviz.svg`.
pub async fn get_order_pathviz_svg_handler(
    State(state): State<Arc<AppState>>,
    Path(uid): Path<OrderUid>,
    Query(config): Query<PathVizImageConfig>,
) -> Response {
    let Some(service) = state.pathviz.clone() else {
        return not_found();
    };
    let assembled = match assemble(&state, &service, &uid).await {
        Ok(a) => a,
        Err(StatusCode::NOT_FOUND) => return not_found(),
        Err(status) => return status.into_response(),
    };

    let config = (config != PathVizImageConfig::default()).then_some(config);
    let svg = match service.render(&assembled.graph, config.as_ref(), assembled.context) {
        Ok(svg) => svg,
        Err(pathviz::RenderError::InvalidConfig(msg)) => {
            return (StatusCode::BAD_REQUEST, super::error("BadRequest", msg)).into_response();
        }
        Err(err) => {
            tracing::error!(?err, "pathviz: svg render failed");
            return crate::api::internal_error_reply();
        }
    };

    let mut headers = HeaderMap::new();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("image/svg+xml; charset=utf-8"),
    );
    // Self-contained render: block any external fetch and MIME sniffing.
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static("default-src 'none'; style-src 'unsafe-inline'"),
    );
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    // Traded orders are immutable; pre-settlement views change, so cache
    // them only briefly.
    let cache_control = if assembled.context == VizContext::Traded {
        "public, max-age=86400, immutable"
    } else {
        "public, max-age=10"
    };
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static(cache_control),
    );

    (StatusCode::OK, headers, svg).into_response()
}

fn not_found() -> Response {
    (StatusCode::NOT_FOUND, super::error("NotFound", "pathviz is not available")).into_response()
}

#[cfg(test)]
mod tests {
    use {
        super::solver_bids,
        crate::dto::order::{ExecutedAmounts, SolutionInclusion},
        alloy::primitives::U256,
    };

    fn sol(solver: &str, executed: Option<(u64, u64)>) -> SolutionInclusion {
        SolutionInclusion {
            solver: solver.into(),
            executed_amounts: executed.map(|(s, b)| ExecutedAmounts {
                sell: U256::from(s),
                buy: U256::from(b),
            }),
        }
    }

    #[test]
    fn winner_is_the_solution_that_executed_this_order_not_the_last() {
        // Highest-scoring solution (last) did NOT include this order; an earlier
        // one did. The winner must be the includer, not the last entry.
        let bids = solver_bids(&[
            sol("alpha", Some((100, 200))),
            sol("beta", None),
        ]);
        let winner = bids.iter().find(|b| b.winner).expect("a winner");
        assert_eq!(winner.name, "alpha");
        assert_eq!(bids.iter().filter(|b| b.winner).count(), 1);
    }

    #[test]
    fn winner_falls_back_to_last_when_none_executed() {
        let bids = solver_bids(&[sol("a", None), sol("b", None)]);
        assert_eq!(bids.iter().find(|b| b.winner).unwrap().name, "b");
    }

    #[test]
    fn one_bid_per_distinct_solver_even_with_multiple_solutions() {
        // Autopilot allows up to 3 solutions per solver; duplicate solver names
        // would produce duplicate solver:{name} node ids and 500 the .svg
        // endpoint via PathVizGraph::validate. Must collapse to one per name.
        let bids = solver_bids(&[
            sol("dup", None),
            sol("dup", None),
            sol("dup", Some((1, 2))),
            sol("other", None),
        ]);
        assert_eq!(bids.len(), 2, "two distinct solvers");
        let names: Vec<_> = bids.iter().map(|b| b.name.as_str()).collect();
        assert_eq!(names, vec!["dup", "other"]);
    }

    #[test]
    fn winner_flag_promotes_to_the_kept_entry_when_a_later_duplicate_wins() {
        // "dup" first appears as a non-executing solution, then as the executing
        // (winning) one. The single kept "dup" entry must carry the winner flag
        // and the winning solution's executed amounts.
        let bids = solver_bids(&[
            sol("dup", None),
            sol("dup", Some((100, 200))),
        ]);
        assert_eq!(bids.len(), 1);
        let dup = &bids[0];
        assert!(dup.winner);
        assert_eq!(dup.executed_sell_atoms.as_deref(), Some("100"));
        assert_eq!(dup.executed_buy_atoms.as_deref(), Some("200"));
    }

    #[test]
    fn empty_solutions_yield_no_bids() {
        assert!(solver_bids(&[]).is_empty());
    }
}
