use super::*;

pub(super) const THICKNESS: f64 = 150.;
pub(super) type XY = [f64; 2];
#[derive(Clone, Copy, Debug)]
pub(super) enum Form {
    Flat,
    Shed(usize),
    Gable(usize),
    Hip,
}
#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) enum Role {
    Surface,
    Soffit,
    Fascia,
    Verge,
    Abutment,
}
#[derive(Clone, Copy, Debug)]
pub(super) struct Probe {
    pub role: Role,
    pub point: [f64; 3],
    pub normal: [f64; 3],
}
#[derive(Clone, Copy)]
pub(super) struct Slope {
    pub a: XY,
    pub b: XY,
}
impl Slope {
    pub fn left(self) -> XY {
        let dx = self.b[0] - self.a[0];
        let dy = self.b[1] - self.a[1];
        let d = dx.hypot(dy);
        [-dy / d, dx / d]
    }
    pub fn run(self, p: XY) -> f64 {
        let [x, y] = self.left();
        x * (p[0] - self.a[0]) + y * (p[1] - self.a[1])
    }
}
pub(super) struct Piece {
    pub outline: Vec<XY>,
    pub slopes: Vec<Slope>,
}
pub(super) struct TrialRoof {
    pub name: String,
    pub pieces: Vec<Piece>,
    pub fascia_top: f64,
    pub pitch: f64,
    pub drop: f64,
    pub probes: Vec<Probe>,
}
impl TrialRoof {
    pub fn top(&self, p: XY) -> f64 {
        self.fascia_top
            + self.pieces[0]
                .slopes
                .iter()
                .map(|s| self.pitch * s.run(p))
                .reduce(f64::min)
                .unwrap_or(self.drop)
    }
    pub fn bounds(&self) -> [f64; 4] {
        let p = &self.pieces[0].outline;
        [p[0][0], p[0][1], p[2][0], p[2][1]]
    }
    pub fn covers(&self, [x, y]: XY) -> bool {
        let [l, b, r, t] = self.bounds();
        x >= l && x <= r && y >= b && y <= t
    }
}
pub(super) fn corners([l, b, r, t]: [f64; 4]) -> Vec<XY> {
    vec![[l, b], [r, b], [r, t], [l, t]]
}
#[derive(Clone, Copy, PartialEq, Eq)]
enum Side {
    South,
    East,
    North,
    West,
}
impl Side {
    const COUNTERCLOCKWISE: [Self; 4] = [Self::South, Self::East, Self::North, Self::West];

    fn bounds_index(self) -> usize {
        match self {
            Self::West => 0,
            Self::South => 1,
            Self::East => 2,
            Self::North => 3,
        }
    }

    fn overhang_sign(self) -> f64 {
        match self {
            Self::South | Self::West => -1.,
            Self::East | Self::North => 1.,
        }
    }
}
enum Edge {
    Abutment(Side),
    Extension(Side, f64),
}
fn rectangle(
    name: &str,
    walls: [f64; 4],
    form: Form,
    h: f64,
    pitch: f64,
    overhang: f64,
    edge: Option<Edge>,
) -> TrialRoof {
    let pitch = if matches!(form, Form::Flat) {
        0.
    } else {
        pitch
    };
    let drop = THICKNESS / pitch.atan().cos();
    let mut bounds = walls;
    for side in Side::COUNTERCLOCKWISE {
        let index = side.bounds_index();
        bounds[index] = match edge {
            Some(Edge::Abutment(e)) if e == side => walls[index],
            Some(Edge::Extension(e, line)) if e == side => line,
            _ => walls[index] + side.overhang_sign() * overhang,
        };
    }
    let outline = corners(bounds);
    let edges: Vec<_> = (0..4)
        .map(|i| Slope {
            a: outline[i],
            b: outline[(i + 1) % 4],
        })
        .collect();
    let slopes = edges
        .iter()
        .enumerate()
        .filter(|(i, _)| match form {
            Form::Flat => false,
            Form::Shed(low) => *i == low,
            Form::Gable(axis) => i % 2 == axis,
            Form::Hip => true,
        })
        .map(|(_, s)| *s)
        .collect();
    let mut roof = TrialRoof {
        name: name.into(),
        pieces: vec![Piece { outline, slopes }],
        pitch,
        drop,
        fascia_top: if pitch == 0. {
            h
        } else {
            h - overhang * pitch + drop
        },
        probes: vec![],
    };
    for (i, (side, s)) in Side::COUNTERCLOCKWISE.into_iter().zip(edges).enumerate() {
        let [x, y] = [(s.a[0] + s.b[0]) / 2., (s.a[1] + s.b[1]) / 2.];
        let [nx, ny] = s.left();
        let role = match (form, &edge) {
            (_, Some(Edge::Abutment(e))) if *e == side => Role::Abutment,
            (Form::Shed(low) | Form::Gable(low), _) if i % 2 != low % 2 => Role::Verge,
            _ => Role::Fascia,
        };
        roof.probes.push(Probe {
            role,
            point: [x, y, roof.top([x, y]) - drop / 2.],
            normal: [-nx, -ny, 0.],
        });
        let active = roof.pieces[0].slopes.iter().any(|other| other.a == s.a);
        if active || pitch == 0. {
            let (x, y) = (x + 20. * nx, y + 20. * ny);
            let z = roof.top([x, y]);
            let c = pitch.atan().cos();
            for (role, z, sign) in [(Role::Surface, z, 1.), (Role::Soffit, z - drop, -1.)] {
                if pitch == 0. && role == Role::Surface {
                    continue;
                }
                roof.probes.push(Probe {
                    role,
                    point: [x, y, z],
                    normal: [-nx * pitch * c * sign, -ny * pitch * c * sign, c * sign],
                });
            }
        }
    }
    if pitch == 0. {
        let [l, b, r, t] = bounds;
        roof.probes.push(Probe {
            role: Role::Surface,
            point: [(l + r) / 2., (b + t) / 2., h + drop],
            normal: [0., 0., 1.],
        });
    }
    roof
}

