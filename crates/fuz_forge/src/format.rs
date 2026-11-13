//! Plain text-output helpers for the CLI command family — no ANSI colors,
//! ISO-8601 timestamps (matching the `fuz` Rust CLI idiom). Deliberately
//! plain: no colorized rendering, no relative-time companions.

use serde::Serialize;

/// Missing-value placeholder across detail views.
pub const DASH: &str = "—";

/// Display length for shortened blake3 hashes / commit SHAs across the CLI.
pub const SHORT_HASH_LEN: usize = 12;

/// Human-readable byte size (`1.5 MB`), binary units.
///
/// Takes `i64` because that is what the wire carries: `size_bytes` on
/// `fuz_forge_wire::output::FileMetaOutput` / `FileUploadOutput` is the `i64`
/// the server already holds, so no conversion sits between the server and the
/// wire. A local file's `u64` size converts here at the render site instead.
#[expect(
    clippy::cast_precision_loss,
    reason = "f64 is exact to 2^53 bytes, and the output keeps one decimal"
)]
pub fn format_bytes(bytes: i64) -> String {
    const UNITS: [&str; 6] = ["B", "KB", "MB", "GB", "TB", "PB"];
    if bytes < 1024 {
        return format!("{bytes} B");
    }
    let mut value = bytes as f64;
    let mut unit = 0;
    while value >= 1024.0 && unit < UNITS.len() - 1 {
        value /= 1024.0;
        unit += 1;
    }
    format!("{value:.1} {}", UNITS[unit])
}

/// First `n` chars of a string (for short SHAs / hashes).
pub fn short(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

/// Fit `s` into a fixed `width` table column: left-pad when it fits, else
/// ellipsize to `width - 1` chars (`<short>...`). One source for the list
/// renderers' pad-or-truncate idiom.
pub fn fit_column(s: &str, width: usize) -> String {
    if s.chars().count() > width - 1 {
        format!("{}...", short(s, width - 4))
    } else {
        format!("{s:<width$}")
    }
}

/// Format a SHA as `<full> (<short12>)`, or `DASH` for `None`.
pub fn format_sha_paren(sha: Option<&str>) -> String {
    sha.map_or_else(
        || DASH.to_string(),
        |s| format!("{s} ({})", short(s, SHORT_HASH_LEN)),
    )
}

/// Format an optional ISO timestamp, or `DASH` for `None`.
pub fn format_ts(ts: Option<&str>) -> String {
    ts.map_or_else(|| DASH.to_string(), ToString::to_string)
}

/// Render `[label, value]` pairs as two label-aligned columns.
pub fn render_kv_block(lines: &[(&str, String)]) {
    let label_width = lines.iter().map(|(l, _)| l.len()).max().unwrap_or(0);
    for (label, value) in lines {
        println!("  {label:label_width$}  {value}");
    }
}

/// Pretty-print a value as tab-indented JSON to stdout — the `--json`
/// convention across the CLI.
pub fn render_json<T: Serialize>(value: &T) -> Result<(), serde_json::Error> {
    let mut buf = Vec::new();
    let formatter = serde_json::ser::PrettyFormatter::with_indent(b"\t");
    let mut ser = serde_json::Serializer::with_formatter(&mut buf, formatter);
    value.serialize(&mut ser)?;
    println!("{}", String::from_utf8_lossy(&buf));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn format_bytes_units() {
        assert_eq!(format_bytes(0), "0 B");
        assert_eq!(format_bytes(512), "512 B");
        assert_eq!(format_bytes(1023), "1023 B");
        assert_eq!(format_bytes(1024), "1.0 KB");
        assert_eq!(format_bytes(1536), "1.5 KB");
        assert_eq!(format_bytes(1024 * 1024), "1.0 MB");
        assert_eq!(format_bytes(1024 * 1024 * 1024), "1.0 GB");
    }

    #[test]
    fn format_bytes_renders_negatives_verbatim() {
        // `size_bytes` is `i64` (the width the server holds), so a negative is
        // representable even though the store never emits one. The `< 1024`
        // branch returns before the `as f64` cast, so there is no lossy path:
        // a negative renders as its own decimal with the `B` unit.
        assert_eq!(format_bytes(-1), "-1 B");
        assert_eq!(format_bytes(i64::MIN), "-9223372036854775808 B");
    }

    #[test]
    fn fit_column_pads_or_ellipsizes() {
        assert_eq!(fit_column("ab", 5), "ab   ");
        assert_eq!(fit_column("abcdef", 5), "a...");
        // multi-byte chars counted by char, never split mid-code-point
        assert_eq!(fit_column("→→→→→→", 5), "→...");
    }

    #[test]
    fn short_takes_whole_chars() {
        assert_eq!(short("abcdef", 3), "abc");
        assert_eq!(short("ab", 5), "ab");
        // multi-byte chars: counted by char, never split mid-code-point
        assert_eq!(short("héllo", 2), "hé");
        assert_eq!(short("→→→", 2), "→→");
    }

    #[test]
    fn sha_and_ts_default_to_dash() {
        assert_eq!(format_sha_paren(None), DASH);
        assert_eq!(
            format_sha_paren(Some("0123456789abcdef")),
            "0123456789abcdef (0123456789ab)"
        );
        assert_eq!(format_ts(None), DASH);
        assert_eq!(
            format_ts(Some("2026-06-13T00:00:00Z")),
            "2026-06-13T00:00:00Z"
        );
    }
}
