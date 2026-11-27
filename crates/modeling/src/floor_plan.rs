mod shape;
mod xml;

use madori_housing::{House, Point, Rejection, Rejections, StoreyId, TATAMI_SQUARE_METRES};
use shape::*;
use xml::{
    Attr::*,
    ScreenPoint, Svg, Tag,
    Value::{self, Id, Number, Token},
};

pub fn interior_corners(outline: &[Point]) -> Vec<Point> {
    Ring::from_interior(outline).0
}
#[derive(Debug)]
pub struct StoreyPlan {
    pub storey: StoreyId,
    pub svg: FloorPlanSvg,
}
/// A complete SVG document constructed by the plan writer. One user unit is one
/// millimetre, with north toward the top of the drawing.
#[derive(Debug)]
pub struct FloorPlanSvg(String);
impl FloorPlanSvg {
    pub fn as_str(&self) -> &str {
        &self.0
    }
    pub fn into_string(self) -> String {
        self.0
    }
}

struct RoomShape<'a> {
    id: &'a str,
    name: &'a str,
    area: String,
    tatami: String,
    outline: Ring,
    label: Label,
}
#[derive(Clone, Copy)]
struct Extent {
    min: Point,
    max: Point,
}

impl Extent {
    fn from_points<'a>(mut points: impl Iterator<Item = &'a Point>) -> Option<Self> {
        let first = *points.next()?;
        let mut bounds = Self {
            min: first,
            max: first,
        };
        for point in points {
            bounds.min.x = bounds.min.x.min(point.x);
            bounds.min.y = bounds.min.y.min(point.y);
            bounds.max.x = bounds.max.x.max(point.x);
            bounds.max.y = bounds.max.y.max(point.y);
        }
        Some(bounds)
    }
}

struct Scene<'a> {
    wall_extent: Option<Extent>,
    rooms: Vec<RoomShape<'a>>,
    walls: Vec<WallShape<'a>>,
    openings: Vec<OpeningShape<'a>>,
}
impl<'a> Scene<'a> {
    fn build(house: &'a House, storey: &StoreyId, errors: &mut Vec<Rejection>) -> Self {
        let mut rooms = Vec::new();
        for room in house.rooms().filter(|r| r.storey() == storey) {
            match room.interior() {
                Ok(interior) => {
                    let outline = Ring::from_interior(interior.outline());
                    let text = interior.area().text();
                    let area = format!("{} m²", text.square_metres);
                    let tatami = format!("{}畳", text.tatami);
                    let name = &room.data().name;
                    let label = Label::new(&outline, [name, &area, &tatami]);
                    rooms.push(RoomShape {
                        id: room.data().id.as_str(),
                        name,
                        area,
                        tatami,
                        outline,
                        label,
                    });
                }
                Err(e) => errors.extend_from_slice(e.as_slice()),
            }
        }
        let mut walls = Vec::new();
        for wall in house
            .boundaries()
            .filter(|w| &w.start().data().storey == storey)
        {
            match wall.planform() {
                Ok(poly) => walls.push(WallShape::new(wall, poly.points().to_vec())),
                Err(e) => errors.extend_from_slice(e.as_slice()),
            }
        }
        let openings = house
            .openings()
            .filter(|o| &o.wall().start().data().storey == storey)
            .map(OpeningShape::new)
            .collect();
        Self {
            wall_extent: Extent::from_points(walls.iter().flat_map(|wall| &wall.polygon)),
            rooms,
            walls,
            openings,
        }
    }
    fn extent(&self) -> Extent {
        let origin = Point { x: 0., y: 0. };
        self.wall_extent
            .or_else(|| Extent::from_points(self.rooms.iter().flat_map(|room| &room.outline.0)))
            .unwrap_or(Extent {
                min: origin,
                max: origin,
            })
    }
}

