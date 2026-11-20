use crate::{data::*, error::*, id::*, topology::Index};

#[derive(Debug)]
pub struct House {
    data: HouseData,
    index: Index,
}

impl PartialEq for House {
    fn eq(&self, other: &Self) -> bool {
        self.data == other.data
    }
}

impl House {
    pub fn new(data: HouseData) -> Result<Self, Rejections> {
        let index = Index::build(&data)?;
        Ok(Self { data, index })
    }

    pub fn data(&self) -> &HouseData {
        &self.data
    }

    pub fn into_data(self) -> HouseData {
        self.data
    }

    fn vertex(&self, id: &VertexId) -> Option<VertexView<'_>> {
        let data = self.data.vertices.get(*self.index.vertices.get(id)?)?;
        Some(VertexView { house: self, data })
    }

    pub fn boundary(&self, id: &BoundaryId) -> Option<BoundaryView<'_>> {
        let data = self.data.boundaries.get(*self.index.boundaries.get(id)?)?;
        self.boundary_view(data)
    }

    fn boundary_view<'a>(&'a self, data: &'a Boundary) -> Option<BoundaryView<'a>> {
        Some(BoundaryView {
            house: self,
            data,
            start: self.vertex(&data.start)?,
            end: self.vertex(&data.end)?,
        })
    }

    pub fn boundaries(&self) -> impl Iterator<Item = BoundaryView<'_>> {
        self.data
            .boundaries
            .iter()
            .filter_map(|row| self.boundary_view(row))
    }

    pub fn room(&self, id: &RoomId) -> Option<RoomView<'_>> {
        let (row, storey) = self.index.rooms.get(id)?;
        Some(RoomView {
            house: self,
            data: self.data.rooms.get(*row)?,
            storey,
        })
    }

    pub fn rooms(&self) -> impl Iterator<Item = RoomView<'_>> {
        self.data
            .rooms
            .iter()
            .filter_map(|data| self.room(&data.id))
    }
}

#[derive(Clone, Copy, Debug)]
pub struct VertexView<'a> {
    house: &'a House,
    data: &'a Vertex,
}

impl<'a> VertexView<'a> {
    pub fn data(self) -> &'a Vertex {
        self.data
    }
    pub fn boundaries(self) -> impl Iterator<Item = BoundaryView<'a>> {
        self.house
            .index
            .incident
            .get(&self.data.id)
            .into_iter()
            .flatten()
            .filter_map(move |&i| self.house.boundary_view(self.house.data.boundaries.get(i)?))
    }
}

#[derive(Clone, Copy, Debug)]
pub struct BoundaryView<'a> {
    house: &'a House,
    data: &'a Boundary,
    start: VertexView<'a>,
    end: VertexView<'a>,
}

impl<'a> BoundaryView<'a> {
    pub fn data(self) -> &'a Boundary {
        self.data
    }
    pub fn start(self) -> VertexView<'a> {
        self.start
    }
    pub fn end(self) -> VertexView<'a> {
        self.end
    }
    pub fn room(self, side: Side) -> Option<RoomView<'a>> {
        let row = self
            .house
            .index
            .sides
            .get(&self.data.id)?
            .get(side)
            .first()?;
        self.house.room(&self.house.data.rooms.get(*row)?.id)
    }
    pub fn rooms(self) -> impl Iterator<Item = RoomView<'a>> {
        [Side::Left, Side::Right]
            .into_iter()
            .filter_map(move |side| self.room(side))
    }
    pub fn face(self, side: Side) -> Face<'a> {
        self.room(side).map_or(Face::Exterior, Face::Room)
    }
    pub fn openings(self) -> impl Iterator<Item = &'a Opening> {
        self.house
            .index
            .openings
            .get(&self.data.id)
            .into_iter()
            .flatten()
            .filter_map(move |&i| self.house.data.openings.get(i))
    }
}

#[derive(Clone, Copy, Debug)]
pub enum Face<'a> {
    Room(RoomView<'a>),
    Exterior,
}

#[derive(Clone, Copy, Debug)]
pub struct RoomView<'a> {
    house: &'a House,
    data: &'a Room,
    storey: &'a StoreyId,
}

impl<'a> RoomView<'a> {
    pub fn data(self) -> &'a Room {
        self.data
    }
    pub fn storey(self) -> &'a StoreyId {
        self.storey
    }

    pub fn edges(self) -> impl Iterator<Item = EdgeView<'a>> {
        self.data.edges.iter().filter_map(move |edge| {
            let boundary = self.house.boundary(&edge.boundary)?;
            let offsets = boundary.data.wall.offsets;
            let (from, to) = edge
                .direction
                .orient(boundary.start.data.at, boundary.end.data.at);
            let inset = match edge.direction.side() {
                Side::Left => offsets.left,
                Side::Right => offsets.right,
            };
            Some(EdgeView {
                boundary,
                direction: edge.direction,
                from,
                to,
                inset,
            })
        })
    }
}

#[derive(Clone, Copy, Debug)]
pub struct EdgeView<'a> {
    pub boundary: BoundaryView<'a>,
    pub direction: Direction,
    pub from: Point,
    pub to: Point,
    pub inset: f64,
}