#[derive(Clone, Copy, Debug)]
pub(super) enum Case {
    Single(Form),
    L(Form, Form, bool),
    WideWing,
    WideHipWing,
    WideHipBranch,
    Lower,
    WideLower,
    SteeperBranch,
}
fn l_roofs(a: Form, b: Form, p: f64, branch_pitch: f64, e: f64) -> Vec<TrialRoof> {
    vec![
        rectangle("A", [0., 0., 10000., 4550.], a, 2400., p, e, None),
        rectangle(
            "B",
            [0., 4450., 4550., 10000.],
            b,
            2400.,
            branch_pitch,
            e,
            Some(Edge::Extension(
                Side::South,
                if matches!(b, Form::Hip) { -e } else { 2275. },
            )),
        ),
    ]
}
impl Case {
    pub fn house(self) -> House {
        let (rooms, height) = match self {
            Self::Single(_) => (vec![[100., 100., 9900., 4450.]], 2400.),
            Self::L(..) | Self::SteeperBranch => (
                vec![[100., 100., 9900., 4450.], [100., 4450., 4450., 9900.]],
                2400.,
            ),
            Self::WideWing | Self::WideHipWing | Self::WideHipBranch => (
                vec![[100., 100., 9900., 4450.], [100., 4450., 5900., 9900.]],
                2400.,
            ),
            Self::Lower | Self::WideLower => (vec![[100., 100., 9900., 7900.]], 2900.),
        };
        House::from_layout(
            &OperationId::new("layout"),
            &RoomLayout {
                rooms: rooms
                    .into_iter()
                    .enumerate()
                    .map(|(i, [l, b, r, t])| LayoutRoom {
                        name: i.to_string(),
                        usage: RoomUse::Other,
                        min: Point { x: l, y: b },
                        max: Point { x: r, y: t },
                    })
                    .collect(),
                walls: LayoutWalls {
                    exterior_thickness: 200.,
                    interior_thickness: 120.,
                    height,
                },
            },
        )
        .unwrap()
    }
    pub fn roofs(self, p: f64, e: f64) -> Vec<TrialRoof> {
        match self {
            Self::Single(f) => vec![rectangle(
                "A",
                [0., 0., 10000., 4550.],
                f,
                2400.,
                p,
                e,
                None,
            )],
            Self::L(a, b, different) => l_roofs(a, b, p, if different { p - 0.1 } else { p }, e),
            Self::SteeperBranch => l_roofs(Form::Gable(0), Form::Gable(1), p, p + 0.1, e),
            Self::WideHipBranch => vec![
                rectangle("A", [0., 0., 10000., 4550.], Form::Hip, 2400., p, e, None),
                rectangle(
                    "B",
                    [0., 4450., 6000., 10000.],
                    Form::Hip,
                    2400.,
                    p,
                    e,
                    Some(Edge::Extension(Side::South, -e)),
                ),
            ],
            Self::WideWing | Self::WideHipWing => {
                let (main, branch, extension) = match self {
                    Self::WideHipWing => (Form::Hip, Form::Hip, -e),
                    _ => (Form::Gable(1), Form::Gable(0), 3000.),
                };
                vec![
                    rectangle("A", [0., 0., 6000., 10000.], main, 2400., p, e, None),
                    rectangle(
                        "B",
                        [6000., 0., 10000., 4550.],
                        branch,
                        2400.,
                        p,
                        e,
                        Some(Edge::Extension(Side::West, extension)),
                    ),
                ]
            }
            Self::Lower | Self::WideLower => {
                let width = if matches!(self, Self::WideLower) {
                    4000.
                } else {
                    6000.
                };
                vec![
                    rectangle(
                        "A",
                        [0., 0., width, 8000.],
                        Form::Gable(1),
                        5800.,
                        p,
                        e,
                        None,
                    ),
                    rectangle(
                        "B",
                        [width, 0., 10000., 8000.],
                        Form::Shed(1),
                        2900.,
                        p,
                        e,
                        Some(Edge::Abutment(Side::West)),
                    ),
                ]
            }
        }
    }
}
