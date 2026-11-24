//! A plain RGBA color. The UI layer converts it to its own color type.

/// An 8-bit-per-channel color with straight (not premultiplied) alpha.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub struct Rgba {
    pub r: u8,
    pub g: u8,
    pub b: u8,
    pub a: u8,
}

impl Rgba {
    pub const TRANSPARENT: Rgba = Rgba::new(0, 0, 0, 0);

    pub const fn new(r: u8, g: u8, b: u8, a: u8) -> Self {
        Self { r, g, b, a }
    }

    pub const fn rgb(r: u8, g: u8, b: u8) -> Self {
        Self::new(r, g, b, 255)
    }

    /// Parse `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa` (any case) or `transparent`.
    pub fn parse(value: &str) -> Option<Rgba> {
        if value == "transparent" {
            return Some(Rgba::TRANSPARENT);
        }
        let digits = value.strip_prefix('#')?;
        if !digits.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return None;
        }
        let nibble = |index: usize| u8::from_str_radix(&digits[index..=index], 16).ok();
        let pair = |index: usize| u8::from_str_radix(&digits[index..index + 2], 16).ok();
        match digits.len() {
            3 => Some(Rgba::rgb(nibble(0)? * 17, nibble(1)? * 17, nibble(2)? * 17)),
            4 => Some(Rgba::new(
                nibble(0)? * 17,
                nibble(1)? * 17,
                nibble(2)? * 17,
                nibble(3)? * 17,
            )),
            6 => Some(Rgba::rgb(pair(0)?, pair(2)?, pair(4)?)),
            8 => Some(Rgba::new(pair(0)?, pair(2)?, pair(4)?, pair(6)?)),
            _ => None,
        }
    }

    /// Lowercase `#rrggbb`, or `#rrggbbaa` when the color is not opaque.
    pub fn to_hex(self) -> String {
        if self.a == 255 {
            format!("#{:02x}{:02x}{:02x}", self.r, self.g, self.b)
        } else {
            format!("#{:02x}{:02x}{:02x}{:02x}", self.r, self.g, self.b, self.a)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_all_hex_forms_and_transparent() {
        assert_eq!(Rgba::parse("#282C34"), Some(Rgba::rgb(0x28, 0x2c, 0x34)));
        assert_eq!(Rgba::parse("#fa0"), Some(Rgba::rgb(0xff, 0xaa, 0)));
        assert_eq!(Rgba::parse("#fa08"), Some(Rgba::new(0xff, 0xaa, 0, 0x88)));
        assert_eq!(
            Rgba::parse("#11223344"),
            Some(Rgba::new(0x11, 0x22, 0x33, 0x44))
        );
        assert_eq!(Rgba::parse("transparent"), Some(Rgba::TRANSPARENT));
        assert_eq!(Rgba::parse("#12345"), None);
        assert_eq!(Rgba::parse("123456"), None);
        assert_eq!(Rgba::parse("#12345g"), None);
    }
}
