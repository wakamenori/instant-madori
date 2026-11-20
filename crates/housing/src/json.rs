use crate::{House, HouseData, Rejections};
use serde::{Deserialize, Serialize};
use std::fmt;

const VERSION: u32 = 1;

#[derive(Debug)]
pub enum ReadError {
    Malformed {
        message: String,
        line: usize,
        column: usize,
    },
    UnsupportedVersion {
        found: u32,
        newest: u32,
    },
    Rejected(Rejections),
}

impl fmt::Display for ReadError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Malformed { message, .. } => f.write_str(message),
            Self::UnsupportedVersion { found, newest } => {
                write!(f, "unsupported housing version {found} (newest {newest})")
            }
            Self::Rejected(rejections) => rejections.fmt(f),
        }
    }
}
impl std::error::Error for ReadError {}

#[derive(Debug)]
pub struct WriteError(String);

impl fmt::Display for WriteError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for WriteError {}

#[derive(Deserialize)]
struct Version {
    version: u32,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Envelope<T> {
    version: u32,
    house: T,
}

fn malformed(error: serde_json::Error) -> ReadError {
    ReadError::Malformed {
        message: error.to_string(),
        line: error.line(),
        column: error.column(),
    }
}

impl House {
    pub fn from_json(text: &str) -> Result<Self, ReadError> {
        let Version { version } = serde_json::from_str(text).map_err(malformed)?;
        if version != VERSION {
            return Err(ReadError::UnsupportedVersion {
                found: version,
                newest: VERSION,
            });
        }
        let envelope: Envelope<HouseData> = serde_json::from_str(text).map_err(malformed)?;
        Self::new(envelope.house).map_err(ReadError::Rejected)
    }

    pub fn to_json(&self) -> Result<String, WriteError> {
        serde_json::to_string(&Envelope {
            version: VERSION,
            house: self.data(),
        })
        .map_err(|error| WriteError(error.to_string()))
    }
}
