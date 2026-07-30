//! XML/SVG text escaping. Token symbols and venue labels are treated as
//! HOSTILE: they originate from on-chain ERC-20 `symbol()` strings and a
//! human-maintained registry, so a symbol like `</svg><script>alert(1)`
//! MUST render as inert text, never as markup.
//!
//! We escape the full XML predefined-entity set (`& < > " '`) so the output
//! is safe both as element text and inside a double- or single-quoted
//! attribute value. Control characters (except tab/newline/carriage-return)
//! are dropped: they are invalid in XML 1.0 and some break SVG parsers.

/// Escapes a string for safe inclusion in SVG text or attribute values.
pub fn xml_escape(input: &str) -> String {
    let mut out = String::with_capacity(input.len() + 8);
    for ch in input.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            '\t' | '\n' | '\r' => out.push(ch),
            // Drop other C0 control chars (invalid in XML 1.0).
            c if (c as u32) < 0x20 => {}
            c => out.push(c),
        }
    }
    out
}

/// Escapes and truncates a hostile label to `max_chars` (by char, not
/// byte), appending a single-char ellipsis when clipped. Truncation happens
/// on the RAW string first so an attacker cannot smuggle a partial entity;
/// the result is then escaped, so the output is always well-formed.
pub fn escape_label(input: &str, max_chars: usize) -> String {
    let clipped: String = if input.chars().count() > max_chars {
        let take = max_chars.saturating_sub(1);
        let mut s: String = input.chars().take(take).collect();
        s.push('\u{2026}'); // horizontal ellipsis
        s
    } else {
        input.to_string()
    };
    xml_escape(&clipped)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escapes_all_predefined_entities() {
        assert_eq!(
            xml_escape("a & b < c > d \" e ' f"),
            "a &amp; b &lt; c &gt; d &quot; e &apos; f"
        );
    }

    #[test]
    fn neutralizes_svg_script_break_out() {
        let hostile = "</svg><script>alert(1)</script>";
        let escaped = xml_escape(hostile);
        assert!(!escaped.contains('<'));
        assert!(!escaped.contains('>'));
        assert!(escaped.contains("&lt;script&gt;"));
    }

    #[test]
    fn drops_control_chars_but_keeps_whitespace() {
        let s = "a\u{0000}b\tc\nd";
        assert_eq!(xml_escape(s), "ab\tc\nd");
    }

    #[test]
    fn truncation_cannot_split_an_entity() {
        // A string of ampersands clipped mid-way must not leave a dangling
        // `&amp` without its semicolon: we clip the RAW char then escape.
        let out = escape_label("&&&&&&&&&&", 4);
        assert_eq!(out, "&amp;&amp;&amp;\u{2026}");
        // No dangling entity: every & became &amp;.
        assert!(!out.contains("&&"));
    }

    #[test]
    fn short_labels_pass_through_unclipped() {
        assert_eq!(escape_label("WETH", 8), "WETH");
    }

    #[test]
    fn counts_chars_not_bytes() {
        // Multibyte chars: 5 emoji, cap 3 -> 2 kept + ellipsis.
        let out = escape_label("😀😀😀😀😀", 3);
        assert_eq!(out.chars().filter(|c| *c == '😀').count(), 2);
        assert!(out.ends_with('\u{2026}'));
    }
}
