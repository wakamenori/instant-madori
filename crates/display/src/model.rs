use crate::{DecodeError, EncodeError, codec};
use std::collections::BTreeSet;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ModelError {
    NormalCount,
    FaceCount,
    IndexOutOfRange { triangle: usize },
    NonFinite,
    FaceColorsUnordered,
    UnknownFace,
    InvalidElementId,
    TooLarge,
}
impl std::fmt::Display for ModelError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}
impl std::error::Error for ModelError {}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ElementId(String);
impl ElementId {
    pub fn parse(value: &str) -> Result<Self, ModelError> {
        if value.is_empty()
            || value.len() > 64
            || !value
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(&b))
        {
            return Err(ModelError::InvalidElementId);
        }
        Ok(Self(value.into()))
    }
    pub fn as_str(&self) -> &str {
        &self.0
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rgb8 {
    pub r: u8,
    pub g: u8,
    pub b: u8,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rgba8 {
    pub r: u8,
    pub g: u8,
    pub b: u8,
    pub a: u8,
}

#[derive(Clone, Debug, PartialEq, Default)]
pub struct FaceColors(Vec<(u32, Rgb8)>);
impl FaceColors {
    pub fn new(entries: Vec<(u32, Rgb8)>) -> Result<Self, ModelError> {
        if entries.windows(2).any(|w| w[0].0 >= w[1].0) {
            return Err(ModelError::FaceColorsUnordered);
        }
        u32::try_from(entries.len()).map_err(|_| ModelError::TooLarge)?;
        Ok(Self(entries))
    }
    pub fn iter(&self) -> impl ExactSizeIterator<Item = (u32, Rgb8)> + '_ {
        self.0.iter().copied()
    }
}

#[derive(Clone, Debug)]
pub struct DisplayMesh {
    positions: Vec<[f32; 3]>,
    normals: Vec<[f32; 3]>,
    triangles: Vec<[u32; 3]>,
    faces: Vec<u32>,
}
impl PartialEq for DisplayMesh {
    fn eq(&self, other: &Self) -> bool {
        let same_vectors = |left: &[[f32; 3]], right: &[[f32; 3]]| {
            left.len() == right.len()
                && left
                    .iter()
                    .zip(right)
                    .all(|(a, b)| a.map(f32::to_bits) == b.map(f32::to_bits))
        };
        same_vectors(&self.positions, &other.positions)
            && same_vectors(&self.normals, &other.normals)
            && self.triangles == other.triangles
            && self.faces == other.faces
    }
}
impl DisplayMesh {
    pub fn new(
        positions: Vec<[f32; 3]>,
        normals: Vec<[f32; 3]>,
        triangles: Vec<[u32; 3]>,
        faces: Vec<u32>,
    ) -> Result<Self, ModelError> {
        if normals.len() != positions.len() {
            return Err(ModelError::NormalCount);
        }
        if faces.len() != triangles.len() {
            return Err(ModelError::FaceCount);
        }
        if positions
            .iter()
            .chain(&normals)
            .flatten()
            .any(|n| !n.is_finite())
        {
            return Err(ModelError::NonFinite);
        }
        for (triangle, indices) in triangles.iter().enumerate() {
            if indices.iter().any(|&i| i as usize >= positions.len()) {
                return Err(ModelError::IndexOutOfRange { triangle });
            }
        }
        for count in [positions.len(), triangles.len()] {
            u32::try_from(count).map_err(|_| ModelError::TooLarge)?;
        }
        Ok(Self {
            positions,
            normals,
            triangles,
            faces,
        })
    }
    pub fn positions(&self) -> &[[f32; 3]] {
        &self.positions
    }
    pub fn normals(&self) -> &[[f32; 3]] {
        &self.normals
    }
    pub fn triangles(&self) -> &[[u32; 3]] {
        &self.triangles
    }
    pub fn faces(&self) -> &[u32] {
        &self.faces
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct DisplayBody {
    element: ElementId,
    color: Rgba8,
    closed: bool,
    mesh: DisplayMesh,
    face_colors: FaceColors,
}
impl DisplayBody {
    pub fn new(
        element: ElementId,
        color: Rgba8,
        closed: bool,
        mesh: DisplayMesh,
        face_colors: FaceColors,
    ) -> Result<Self, ModelError> {
        let faces: BTreeSet<_> = mesh.faces.iter().copied().collect();
        if face_colors.iter().any(|(face, _)| !faces.contains(&face)) {
            return Err(ModelError::UnknownFace);
        }
        Ok(Self {
            element,
            color,
            closed,
            mesh,
            face_colors,
        })
    }
    pub fn element(&self) -> &ElementId {
        &self.element
    }
    pub fn color(&self) -> Rgba8 {
        self.color
    }
    pub fn closed(&self) -> bool {
        self.closed
    }
    pub fn mesh(&self) -> &DisplayMesh {
        &self.mesh
    }
    pub fn face_colors(&self) -> &FaceColors {
        &self.face_colors
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct DisplayModel {
    bodies: Vec<DisplayBody>,
    pub(crate) format_version: u16,
    // Preserve optional extensions byte-for-byte when an older reader round-trips them.
    pub(crate) extensions: Vec<([u8; 4], Vec<u8>)>,
}
impl DisplayModel {
    pub fn new(bodies: Vec<DisplayBody>) -> Result<Self, ModelError> {
        Ok(Self {
            bodies,
            format_version: crate::FORMAT_VERSION,
            extensions: Vec::new(),
        })
    }
    pub fn format_version(&self) -> u16 {
        self.format_version
    }
    pub fn bodies(&self) -> &[DisplayBody] {
        &self.bodies
    }
    pub fn encode(&self) -> Result<Vec<u8>, EncodeError> {
        codec::encode(self)
    }
    pub fn decode(bytes: &[u8]) -> Result<Self, DecodeError> {
        codec::decode(bytes)
    }
}
