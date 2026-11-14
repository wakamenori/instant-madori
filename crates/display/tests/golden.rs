use madori_display::*;
fn fixture() -> Result<DisplayModel, ModelError> {
    let mesh = DisplayMesh::new(
        vec![[0., 0., 0.], [1., 0., 0.], [0., 1., 0.]],
        vec![[0., 0., 1.]; 3],
        vec![[0, 1, 2]],
        vec![7],
    )?;
    DisplayModel::new(vec![
        DisplayBody::new(
            ElementId::parse("sample:aa")?,
            Rgba8 {
                r: 1,
                g: 2,
                b: 3,
                a: 255,
            },
            true,
            mesh.clone(),
            FaceColors::new(vec![(7, Rgb8 { r: 4, g: 5, b: 6 })])?,
        )?,
        DisplayBody::new(
            ElementId::parse("sample:b")?,
            Rgba8 {
                r: 8,
                g: 9,
                b: 10,
                a: 100,
            },
            false,
            mesh,
            FaceColors::default(),
        )?,
    ])
}
#[test]
fn golden_and_round_trip() -> Result<(), Box<dyn std::error::Error>> {
    let model = fixture()?;
    let bytes = model.encode()?;
    assert_eq!(bytes, include_bytes!("two-bodies.mdsp"));
    assert_eq!(DisplayModel::decode(&bytes)?, model);
    assert_eq!(model.encode()?, bytes);
    assert!(CONTENT_TYPE.ends_with(&format!("version={FORMAT_VERSION}")));
    Ok(())
}
#[test]
fn truncations_mutations_and_bombs() -> Result<(), Box<dyn std::error::Error>> {
    let bytes = fixture()?.encode()?;
    for len in 0..bytes.len() {
        assert!(
            DisplayModel::decode(&bytes[..len]).is_err(),
            "truncation {len}"
        );
    }
    for i in 0..bytes.len() {
        for mask in [1, 0x80, 0xff] {
            let mut changed = bytes.clone();
            changed[i] ^= mask;
            if let Ok(model) = DisplayModel::decode(&changed) {
                assert_eq!(model.encode()?, changed, "mutation {i}");
            }
        }
    }
    let mut bomb = bytes.clone();
    bomb[12..16].copy_from_slice(&u32::MAX.to_le_bytes());
    assert!(DisplayModel::decode(&bomb).is_err());
    let mut trailing = bytes.clone();
    trailing.push(0);
    assert!(DisplayModel::decode(&trailing).is_err());
    Ok(())
}
#[test]
fn model_rejects_invalid_values() -> Result<(), Box<dyn std::error::Error>> {
    for id in ["", "has space", "日本語", &"x".repeat(65)] {
        assert_eq!(ElementId::parse(id), Err(ModelError::InvalidElementId));
    }
    assert_eq!(
        DisplayMesh::new(vec![[0.; 3]], vec![], vec![], vec![]),
        Err(ModelError::NormalCount)
    );
    assert_eq!(
        DisplayMesh::new(vec![], vec![], vec![[0; 3]], vec![]),
        Err(ModelError::FaceCount)
    );
    assert_eq!(
        DisplayMesh::new(vec![], vec![], vec![[0; 3]], vec![0]),
        Err(ModelError::IndexOutOfRange { triangle: 0 })
    );
    assert_eq!(
        DisplayMesh::new(vec![[f32::NAN; 3]], vec![[0.; 3]], vec![], vec![]),
        Err(ModelError::NonFinite)
    );
    let c = Rgb8 { r: 0, g: 0, b: 0 };
    assert_eq!(
        FaceColors::new(vec![(1, c), (1, c)]),
        Err(ModelError::FaceColorsUnordered)
    );
    Ok(())
}

fn offset(bytes: &[u8], section: usize) -> usize {
    {
        let p = 24 + section * 16;
        u32::from_le_bytes([bytes[p], bytes[p + 1], bytes[p + 2], bytes[p + 3]]) as usize
    }
}
#[test]
fn structural_rejections_and_optional_extensions() -> Result<(), Box<dyn std::error::Error>> {
    let bytes = fixture()?.encode()?;
    let reject = |index: usize, value: u8| {
        let mut b = bytes.clone();
        b[index] = value;
        assert!(DisplayModel::decode(&b).is_err(), "index {index}");
    };
    for (index, value) in [
        (0, b'X'),
        (4, 2),
        (6, 1),
        (20, 2),
        (24, 1),
        (32, b'E'),
        (36, 2),
    ] {
        reject(index, value);
    }
    reject(offset(&bytes, 1) + 8, 2);
    let mut nan = bytes.clone();
    let p = offset(&nan, 2);
    nan[p..p + 4].copy_from_slice(&f32::NAN.to_le_bytes());
    assert!(matches!(
        DisplayModel::decode(&nan),
        Err(DecodeError::Model(ModelError::NonFinite))
    ));
    let mut bomb = bytes.clone();
    let body = offset(&bomb, 1);
    bomb[body + 12..body + 16].copy_from_slice(&u32::MAX.to_le_bytes());
    assert!(DisplayModel::decode(&bomb).is_err());
    let mut index = bytes.clone();
    let tri = offset(&index, 4);
    index[tri..tri + 4].copy_from_slice(&3_u32.to_le_bytes());
    assert!(matches!(
        DisplayModel::decode(&index),
        Err(DecodeError::Model(ModelError::IndexOutOfRange { .. }))
    ));
    // Add an optional section after all known sections, with the exact required alignment.
    let mut extended = bytes[..128].to_vec();
    extended.resize(144, 0);
    extended.extend(&bytes[128..]);
    extended[12..16].copy_from_slice(&8_u32.to_le_bytes());
    for section in 0..7 {
        let p = 24 + section * 16;
        let next = (offset(&bytes, section) + 16) as u32;
        extended[p..p + 4].copy_from_slice(&next.to_le_bytes());
    }
    let end = extended.len().next_multiple_of(8);
    extended.resize(end, 0);
    extended.extend([9, 8, 7]);
    extended[128..132].copy_from_slice(b"TEST");
    extended[136..140].copy_from_slice(&(end as u32).to_le_bytes());
    extended[140..144].copy_from_slice(&3_u32.to_le_bytes());
    let len = extended.len() as u32;
    extended[8..12].copy_from_slice(&len.to_le_bytes());
    let model = DisplayModel::decode(&extended)?;
    assert_eq!(model.encode()?, extended);
    extended[132] = 1;
    assert_eq!(
        DisplayModel::decode(&extended),
        Err(DecodeError::UnknownRequiredSection { kind: *b"TEST" })
    );
    Ok(())
}

