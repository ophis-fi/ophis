//! Resolved color theme for a render, derived from a
//! [`model::pathviz::PathVizImageConfig`] plus the Ophis dark-cosmic
//! defaults (owner decision 23).
//!
//! The default is dark cosmic: Cosmic `#02000D` background, Cream `#F5EFE6`
//! text, Sunset `#f2a63e` as the leading (sparingly used) link accent. A
//! `"light"` theme name flips the base pair for partner embeds without
//! touching any other constant.
//!
//! Every color here has already been validated as a hex string by the
//! config (or is a compile-time default constant), so values are safe to
//! interpolate directly into SVG attributes.

use model::pathviz::{
    self, DEFAULT_BACKGROUND, DEFAULT_LEGEND_TEXT_COLOR, DEFAULT_LINK_COLORS, DEFAULT_NODE_COLOR,
    DEFAULT_NODE_TEXT_COLOR, DEFAULT_SURPLUS_COLOR, PathVizImageConfig,
};

/// A fully resolved palette (no `Option`s left).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Theme {
    pub background: String,
    pub node_color: String,
    pub node_text_color: String,
    pub legend_text_color: String,
    pub surplus_color: String,
    /// Non-empty; the layout indexes into it modulo its length.
    pub link_colors: Vec<String>,
}

impl Theme {
    /// The Ophis dark-cosmic theme (the default).
    pub fn dark() -> Self {
        Self {
            background: DEFAULT_BACKGROUND.to_string(),
            node_color: DEFAULT_NODE_COLOR.to_string(),
            node_text_color: DEFAULT_NODE_TEXT_COLOR.to_string(),
            legend_text_color: DEFAULT_LEGEND_TEXT_COLOR.to_string(),
            surplus_color: DEFAULT_SURPLUS_COLOR.to_string(),
            link_colors: DEFAULT_LINK_COLORS.iter().map(|s| s.to_string()).collect(),
        }
    }

    /// The one-constant-flip light theme kept for partner embeds
    /// (decision 23). Only the base pair changes; the link ramp is shared so
    /// a diagram reads the same either way.
    pub fn light() -> Self {
        Self {
            background: "#F5EFE6".to_string(), // Cream as canvas
            node_color: "#efe6d6".to_string(),
            node_text_color: "#02000D".to_string(), // Cosmic ink
            legend_text_color: "#5b5570".to_string(),
            surplus_color: "#2f8f57".to_string(),
            link_colors: DEFAULT_LINK_COLORS.iter().map(|s| s.to_string()).collect(),
        }
    }

    /// Resolve a theme from an optional image config: start from the named
    /// base theme, then overlay any explicit color overrides.
    pub fn resolve(config: Option<&PathVizImageConfig>) -> Self {
        let base = match config.and_then(|c| c.theme.as_deref()) {
            Some("light") => Self::light(),
            _ => Self::dark(),
        };
        let Some(cfg) = config else {
            return base;
        };
        Self {
            background: cfg.background_color.clone().unwrap_or(base.background),
            node_color: cfg.node_color.clone().unwrap_or(base.node_color),
            node_text_color: cfg
                .node_text_color
                .clone()
                .unwrap_or(base.node_text_color),
            legend_text_color: cfg
                .legend_text_color
                .clone()
                .unwrap_or(base.legend_text_color),
            surplus_color: cfg.surplus_color.clone().unwrap_or(base.surplus_color),
            link_colors: cfg
                .link_colors
                .clone()
                .filter(|v| !v.is_empty())
                .unwrap_or(base.link_colors),
        }
    }

    /// Pick a link color by index (wraps around the ramp).
    pub fn link_color(&self, index: usize) -> &str {
        &self.link_colors[index % self.link_colors.len()]
    }
}

impl Default for Theme {
    fn default() -> Self {
        Self::dark()
    }
}

/// Convenience: the dark background hex, used by the `.svg` handler for the
/// document `<rect>` fallback.
pub const COSMIC_BACKGROUND: &str = pathviz::DEFAULT_BACKGROUND;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dark_is_the_default() {
        assert_eq!(Theme::resolve(None), Theme::dark());
        assert_eq!(Theme::default().background, "#02000D");
    }

    #[test]
    fn light_flips_only_the_base_pair() {
        let light = Theme::light();
        assert_eq!(light.background, "#F5EFE6");
        assert_eq!(light.node_text_color, "#02000D");
        // The link ramp is shared with dark.
        assert_eq!(light.link_colors, Theme::dark().link_colors);
    }

    #[test]
    fn config_overrides_win_over_base() {
        let cfg = PathVizImageConfig {
            theme: Some("dark".into()),
            background_color: Some("#111111".into()),
            surplus_color: Some("#abcdef".into()),
            ..Default::default()
        };
        let t = Theme::resolve(Some(&cfg));
        assert_eq!(t.background, "#111111");
        assert_eq!(t.surplus_color, "#abcdef");
        // Untouched fields keep the dark defaults.
        assert_eq!(t.node_text_color, "#F5EFE6");
    }

    #[test]
    fn empty_link_colors_falls_back_to_ramp() {
        let cfg = PathVizImageConfig {
            link_colors: Some(vec![]),
            ..Default::default()
        };
        let t = Theme::resolve(Some(&cfg));
        assert_eq!(t.link_colors.len(), 6);
    }

    #[test]
    fn link_color_wraps() {
        let t = Theme::dark();
        assert_eq!(t.link_color(0), t.link_color(6));
    }
}
