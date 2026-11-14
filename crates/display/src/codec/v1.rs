use crate::{
    DisplayBody, DisplayMesh, DisplayModel, ElementId, FaceColors, ModelError, Rgb8, Rgba8,
};
use std::collections::{BTreeMap, BTreeSet};

use super::{DecodeError, EncodeError};
pub(super) const VERSION: u16 = 1;
const REQUIRED_KINDS: [[u8; 4]; 7] = [
    *b"ELEM", *b"BODY", *b"POSN", *b"NORM", *b"TRIS", *b"TFAC", *b"FCOL",
];
// Absent optional sections use their default; optional bytes retain table order.
const KNOWN_OPTIONAL_KINDS: [[u8; 4]; 0] = [];
fn u32_bytes(v: usize) -> Result<[u8; 4], EncodeError> {
    Ok(u32::try_from(v)
        .map_err(|_| EncodeError::TooLarge)?
        .to_le_bytes())
}
fn push_count(out: &mut Vec<u8>, v: usize) -> Result<(), EncodeError> {
    out.extend(u32_bytes(v)?);
    Ok(())
}
fn aligned(v: usize) -> usize {
    (v + 7) & !7
}

pub(super) fn encode(model: &DisplayModel) -> Result<Vec<u8>, EncodeError> {
    let mut sections: BTreeMap<[u8; 4], Vec<u8>> = REQUIRED_KINDS
        .into_iter()
        .map(|k| (k, Vec::new()))
        .collect();
    let mut elements: Vec<&ElementId> = Vec::new();
    let mut element_indices = BTreeMap::new();
    for body in model.bodies() {
        if !element_indices.contains_key(body.element()) {
            element_indices.insert(body.element(), elements.len());
            elements.push(body.element());
        }
    }
    let mut elem = Vec::new();
    push_count(&mut elem, elements.len())?;
    for e in &elements {
        elem.extend((e.as_str().len() as u16).to_le_bytes());
        elem.extend(e.as_str().as_bytes());
    }
    sections.insert(*b"ELEM", elem);
    for b in model.bodies() {
        let mut body = Vec::new();
        let index = *element_indices
            .get(b.element())
            .ok_or(EncodeError::TooLarge)?;
        push_count(&mut body, index)?;
        let c = b.color();
        body.extend([c.r, c.g, c.b, c.a]);
        body.extend(u32::from(b.closed()).to_le_bytes());
        for n in [
            b.mesh().positions().len(),
            b.mesh().triangles().len(),
            b.face_colors().iter().len(),
        ] {
            push_count(&mut body, n)?;
        }
        sections.entry(*b"BODY").or_default().extend(body);
        for (kind, vectors) in [
            (*b"POSN", b.mesh().positions()),
            (*b"NORM", b.mesh().normals()),
        ] {
            for v in vectors {
                for x in v {
                    sections.entry(kind).or_default().extend(x.to_le_bytes());
                }
            }
        }
        for t in b.mesh().triangles() {
            for i in t {
                sections
                    .entry(*b"TRIS")
                    .or_default()
                    .extend(i.to_le_bytes());
            }
        }
        for i in b.mesh().faces() {
            sections
                .entry(*b"TFAC")
                .or_default()
                .extend(i.to_le_bytes());
        }
        for (face, c) in b.face_colors().iter() {
            let s = sections.entry(*b"FCOL").or_default();
            s.extend(face.to_le_bytes());
            s.extend([c.r, c.g, c.b, 0]);
        }
    }
    let mut ordered: Vec<([u8; 4], u32, Vec<u8>)> = REQUIRED_KINDS
        .into_iter()
        .map(|k| (k, 1, sections.remove(&k).unwrap_or_default()))
        .collect();
    for (kind, data) in &model.extensions {
        ordered.push((*kind, 0, data.clone()));
    }
    let table_end = 16_usize
        .checked_add(ordered.len().checked_mul(16).ok_or(EncodeError::TooLarge)?)
        .ok_or(EncodeError::TooLarge)?;
    let mut offset = aligned(table_end);
    let mut table = Vec::new();
    let mut payload = vec![0; offset - table_end];
    for (i, (kind, flags, data)) in ordered.iter().enumerate() {
        table.extend(kind);
        table.extend(flags.to_le_bytes());
        push_count(&mut table, offset)?;
        push_count(&mut table, data.len())?;
        payload.extend(data);
        offset = offset
            .checked_add(data.len())
            .ok_or(EncodeError::TooLarge)?;
        if i + 1 < ordered.len() {
            let next = aligned(offset);
            payload.resize(payload.len() + next - offset, 0);
            offset = next;
        }
    }
    let mut out = Vec::new();
    out.extend(b"MDSP");
    out.extend(VERSION.to_le_bytes());
    out.extend(0_u16.to_le_bytes());
    push_count(&mut out, offset)?;
    push_count(&mut out, ordered.len())?;
    out.extend(table);
    out.extend(payload);
    Ok(out)
}
struct Reader<'a> {
    bytes: &'a [u8],
    offset: usize,
}
impl<'a> Reader<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, offset: 0 }
    }
    fn take(&mut self, n: usize) -> Result<&'a [u8], DecodeError> {
        let end = self.offset.checked_add(n).ok_or(DecodeError::Truncated)?;
        let bytes = self
            .bytes
            .get(self.offset..end)
            .ok_or(DecodeError::Truncated)?;
        self.offset = end;
        Ok(bytes)
    }
    fn array<const N: usize>(&mut self) -> Result<[u8; N], DecodeError> {
        self.take(N)?.try_into().map_err(|_| DecodeError::Truncated)
    }
    fn u32(&mut self) -> Result<u32, DecodeError> {
        Ok(u32::from_le_bytes(self.array()?))
    }
    fn count(&mut self) -> Result<usize, DecodeError> {
        Ok(self.u32()? as usize)
    }
    fn finished(&self) -> bool {
        self.offset == self.bytes.len()
    }
    fn vectors(&mut self, n: usize, kind: [u8; 4]) -> Result<Vec<[f32; 3]>, DecodeError> {
        let bytes = self.take(
            n.checked_mul(12)
                .ok_or(DecodeError::CountMismatch { kind })?,
        )?;
        let mut r = Self::new(bytes);
        let mut out = Vec::with_capacity(bytes.len() / 12);
        for _ in 0..n {
            out.push([
                f32::from_bits(r.u32()?),
                f32::from_bits(r.u32()?),
                f32::from_bits(r.u32()?),
            ]);
        }
        Ok(out)
    }
}
pub(super) fn decode(bytes: &[u8]) -> Result<DisplayModel, DecodeError> {
    let mut r = Reader::new(bytes);
    if r.take(4)? != b"MDSP" {
        return Err(DecodeError::BadMagic);
    }
    let version = u16::from_le_bytes(r.array()?);
    if version != VERSION {
        return Err(DecodeError::UnsupportedVersion(version));
    }
    if u16::from_le_bytes(r.array()?) != 0 {
        return Err(DecodeError::ReservedNotZero);
    }
    let declared = r.u32()?;
    if declared as usize != bytes.len() {
        return Err(DecodeError::LengthMismatch {
            declared,
            actual: bytes.len(),
        });
    }
    let count = r.count()?;
    let table_len = count.checked_mul(16).ok_or(DecodeError::BadSectionTable)?;
    let table_end = 16_usize
        .checked_add(table_len)
        .ok_or(DecodeError::BadSectionTable)?;
    let mut table = Reader::new(r.take(table_len)?);
    let mut sections = BTreeMap::new();
    let mut extensions = Vec::new();
    let mut previous_end = table_end;
    for _ in 0..count {
        let kind = table.array::<4>()?;
        let flags = table.u32()?;
        let offset = table.count()?;
        let len = table.count()?;
        if flags & !1 != 0 {
            return Err(DecodeError::UnknownFlags);
        }
        if offset % 8 != 0 {
            return Err(DecodeError::Misaligned { kind });
        }
        if offset < previous_end {
            return Err(DecodeError::Overlap);
        }
        let data = bytes
            .get(
                offset
                    ..offset
                        .checked_add(len)
                        .ok_or(DecodeError::SectionLength { kind })?,
            )
            .ok_or(DecodeError::SectionLength { kind })?;
        if bytes
            .get(previous_end..offset)
            .ok_or(DecodeError::BadSectionTable)?
            .iter()
            .any(|&b| b != 0)
        {
            return Err(DecodeError::NonCanonical);
        }
        previous_end = offset + len;
        if sections.insert(kind, data).is_some() {
            return Err(DecodeError::DuplicateSection { kind });
        }
        if !REQUIRED_KINDS.contains(&kind) {
            if flags == 1 && !KNOWN_OPTIONAL_KINDS.contains(&kind) {
                return Err(DecodeError::UnknownRequiredSection { kind });
            }
            if flags != 0 {
                return Err(DecodeError::UnknownFlags);
            }
            extensions.push((kind, data.to_vec()));
        } else if flags != 1 {
            return Err(DecodeError::UnknownFlags);
        }
    }
    if previous_end != bytes.len() {
        return Err(DecodeError::NonCanonical);
    }
    for kind in REQUIRED_KINDS {
        if !sections.contains_key(&kind) {
            return Err(DecodeError::MissingSection { kind });
        }
    }
    let section = |kind| {
        sections
            .get(&kind)
            .copied()
            .ok_or(DecodeError::MissingSection { kind })
    };
    let mut elems = Reader::new(section(*b"ELEM")?);
    let n = elems.count()?;
    if n > elems.bytes.len() / 3 {
        return Err(DecodeError::CountMismatch { kind: *b"ELEM" });
    }
    let mut elements = Vec::with_capacity(n);
    let mut seen_elements = BTreeSet::new();
    for _ in 0..n {
        let len = u16::from_le_bytes(elems.array()?) as usize;
        let id = ElementId::parse(
            std::str::from_utf8(elems.take(len)?).map_err(|_| ModelError::InvalidElementId)?,
        )?;
        if !seen_elements.insert(id.clone()) {
            return Err(DecodeError::NonCanonical);
        }
        elements.push(id);
    }
    if !elems.finished() {
        return Err(DecodeError::SectionLength { kind: *b"ELEM" });
    }
    let body_bytes = section(*b"BODY")?;
    if body_bytes.len() % 24 != 0 {
        return Err(DecodeError::SectionLength { kind: *b"BODY" });
    }
    let mut body = Reader::new(body_bytes);
    let mut pos = Reader::new(section(*b"POSN")?);
    let mut norm = Reader::new(section(*b"NORM")?);
    let mut tris = Reader::new(section(*b"TRIS")?);
    let mut faces = Reader::new(section(*b"TFAC")?);
    let mut colors = Reader::new(section(*b"FCOL")?);
    let mut bodies = Vec::with_capacity(body_bytes.len() / 24);
    while !body.finished() {
        let element = elements
            .get(body.count()?)
            .ok_or(DecodeError::CountMismatch { kind: *b"BODY" })?
            .clone();
        let [r, g, b, a] = body.array()?;
        let flags = body.u32()?;
        if flags & !1 != 0 {
            return Err(DecodeError::UnknownFlags);
        }
        let v = body.count()?;
        let t = body.count()?;
        let c = body.count()?;
        let positions = pos.vectors(v, *b"POSN")?;
        let normals = norm.vectors(v, *b"NORM")?;
        let tri_bytes = tris.take(
            t.checked_mul(12)
                .ok_or(DecodeError::CountMismatch { kind: *b"TRIS" })?,
        )?;
        let face_bytes = faces.take(
            t.checked_mul(4)
                .ok_or(DecodeError::CountMismatch { kind: *b"TFAC" })?,
        )?;
        let color_bytes = colors.take(
            c.checked_mul(8)
                .ok_or(DecodeError::CountMismatch { kind: *b"FCOL" })?,
        )?;
        let mut tr = Reader::new(tri_bytes);
        let mut fr = Reader::new(face_bytes);
        let mut cr = Reader::new(color_bytes);
        let mut triangles = Vec::with_capacity(t);
        let mut face_indices = Vec::with_capacity(t);
        let mut entries = Vec::with_capacity(c);
        for _ in 0..t {
            triangles.push([tr.u32()?, tr.u32()?, tr.u32()?]);
            face_indices.push(fr.u32()?);
        }
        for _ in 0..c {
            let face = cr.u32()?;
            let [r, g, b, reserved] = cr.array()?;
            if reserved != 0 {
                return Err(DecodeError::ReservedNotZero);
            }
            entries.push((face, Rgb8 { r, g, b }));
        }
        let mesh = DisplayMesh::new(positions, normals, triangles, face_indices)?;
        bodies.push(DisplayBody::new(
            element,
            Rgba8 { r, g, b, a },
            flags == 1,
            mesh,
            FaceColors::new(entries)?,
        )?);
    }
    for (kind, reader) in [
        (*b"POSN", &pos),
        (*b"NORM", &norm),
        (*b"TRIS", &tris),
        (*b"TFAC", &faces),
        (*b"FCOL", &colors),
    ] {
        if !reader.finished() {
            return Err(DecodeError::CountMismatch { kind });
        }
    }
    let mut model = DisplayModel::new(bodies)?;
    model.extensions = extensions;
    model.format_version = VERSION;
    if encode(&model).map_err(|_| DecodeError::NonCanonical)? != bytes {
        return Err(DecodeError::NonCanonical);
    }
    Ok(model)
}
