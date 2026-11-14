use crate::{DisplayModel, ModelError};
mod v1;
#[derive(Debug, Clone, PartialEq)]
pub enum DecodeError {
    Truncated,
    BadMagic,
    UnsupportedVersion(u16),
    LengthMismatch { declared: u32, actual: usize },
    ReservedNotZero,
    BadSectionTable,
    Misaligned { kind: [u8; 4] },
    Overlap,
    DuplicateSection { kind: [u8; 4] },
    UnknownRequiredSection { kind: [u8; 4] },
    MissingSection { kind: [u8; 4] },
    UnknownFlags,
    SectionLength { kind: [u8; 4] },
    CountMismatch { kind: [u8; 4] },
    NonCanonical,
    Model(ModelError),
}
#[derive(Debug, Clone, PartialEq)]
pub enum EncodeError {
    TooLarge,
    UnsupportedVersion(u16),
}
macro_rules! error_impl {
    ($t:ty) => {
        impl std::fmt::Display for $t {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                write!(f, "{self:?}")
            }
        }
        impl std::error::Error for $t {}
    };
}
error_impl!(DecodeError);
error_impl!(EncodeError);
impl From<ModelError> for DecodeError {
    fn from(e: ModelError) -> Self {
        Self::Model(e)
    }
}

pub(crate) fn encode(model: &DisplayModel) -> Result<Vec<u8>, EncodeError> {
    match model.format_version() {
        v1::VERSION => v1::encode(model),
        version => Err(EncodeError::UnsupportedVersion(version)),
    }
}
pub(crate) fn decode(bytes: &[u8]) -> Result<DisplayModel, DecodeError> {
    if bytes.get(..4).ok_or(DecodeError::Truncated)? != b"MDSP" {
        return Err(DecodeError::BadMagic);
    }
    let version = u16::from_le_bytes(
        bytes
            .get(4..6)
            .ok_or(DecodeError::Truncated)?
            .try_into()
            .map_err(|_| DecodeError::Truncated)?,
    );
    match version {
        v1::VERSION => v1::decode(bytes),
        _ => Err(DecodeError::UnsupportedVersion(version)),
    }
}
