use super::*;
fn point(x: f64, y: f64) -> Point {
    Point { x, y }
}

fn lettered(
    vertices: &[(f64, f64)],
    rings: &[&str],
    default: (f64, f64),
    offsets: &[(&str, f64, f64)],
) -> House {
    let floor = StoreyId::new("floor");
    let mut data = HouseData {
        storeys: vec![Storey {
            id: floor.clone(),
            base_elevation: 0.,
            height: 2400.,
        }],
        vertices: vertices
            .iter()
            .enumerate()
            .map(|(i, &(x, y))| Vertex {
                id: VertexId::new(char::from(b'a' + u8::try_from(i).unwrap()).to_string()),
                storey: floor.clone(),
                at: point(x, y),
            })
            .collect(),
        rooms: vec![],
        boundaries: vec![],
        wall_colors: vec![],
        objects: vec![],
        modifiers: vec![],
        openings: vec![],
    };
    for (i, ring) in rings.iter().enumerate() {
        let mut edges = Vec::new();
        for (a, b) in ring.chars().zip(ring.chars().cycle().skip(1)) {
            let forward = format!("{a}{b}");
            let reverse = format!("{b}{a}");
            if data.boundaries.iter().any(|w| w.id.as_str() == reverse) {
                edges.push(Edge {
                    boundary: BoundaryId::new(reverse),
                    direction: Direction::Reverse,
                });
            } else {
                if !data.boundaries.iter().any(|w| w.id.as_str() == forward) {
                    let (l, r) = offsets
                        .iter()
                        .find(|(id, _, _)| *id == forward)
                        .map_or(default, |(_, l, r)| (*l, *r));
                    data.boundaries.push(Boundary {
                        id: BoundaryId::new(&forward),
                        start: VertexId::new(a.to_string()),
                        end: VertexId::new(b.to_string()),
                        wall: Wall {
                            height: 2400.,
                            offsets: SideOffsets { left: l, right: r },
                        },
                    });
                }
                edges.push(Edge {
                    boundary: BoundaryId::new(forward),
                    direction: Direction::Forward,
                });
            }
        }
        data.rooms.push(Room {
            id: RoomId::new(format!("room{i}")),
            name: ring.to_string(),
            usage: RoomUse::Other,
            edges,
        });
    }
    House::new(data).unwrap()
}

#[derive(Clone, Copy, Debug)]
pub(super) enum Case {
    P30,
    P45,
    P60,
    W,
    A20,
    X,
    S1,
    S1b,
    S2,
    S3,
    S4,
    S5,
    G,
    F1,
    F2,
    F3,
    E,
    Y1,
    Y2,
    YN,
    Q,
    Z,
}

fn parallelogram(degrees: f64) -> House {
    let shear = 3000. / degrees.to_radians().tan();
    lettered(
        &[
            (0., 0.),
            (4000., 0.),
            (8000., 0.),
            (8000. + shear, 3000.),
            (4000. + shear, 3000.),
            (shear, 3000.),
        ],
        &["abef", "bcde"],
        (75., 75.),
        &[],
    )
}
fn polar(angle: f64, r: f64) -> (f64, f64) {
    let (s, c) = angle.to_radians().sin_cos();
    (r * c, r * s)
}

fn fan(angles: &[f64], centre: (f64, f64), offsets: &[(&str, f64, f64)]) -> House {
    let mut vertices = vec![centre];
    vertices.extend(angles.iter().map(|&a| polar(a, 4000.)));
    let rings: Vec<_> = (0..angles.len())
        .map(|i| {
            format!(
                "a{}{}",
                char::from(b'b' + i as u8),
                char::from(b'b' + ((i + 1) % angles.len()) as u8)
            )
        })
        .collect();
    lettered(
        &vertices,
        &rings.iter().map(String::as_str).collect::<Vec<_>>(),
        (75., 75.),
        offsets,
    )
}

pub(super) fn branches(angles: &[f64], offsets: &[(&str, f64, f64)]) -> House {
    let top_edge_split_at_branch_feet = angles.iter().map(|a| {
        (
            if *a == 90. {
                0.
            } else {
                3000. / a.to_radians().tan()
            },
            3000.,
        )
    });
    let mut vertices = vec![(0., 0.), (8000., 0.), (8000., 3000.)];
    vertices.extend(top_edge_split_at_branch_feet);
    vertices.extend([(-8000., 3000.), (-8000., 0.)]);
    let last = b'a' + vertices.len() as u8 - 1;
    let mut rings = vec!["abcd".to_string()];
    for i in b'd'..last - 2 {
        rings.push(format!("a{}{}", char::from(i), char::from(i + 1)));
    }
    rings.push(format!(
        "a{}{}{}",
        char::from(last - 2),
        char::from(last - 1),
        char::from(last)
    ));
    lettered(
        &vertices,
        &rings.iter().map(String::as_str).collect::<Vec<_>>(),
        (75., 75.),
        offsets,
    )
}

impl Case {
    pub fn housing_resolves(self) -> bool {
        matches!(
            self,
            Self::P30
                | Self::P45
                | Self::P60
                | Self::X
                | Self::A20
                | Self::W
                | Self::S1
                | Self::S1b
                | Self::S3
                | Self::S4
                | Self::G
        )
    }

