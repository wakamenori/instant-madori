use madori_housing::*;

pub type Corners = (i32, i32, i32, i32);
pub fn point(x: i32, y: i32) -> Point {
    Point {
        x: f64::from(x),
        y: f64::from(y),
    }
}
pub fn layout(rooms: &[Corners]) -> RoomLayout {
    RoomLayout {
        walls: LayoutWalls {
            exterior_thickness: 200.0,
            interior_thickness: 120.0,
            height: 2400.0,
        },
        rooms: rooms
            .iter()
            .enumerate()
            .map(|(i, &(x, y, r, t))| LayoutRoom {
                name: if i == 0 {
                    "LDK".into()
                } else {
                    format!("洋室{i}")
                },
                usage: if i == 0 {
                    RoomUse::Ldk
                } else {
                    RoomUse::Bedroom
                },
                min: point(x, y),
                max: point(r, t),
            })
            .collect(),
    }
}
pub struct Xorshift(pub u64);

impl Xorshift {
    pub fn below(&mut self, limit: usize) -> usize {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        (self.0 % limit as u64) as usize
    }
}

fn split_rooms(rng: &mut Xorshift, bounds: Corners, depth: usize, rooms: &mut Vec<Corners>) {
    let (left, bottom, right, top) = bounds;
    let vertical = rng.below(2) == 0;
    let (low, high) = if vertical {
        (left, right)
    } else {
        (bottom, top)
    };
    if depth == 0 || high - low < 1200 || rng.below(4) == 0 {
        rooms.push(bounds);
        return;
    }
    let positions = (high - low - 1200) / 50 + 1;
    let cut = low + 600 + 50 * rng.below(positions as usize) as i32;
    let (a, b) = if vertical {
        ((left, bottom, cut, top), (cut, bottom, right, top))
    } else {
        ((left, bottom, right, cut), (left, cut, right, top))
    };
    split_rooms(rng, a, depth - 1, rooms);
    split_rooms(rng, b, depth - 1, rooms);
}

pub fn random_layout(rng: &mut Xorshift, thicknesses: &[(f64, f64)]) -> RoomLayout {
    let shifts = [0., 0.1, -3.3, 1234.567];
    let mut rooms = Vec::new();
    split_rooms(rng, (0, 0, 8000, 6000), 4, &mut rooms);
    for _ in 0..rng.below(3).min(rooms.len() - 1) {
        rooms.remove(rng.below(rooms.len()));
    }
    let mut input = layout(&rooms);
    let (ext, int) = thicknesses[rng.below(thicknesses.len())];
    input.walls.exterior_thickness = ext;
    input.walls.interior_thickness = int;
    let dx = shifts[rng.below(shifts.len())];
    let dy = shifts[rng.below(shifts.len())];
    for room in &mut input.rooms {
        for corner in [&mut room.min, &mut room.max] {
            corner.x += dx;
            corner.y += dy;
        }
    }
    let steps = [0., ext / 2., int / 2., ext, int, (ext + int) / 2.];
    for _ in 0..rng.below(4) {
        let index = rng.below(input.rooms.len());
        let room = &mut input.rooms[index];
        let edge = match rng.below(4) {
            0 => &mut room.min.x,
            1 => &mut room.min.y,
            2 => &mut room.max.x,
            _ => &mut room.max.y,
        };
        let step = steps[rng.below(steps.len())];
        *edge += if rng.below(2) == 0 { step } else { -step };
    }
    input
}
