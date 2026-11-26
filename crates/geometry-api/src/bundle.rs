use crate::apply::{ApplyOperationsOutcome, Artifact};
use schemars::JsonSchema;
use serde::Serialize;
pub const CONTENT_TYPE: &str = "application/vnd.madori.bundle; version=1";
pub const MAGIC: &str = "MDBN";
pub const VERSION: u16 = 1;
pub const HEADER_BYTES: u32 = 16;
const MIB: u32 = 1024 * 1024;
pub const SNAPSHOT_LIMIT: u32 = 2 * MIB;
const OPERATIONS_LIMIT: u32 = MIB;
const HEAD_LIMIT: u32 = MIB;
const FLOOR_PLANS_LIMIT: u32 = 4 * MIB;
pub const REQUEST_LIMIT: u32 = 2 * SNAPSHOT_LIMIT + OPERATIONS_LIMIT;
pub const RESPONSE_LIMIT: u32 =
    HEADER_BYTES + HEAD_LIMIT + SNAPSHOT_LIMIT + crate::MAX_DISPLAY_BYTES + FLOOR_PLANS_LIMIT;
const _: () = assert!(RESPONSE_LIMIT < 32 * MIB);
#[derive(Serialize, JsonSchema)]
pub struct Part {
    artifact: Artifact,
    byte_length: u32,
    #[serde(skip)]
    bytes: Vec<u8>,
}
impl Part {
    pub fn new(artifact: Artifact, bytes: Vec<u8>) -> Result<Self, String> {
        let byte_length = u32::try_from(bytes.len()).map_err(|e| e.to_string())?;
        Ok(Self {
            artifact,
            bytes,
            byte_length,
        })
    }
}
impl ApplyOperationsOutcome {
    pub fn encode(&self, limit: u32) -> Result<Vec<u8>, String> {
        let head = serde_json::to_vec(self).map_err(|e| e.to_string())?;
        let head_len = u32::try_from(head.len()).map_err(|e| e.to_string())?;
        if head_len > HEAD_LIMIT {
            return Err("bundle head exceeds limit".into());
        }
        let parts = match self {
            Self::Applied { parts, .. } => parts.as_slice(),
            Self::Rejected { .. } | Self::Unbuildable { .. } => &[],
        };
        let mut total = HEADER_BYTES + head_len;
        let mut plans = 0u32;
        for p in parts {
            total = total
                .checked_add(p.byte_length)
                .ok_or("bundle length overflow")?;
            let fits = match p.artifact {
                Artifact::House {} => p.byte_length <= SNAPSHOT_LIMIT,
                Artifact::Display {} => p.byte_length <= crate::MAX_DISPLAY_BYTES,
                Artifact::FloorPlan { .. } => {
                    plans += p.byte_length;
                    plans <= FLOOR_PLANS_LIMIT
                }
            };
            if !fits {
                return Err("artifact exceeds limit".into());
            }
        }
        if total > limit {
            return Err("bundle exceeds route limit".into());
        }
        let mut bytes = Vec::with_capacity(total as usize);
        bytes.extend_from_slice(MAGIC.as_bytes());
        bytes.extend(VERSION.to_le_bytes());
        bytes.extend(0u16.to_le_bytes());
        bytes.extend(total.to_le_bytes());
        bytes.extend(head_len.to_le_bytes());
        bytes.extend(head);
        for p in parts {
            bytes.extend_from_slice(&p.bytes)
        }
        Ok(bytes)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn serialized_response_fixture_bundle() -> Result<(), Box<dyn std::error::Error>> {
        let outcome = ApplyOperationsOutcome::Applied {
            operations: vec![],
            inspection: crate::apply::Inspection {
                housing: vec![],
                model: vec![],
            },
            parts: vec![Part::new(Artifact::Display {}, vec![0, 255])?],
        };
        let bytes = outcome.encode(RESPONSE_LIMIT)?;
        println!(
            "BUNDLE_FIXTURE={}",
            bytes.iter().map(|b| format!("{b:02x}")).collect::<String>()
        );
        Ok(())
    }
}