/// Draws one plan in house storey order and reports geometry errors across all storeys.
pub fn render(house: &House) -> Result<Vec<StoreyPlan>, Rejections> {
    let mut errors = Vec::new();
    let scenes: Vec<_> = house
        .storeys()
        .map(|s| {
            let id = &s.data().id;
            (id, Scene::build(house, id, &mut errors))
        })
        .collect();
    if let Some(e) = Rejections::from_errors(errors) {
        return Err(e);
    }
    Ok(scenes
        .into_iter()
        .map(|(id, scene)| StoreyPlan {
            storey: id.clone(),
            svg: draw(id, &scene),
        })
        .collect())
}
const PAPER: &str = "#ffffff";
const INK: &str = "#303b40";
fn group(svg: &mut Svg, class: &'static str) {
    svg.open(Tag::G, &[(Class, Token(class))])
}
fn line(svg: &mut Svg, a: Point, b: Point) {
    let (a, b) = (ScreenPoint::from(a), ScreenPoint::from(b));
    svg.leaf(
        Tag::Line,
        &[(X1, a.x()), (Y1, a.y()), (X2, b.x()), (Y2, b.y())],
    )
}
fn draw_room(svg: &mut Svg, room: &RoomShape) {
    svg.open(Tag::G, &[(Class, Token("room")), (Element, Id(room.id))]);
    let points: Vec<_> = room
        .outline
        .0
        .iter()
        .copied()
        .map(ScreenPoint::from)
        .collect();
    svg.leaf(
        Tag::Polygon,
        &[
            (Class, Token("room-floor")),
            (Points, Value::Points(&points)),
            (Fill, Token("#f7f5ef")),
        ],
    );
    let Label { at, font } = room.label;
    svg.open(
        Tag::Text,
        &[(Class, Token("room-label")), (Anchor, Token("middle"))],
    );
    for (class, text, scale, dy, weight) in [
        ("room-name", room.name, 1., 0.8, "600"),
        ("room-area", &room.area, 0.75, -0.4, "400"),
        ("room-tatami", &room.tatami, 0.75, -1.3, "400"),
    ] {
        let p = ScreenPoint::from(Point {
            x: at.x,
            y: at.y + font * dy,
        });
        svg.text(
            Tag::Tspan,
            &[
                (Class, Token(class)),
                (X, p.x()),
                (Y, p.y()),
                (FontSize, Number(font * scale)),
                (Weight, Token(weight)),
            ],
            text,
        )
    }
    svg.close();
    svg.close();
}
fn draw_opening(svg: &mut Svg, opening: &OpeningShape) {
    svg.open(
        Tag::G,
        &[
            (Class, Token("opening")),
            (Element, Id(opening.id)),
            (Kind, Token(opening.kind)),
            (Stroke, Token(INK)),
            (StrokeWidth, Number(16.)),
        ],
    );
    if let Some(([a, b], symbol)) = &opening.symbol {
        let gap = [a.left, b.left, b.right, a.right].map(ScreenPoint::from);
        svg.leaf(
            Tag::Polygon,
            &[
                (Points, Value::Points(&gap)),
                (Fill, Token(PAPER)),
                (Stroke, Token("none")),
            ],
        );
        match symbol {
            Symbol::Window => {
                line(svg, a.left, a.right);
                line(svg, b.left, b.right);
                line(svg, a.centre, b.centre);
            }
            Symbol::Door { hinge, free, tip } => {
                line(svg, *hinge, *tip);
                svg.leaf(
                    Tag::Path,
                    &[
                        (
                            D,
                            Value::Arc {
                                hinge: (*hinge).into(),
                                free: (*free).into(),
                                tip: (*tip).into(),
                            },
                        ),
                        (Fill, Token("none")),
                        (StrokeWidth, Number(10.)),
                    ],
                );
            }
        }
    }
    svg.close();
}
fn dimension(svg: &mut Svg, dim: Dimension, outer: bool) {
    let Dimension {
        axis,
        offset,
        length,
    } = dim;
    svg.open(
        Tag::G,
        &[
            (Class, Token("dimension")),
            (Length, Number(length.round())),
        ],
    );
    svg.open(
        Tag::G,
        &[(Stroke, Token("#67777c")), (StrokeWidth, Number(10.))],
    );
    line(svg, axis.at(0., offset), axis.at(axis.length, offset));
    for along in [0., axis.length] {
        line(
            svg,
            axis.at(along, offset - 65.),
            axis.at(along, offset + 65.),
        )
    }
    svg.close();
    let angle = axis.text_angle();
    let middle = axis.at(axis.length / 2., offset);
    let label = ScreenPoint::from(Point {
        x: middle.x,
        y: middle.y + 40.,
    });
    svg.text(
        Tag::Text,
        &[
            (
                Class,
                Token(if outer {
                    "outer-dimension"
                } else {
                    "dimension-label"
                }),
            ),
            (Anchor, Token("middle")),
            (Transform, Value::Rotate(angle, middle.into())),
            (X, label.x()),
            (Y, label.y()),
            (FontSize, Number(if outer { 175. } else { 140. })),
        ],
        &format_mm(length),
    );
    svg.close();
}
fn hidden_dimensions(svg: &mut Svg, id: &str, dimensions: impl IntoIterator<Item = Dimension>) {
    svg.open(
        Tag::G,
        &[
            (Class, Token("dimensions")),
            (DimensionsFor, Id(id)),
            (Display, Token("none")),
            (Stroke, Token(PAPER)),
            (StrokeWidth, Number(20.)),
            (PaintOrder, Token("stroke fill")),
        ],
    );
    for dim in dimensions {
        dimension(svg, dim, false);
    }
    svg.close();
}
fn draw(id: &StoreyId, scene: &Scene) -> FloorPlanSvg {
    let mut svg = Svg::default();
    let Extent { min, max } = scene.extent();
    let margin = 1200.;
    let corner = ScreenPoint::from(Point {
        x: min.x - margin,
        y: max.y + margin,
    });
    let (w, h) = (max.x - min.x + 2. * margin, max.y - min.y + 2. * margin);
    svg.open(
        Tag::Svg,
        &[
            (Xmlns, Token("http://www.w3.org/2000/svg")),
            (ViewBox, Value::ViewBox(corner, w, h)),
            (Storey, Id(id.as_str())),
            (Class, Token("floor-plan")),
            (
                FontFamily,
                Token("'Hiragino Sans','Noto Sans JP',sans-serif"),
            ),
            (Fill, Token(INK)),
        ],
    );
    svg.leaf(
        Tag::Rect,
        &[
            (Class, Token("background")),
            (X, corner.x()),
            (Y, corner.y()),
            (Width, Number(w)),
            (Height, Number(h)),
            (Fill, Token(PAPER)),
        ],
    );
    group(&mut svg, "rooms");
    for room in &scene.rooms {
        draw_room(&mut svg, room);
    }
    svg.close();
    group(&mut svg, "walls");
    for wall in &scene.walls {
        let points: Vec<_> = wall
            .polygon
            .iter()
            .copied()
            .map(ScreenPoint::from)
            .collect();
        svg.leaf(
            Tag::Path,
            &[
                (Class, Token("wall")),
                (Element, Id(wall.id)),
                (D, Value::PolygonPath(&points)),
            ],
        )
    }
    svg.close();
    group(&mut svg, "openings");
    for opening in &scene.openings {
        draw_opening(&mut svg, opening);
    }
    svg.close();
    group(&mut svg, "element-dimensions");
    for room in &scene.rooms {
        hidden_dimensions(
            &mut svg,
            room.id,
            room.outline.edges().map(|axis| Dimension::new(axis, 250.)),
        )
    }
    for wall in &scene.walls {
        hidden_dimensions(&mut svg, wall.id, wall.dimensions);
    }
    svg.close();
    group(&mut svg, "outer-dimensions");
    if scene.wall_extent.is_some() {
        for (end, offset) in [
            (Point { x: max.x, y: min.y }, -450.),
            (Point { x: min.x, y: max.y }, 450.),
        ] {
            dimension(&mut svg, Dimension::new(Axis::new(min, end), offset), true);
        }
    }
    svg.close();
    svg.open(
        Tag::G,
        &[(Class, Token("north")), (Orientation, Token("provisional"))],
    );
    let north = |dx, dy| {
        ScreenPoint::from(Point {
            x: max.x + dx,
            y: max.y + dy,
        })
    };
    let arrow = [
        north(-90., 565.),
        north(0., 905.),
        north(90., 565.),
        north(0., 630.),
    ];
    svg.leaf(
        Tag::Path,
        &[
            (D, Value::PolygonPath(&arrow)),
            (Fill, Token("none")),
            (Stroke, Token(INK)),
            (StrokeWidth, Number(16.)),
            (Dash, Token("50 25")),
        ],
    );
    let at = north(0., 330.);
    svg.text(
        Tag::Text,
        &[
            (Anchor, Token("middle")),
            (X, at.x()),
            (Y, at.y()),
            (FontSize, Number(155.)),
        ],
        "北（仮）",
    );
    svg.close();
    let note = ScreenPoint::from(Point {
        x: min.x - margin + 140.,
        y: min.y - margin + 170.,
    });
    svg.text(
        Tag::Text,
        &[
            (Class, Token("tatami-note")),
            (X, note.x()),
            (Y, note.y()),
            (FontSize, Number(140_f64.min((w - 280.) / 24.))),
        ],
        &format!("畳数は内法面積を{TATAMI_SQUARE_METRES} m²で割った参考値"),
    );
    svg.finish()
}
