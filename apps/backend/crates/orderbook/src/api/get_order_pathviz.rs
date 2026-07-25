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

/// Map an order status into the viz lifecycle context plus the solver
/// column. The competition list is sorted ascending by score, so the last
/// element is the winner (per the `CompetitionOrderStatus` contract).
fn context_and_solvers(status: &Status) -> (VizContext, Vec<PathVizSolverBid>) {
    let bids = |solutions: &[SolutionInclusion]| -> Vec<PathVizSolverBid> {
        let last = solutions.len().saturating_sub(1);
        solutions
            .iter()
            .enumerate()
            .map(|(i, s)| PathVizSolverBid {
                name: s.solver.clone(),
                winner: i == last,
                executed_sell_atoms: s.executed_amounts.as_ref().map(|a| a.sell.to_string()),
                executed_buy_atoms: s.executed_amounts.as_ref().map(|a| a.buy.to_string()),
            })
            .collect()
    };
    match status {
        Status::Traded(s) => (VizContext::Traded, bids(s)),
        Status::Executing(s) => (VizContext::Executing, bids(s)),
        Status::Solved(s) => (VizContext::QuotedOnly, bids(s)),
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
