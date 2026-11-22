use crate::{BoundaryId, FaceRole, House, Rejections, Srgb, WallColor};

impl House {
    pub fn set_wall_color(
        &self,
        wall: &BoundaryId,
        face: &FaceRole,
        color: Srgb,
    ) -> Result<House, Rejections> {
        let side = self.index.resolve_face(self.data(), wall, face)?;
        let mut data = self.data().clone();
        if let Some(row) = self
            .index
            .colors
            .get(&(wall.clone(), side))
            .and_then(|&i| data.wall_colors.get_mut(i))
        {
            row.color = color;
        } else {
            data.wall_colors.push(WallColor {
                wall: wall.clone(),
                face: face.clone(),
                color,
            });
        }
        House::new(data)
    }

    pub fn clear_wall_color(
        &self,
        wall: &BoundaryId,
        face: &FaceRole,
    ) -> Result<House, Rejections> {
        self.index.resolve_face(self.data(), wall, face)?;
        let mut data = self.data().clone();
        data.wall_colors
            .retain(|row| &row.wall != wall || &row.face != face);
        House::new(data)
    }
}