#[test]
fn signed_zero_is_bit_exact_in_equality_and_round_trip() -> Result<(), Box<dyn std::error::Error>> {
    let model = fixture()?;
    let mut bytes = model.encode()?;
    let position = offset(&bytes, 2);
    bytes[position..position + 4].copy_from_slice(&(-0.0_f32).to_le_bytes());
    let decoded = DisplayModel::decode(&bytes)?;
    assert_ne!(decoded, model);
    assert_eq!(decoded.encode()?, bytes);
    Ok(())
}

#[test]
fn many_element_ids_are_bounded() -> Result<(), Box<dyn std::error::Error>> {
    let empty = DisplayMesh::new(vec![], vec![], vec![], vec![])?;
    let bodies = (0..100_000)
        .map(|i| {
            DisplayBody::new(
                ElementId::parse(&format!("id:{i}"))?,
                Rgba8 {
                    r: 0,
                    g: 0,
                    b: 0,
                    a: 255,
                },
                false,
                empty.clone(),
                FaceColors::default(),
            )
        })
        .collect::<Result<Vec<_>, _>>()?;
    let model = DisplayModel::new(bodies)?;
    let started = std::time::Instant::now();
    let bytes = model.encode()?;
    assert_eq!(DisplayModel::decode(&bytes)?.bodies().len(), 100_000);
    assert!(
        started.elapsed().as_secs_f64() < 8.,
        "encoding/decoding 100k IDs took {:?}",
        started.elapsed()
    );
    Ok(())
}

#[test]
fn frozen_v1_is_readable() -> Result<(), Box<dyn std::error::Error>> {
    // Never regenerate this fixture: it represents artifacts already stored by v1 writers.
    let model = DisplayModel::decode(include_bytes!("fixtures/v1-two-bodies.mdsp"))?;
    assert_eq!(model.format_version(), 1);
    assert_eq!(model.bodies().len(), 2);
    assert_eq!(model.bodies()[0].element().as_str(), "sample:a");
    assert_eq!(model.bodies()[1].element().as_str(), "sample:b");
    assert_eq!(model.bodies()[0].mesh().triangles(), &[[0, 1, 2]]);
    assert_eq!(
        model.bodies()[0].mesh().positions(),
        &[[0., 0., 0.], [1., 0., 0.], [0., 1., 0.]]
    );
    Ok(())
}
#[test]
fn golden_requires_minimal_zero_padding() -> Result<(), Box<dyn std::error::Error>> {
    let mut bytes = fixture()?.encode()?;
    assert_eq!(bytes, include_bytes!("two-bodies.mdsp"));
    let elem_end = offset(&bytes, 0) + u32::from_le_bytes(bytes[28..32].try_into()?) as usize;
    let body_start = offset(&bytes, 1);
    assert!(body_start > elem_end);
    assert_eq!(body_start - elem_end, (8 - elem_end % 8) % 8);
    assert!(bytes[elem_end..body_start].iter().all(|b| *b == 0));
    bytes[elem_end] = 1;
    assert!(DisplayModel::decode(&bytes).is_err());
    Ok(())
}

#[test]
fn many_triangle_face_colors_are_bounded() -> Result<(), Box<dyn std::error::Error>> {
    let count = 100_000_u32;
    let mesh = DisplayMesh::new(
        vec![[0.; 3]; 3],
        vec![[0.; 3]; 3],
        vec![[0, 1, 2]; count as usize],
        (0..count).collect(),
    )?;
    let rgb = Rgb8 { r: 1, g: 2, b: 3 };
    let colors = FaceColors::new((0..count).map(|face| (face, rgb)).collect())?;
    let started = std::time::Instant::now();
    let body = DisplayBody::new(
        ElementId::parse("large")?,
        Rgba8 {
            r: 0,
            g: 0,
            b: 0,
            a: 255,
        },
        false,
        mesh.clone(),
        colors,
    )?;
    assert_eq!(body.face_colors().iter().len(), count as usize);
    assert!(
        started.elapsed().as_secs_f64() < 2.,
        "100k face membership checks took {:?}",
        started.elapsed()
    );
    assert_eq!(
        DisplayBody::new(
            ElementId::parse("bad")?,
            body.color(),
            false,
            mesh,
            FaceColors::new(vec![(count, rgb)])?
        ),
        Err(ModelError::UnknownFace)
    );
    Ok(())
}
