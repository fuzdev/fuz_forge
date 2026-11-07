//! Small string measures shared across the crate's layers.
//!
//! Everything here exists because a bound or a guard is stated in terms a
//! JavaScript twin uses, so the Rust side has to measure the same way rather
//! than the way Rust would natively.

/// JS `String.length` for a Rust `str` — the count of UTF-16 code units.
///
/// The forge's string bounds and path guards are declared as `min_length` /
/// `max_length` and `path.length` on the TS side, both of which count
/// `String.length`. Bytes or `char`s would agree on ASCII and drift by up to a
/// factor of four on astral-plane text — a divergence that would refuse a path
/// or a name the TS backend serves.
pub fn utf16_len(value: &str) -> usize {
    value.encode_utf16().count()
}
