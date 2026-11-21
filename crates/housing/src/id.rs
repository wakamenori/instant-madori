use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
macro_rules! id {
    ($name:ident) => {
        #[derive(
            Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, JsonSchema,
        )]
        #[serde(transparent)]
        pub struct $name(String);
        impl $name {
            pub fn new(value: impl Into<String>) -> Self {
                Self(value.into())
            }
            pub fn as_str(&self) -> &str {
                &self.0
            }
        }
    };
}
id!(StoreyId);
id!(VertexId);
id!(BoundaryId);
id!(RoomId);
id!(OpeningId);

pub(crate) fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(&byte))
}

id!(OperationId);

pub(crate) struct IdScope(String);

impl IdScope {
    pub fn new(operation: &OperationId) -> Self {
        let hash = operation
            .as_str()
            .bytes()
            .fold(0xcbf2_9ce4_8422_2325_u64, |hash, byte| {
                (hash ^ u64::from(byte)).wrapping_mul(0x100_0000_01b3)
            });
        Self(format!("{:010x}", hash >> 24))
    }
    pub fn storey(&self) -> StoreyId {
        StoreyId::new(format!("{}:s1", self.0))
    }
    pub fn room(&self, n: usize) -> RoomId {
        RoomId::new(format!("{}:r{n}", self.0))
    }
    pub fn vertex(&self, n: usize) -> VertexId {
        VertexId::new(format!("{}:v{n}", self.0))
    }
    pub fn boundary(&self, n: usize) -> BoundaryId {
        BoundaryId::new(format!("{}:w{n}", self.0))
    }
}
