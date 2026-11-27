use super::{BuildError, Model};
use madori_housing::{House, ReadError};
use std::{error::Error, fmt};

#[derive(Debug)]
pub enum LoadError {
    House(ReadError),
    Build(BuildError),
}

impl fmt::Display for LoadError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::House(error) => error.fmt(f),
            Self::Build(error) => error.fmt(f),
        }
    }
}

impl Error for LoadError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::House(error) => Some(error),
            Self::Build(error) => Some(error),
        }
    }
}

impl Model {
    pub fn load(snapshot: &str) -> Result<(House, Model), LoadError> {
        let house = House::from_json(snapshot).map_err(LoadError::House)?;
        let model = Self::build(&house).map_err(LoadError::Build)?;
        Ok((house, model))
    }
}
