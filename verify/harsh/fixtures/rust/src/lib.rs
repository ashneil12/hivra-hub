//! A tiny crate for the harsh suite. It has no dependencies so the case runs offline.

/// Clamps a value into 0..=100.
///
/// The starting state is wrong: it returns the value unchanged.
pub fn clamp_percent(value: i64) -> i64 {
    value
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_a_value_that_is_already_in_range() {
        assert_eq!(clamp_percent(42), 42);
    }
}