    pub fn house(self) -> House {
        match self {
            Self::P30 => parallelogram(30.),
            Self::P45 => parallelogram(45.),
            Self::P60 => parallelogram(60.),
            Self::A20 => parallelogram(20.),
            Self::X => lettered(
                &[
                    (0., 0.),
                    (5000., 0.),
                    (5000., 3000.),
                    (0., 3000.),
                    (-5000., 3000.),
                    (-5000., 0.),
                    (-5000., -3000.),
                    (-3000., -3000.),
                    (5000., -3000.),
                ],
                &["abcd", "adef", "afgh", "ahib"],
                (75., 75.),
                &[],
            ),
            Self::S1 => branches(&[90.], &[("ab", 100., 100.), ("fa", 40., 100.)]),
            Self::S1b => branches(&[60.], &[("ab", 100., 100.), ("fa", 40., 100.)]),
            Self::S3 => branches(&[150.], &[("ab", 100., 100.), ("fa", 40., 100.)]),
            Self::S4 => branches(&[30.], &[("ab", 100., 100.), ("fa", 40., 100.)]),
            Self::S5 => branches(
                &[50., 150.],
                &[
                    ("ab", 100., 100.),
                    ("ga", 40., 100.),
                    ("da", 50., 50.),
                    ("ea", 50., 50.),
                ],
            ),
            Self::G => branches(&[30., 150.], &[("ab", 100., 100.), ("ga", 100., 100.)]),
            Self::S2 => branches(&[80., 100.], &[("ab", 100., 100.), ("ga", 40., 100.)]),
            Self::F1 => branches(&[80., 100.], &[]),
            Self::F2 => branches(&[30., 50.], &[]),
            Self::F3 => branches(&[70., 90., 110.], &[]),
            Self::E => branches(&[60., 80.], &[("da", 300., 300.), ("ea", 50., 50.)]),
            Self::Y1 => fan(&[0., 120., 240.], (0., 0.), &[]),
            Self::Y2 => fan(&[0., 120., 240.], (300., 400.), &[("bc", 40., 160.)]),
            Self::YN => fan(
                &[0., 150., 200.],
                (0., 0.),
                &[("ab", 100., 100.), ("ca", 50., 50.), ("da", 100., 100.)],
            ),
            Self::Q => fan(&[0., 80., 170., 250.], (0., 0.), &[]),
            Self::Z => lettered(
                &[(3000., 0.), polar(45., 3000.), (0., 3000.), (0., 0.)],
                &["dab", "dbc"],
                (75., 75.),
                &[("da", 150., 0.), ("bd", 60., 60.)],
            ),
            Self::W => {
                let mut data = parallelogram(60.).into_data();
                data.openings.push(Opening {
                    id: OpeningId::new("window"),
                    wall: BoundaryId::new("fa"),
                    from: WallEnd::Start,
                    distance: 1200.,
                    width: 900.,
                    height: 1200.,
                    sill: 800.,
                    fitting: Fitting::Window {},
                });
                House::new(data).unwrap()
            }
        }
    }
}

impl Case {
    pub fn painted_house(self) -> House {
        let house = self.house();
        let targets = match self {
            Self::P30 | Self::P45 | Self::P60 | Self::W | Self::A20 => {
                [("fa", Side::Left), ("fa", Side::Right), ("be", Side::Left)]
            }
            Self::X => [("ha", Side::Left), ("hi", Side::Right), ("ab", Side::Left)],
            Self::Y1 | Self::Y2 | Self::YN | Self::Q => {
                [("ca", Side::Left), ("bc", Side::Right), ("ab", Side::Left)]
            }
            Self::S3 | Self::S4 => [("da", Side::Left), ("ab", Side::Left), ("da", Side::Right)],
            Self::Z => [("bd", Side::Left), ("cd", Side::Right), ("bc", Side::Left)],
            _ => [("da", Side::Left), ("bc", Side::Right), ("da", Side::Right)],
        };
        let targets: Vec<_> = if matches!(self, Self::S4 | Self::S5 | Self::G) {
            house
                .boundaries()
                .flat_map(|w| [Side::Left, Side::Right].map(|s| (w.data().id.as_str(), s)))
                .collect()
        } else {
            targets.to_vec()
        };
        let rows = targets
            .into_iter()
            .enumerate()
            .map(|(i, (id, side))| {
                let wall = BoundaryId::new(id);
                let face = house.boundary(&wall).unwrap().face(side).role();
                WallColor {
                    wall,
                    face,
                    color: Srgb {
                        r: 80 + i as u8,
                        g: 74,
                        b: 132,
                    },
                }
            })
            .collect();
        let mut data = house.into_data();
        data.wall_colors = rows;
        House::new(data).unwrap()
    }
    pub fn edited(self, house: House) -> House {
        let vertex = match self {
            Self::X => "h",
            Self::Y1 | Self::Y2 | Self::YN | Self::Q | Self::Z => "b",
            _ => "a",
        };
        let mut data = house.into_data();
        data.vertices
            .iter_mut()
            .find(|v| v.id.as_str() == vertex)
            .unwrap()
            .at
            .x += 300.;
        House::new(data).unwrap()
    }
}
