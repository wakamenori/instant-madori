use super::FloorPlanSvg;
use madori_housing::Point;

macro_rules! names {
    ($name:ident { $($key:ident => $value:literal),+ $(,)? }) => {
        #[derive(Clone, Copy)]
        pub(super) enum $name { $($key),+ }
        impl $name {
            fn name(self) -> &'static str { match self { $(Self::$key => $value),+ } }
        }
    };
}
names!(Tag {
    Svg => "svg",
    Rect => "rect",
    G => "g",
    Path => "path",
    Line => "line",
    Polygon => "polygon",
    Text => "text",
    Tspan => "tspan",
});
names!(Attr {
    Xmlns => "xmlns",
    ViewBox => "viewBox",
    Storey => "data-storey-id",
    Class => "class",
    FontFamily => "font-family",
    Element => "data-element-id",
    Kind => "data-kind",
    DimensionsFor => "data-dimensions-for",
    Length => "data-length",
    Orientation => "data-orientation",
    Display => "display",
    Fill => "fill",
    Stroke => "stroke",
    StrokeWidth => "stroke-width",
    PaintOrder => "paint-order",
    Dash => "stroke-dasharray",
    FontSize => "font-size",
    Anchor => "text-anchor",
    Weight => "font-weight",
    X => "x",
    Y => "y",
    X1 => "x1",
    Y1 => "y1",
    X2 => "x2",
    Y2 => "y2",
    Width => "width",
    Height => "height",
    Points => "points",
    D => "d",
    Transform => "transform",
});

fn escape(value: &str, out: &mut String) {
    for ch in value.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            c if c.is_control() || matches!(c, '\u{fffe}' | '\u{ffff}') => out.push('\u{fffd}'),
            c => out.push(c),
        }
    }
}
fn number(n: f64) -> String {
    if !n.is_finite() {
        return "0".into();
    }
    let formatted = format!("{n:.3}");
    let trimmed = formatted.trim_end_matches('0').trim_end_matches('.');
    if trimmed == "-0" {
        "0".into()
    } else {
        trimmed.into()
    }
}
#[derive(Clone, Copy)]
pub(super) struct ScreenPoint {
    x: f64,
    y: f64,
}
impl From<Point> for ScreenPoint {
    fn from(p: Point) -> Self {
        Self { x: p.x, y: -p.y }
    }
}
impl ScreenPoint {
    fn pair(self) -> String {
        format!("{},{}", number(self.x), number(self.y))
    }
    pub(super) fn x(self) -> Value<'static> {
        Value::Number(self.x)
    }
    pub(super) fn y(self) -> Value<'static> {
        Value::Number(self.y)
    }
}
pub(super) enum Value<'a> {
    Token(&'static str),
    Id(&'a str),
    Number(f64),
    Points(&'a [ScreenPoint]),
    PolygonPath(&'a [ScreenPoint]),
    Arc {
        hinge: ScreenPoint,
        free: ScreenPoint,
        tip: ScreenPoint,
    },
    Rotate(f64, ScreenPoint),
    ViewBox(ScreenPoint, f64, f64),
}
impl Value<'_> {
    fn write(&self, out: &mut String) {
        let s = match *self {
            Self::Token(s) => return escape(s, out),
            Self::Id(s) => return escape(s, out),
            Self::Number(n) => number(n),
            Self::Points(points) => points
                .iter()
                .map(|p| p.pair())
                .collect::<Vec<_>>()
                .join(" "),
            Self::PolygonPath(points) => format!(
                "M{}Z",
                points
                    .iter()
                    .map(|p| p.pair())
                    .collect::<Vec<_>>()
                    .join(" L")
            ),
            Self::Rotate(angle, p) => format!("rotate({} {})", number(angle), p.pair()),
            Self::ViewBox(p, w, h) => format!(
                "{} {} {} {}",
                number(p.x),
                number(p.y),
                number(w),
                number(h)
            ),
            Self::Arc { hinge, free, tip } => {
                let (dx, dy) = (free.x - hinge.x, free.y - hinge.y);
                let r = number(dx.hypot(dy));
                let sweep = u8::from(dx * (tip.y - hinge.y) - dy * (tip.x - hinge.x) > 0.);
                format!("M{} A{r},{r} 0 0 {sweep} {}", free.pair(), tip.pair())
            }
        };
        escape(&s, out);
    }
}

#[derive(Default)]
pub(super) struct Svg {
    output: String,
    stack: Vec<Tag>,
}
impl Svg {
    fn start(&mut self, tag: Tag, attrs: &[(Attr, Value)]) {
        self.output.push('<');
        self.output.push_str(tag.name());
        for (attr, value) in attrs {
            self.output.push(' ');
            self.output.push_str(attr.name());
            self.output.push_str("=\"");
            value.write(&mut self.output);
            self.output.push('"');
        }
    }
    pub(super) fn open(&mut self, tag: Tag, attrs: &[(Attr, Value)]) {
        self.start(tag, attrs);
        self.output.push('>');
        self.stack.push(tag);
    }
    pub(super) fn leaf(&mut self, tag: Tag, attrs: &[(Attr, Value)]) {
        self.start(tag, attrs);
        self.output.push_str("/>");
    }
    pub(super) fn text(&mut self, tag: Tag, attrs: &[(Attr, Value)], value: &str) {
        self.open(tag, attrs);
        escape(value, &mut self.output);
        self.close();
    }
    pub(super) fn close(&mut self) {
        if let Some(tag) = self.stack.pop() {
            self.output.push_str("</");
            self.output.push_str(tag.name());
            self.output.push('>');
        }
    }
    pub(super) fn finish(mut self) -> FloorPlanSvg {
        while !self.stack.is_empty() {
            self.close()
        }
        FloorPlanSvg(self.output)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn xml_characters() {
        let mut out = String::new();
        escape("&<>\"'\0\t\n\r\u{7f}\u{81}\u{fffe}\u{ffff}", &mut out);
        assert_eq!(out, "&amp;&lt;&gt;&quot;&apos;��������");
    }
    #[test]
    fn closes_remaining_tags() {
        let mut svg = Svg::default();
        svg.open(Tag::Svg, &[]);
        svg.open(Tag::G, &[]);
        assert_eq!(svg.finish().as_str(), "<svg><g></g></svg>");
    }
}
