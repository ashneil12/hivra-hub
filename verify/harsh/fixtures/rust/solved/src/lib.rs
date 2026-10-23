//! A tiny crate for the harsh suite. It has no dependencies so the case runs offline.

/// Clamps a value into 0..=100.
pub fn clamp_percent(value: i64) -> i64 {
    value.clamp(0, 100)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_a_value_that_is_already_in_range() {
        assert_eq!(clamp_percent(42), 42);
    }

    #[test]
    fn clamps_a_value_above_the_range() {
        assert_eq!(clamp_percent(150), 100);
    }

    #[test]
    fn clamps_a_value_below_the_range() {
        assert_eq!(clamp_percent(-5), 0);
    }
}
