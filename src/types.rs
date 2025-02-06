use serde_derive::Deserialize;
use serde_derive::Serialize;

#[derive(Debug, PartialEq, Serialize, Deserialize)]
pub struct Interlocutor {
    pub name : String,
    pub prompt : String,
}

#[derive(Debug, PartialEq, Serialize, Deserialize)]
pub struct LecticHeader {
    pub interlocutor : Interlocutor,
}

pub struct LecticData<'a> {
    pub header : LecticHeader,
    pub body : Vec<LecticBlock<'a>>,
}

#[derive(Debug)]
pub enum LecticBlock<'a> {
    InterlocBlock{ name : &'a str, content : &'a str},
    UserBlock{ content: &'a str},
}

impl LecticBlock<'_> {

    pub fn content(&self) -> &str{
        match self {
            Self::InterlocBlock{name : _, content} => content,
            Self::UserBlock{content} => content,
        }
    }

    pub fn is_empty(&self) -> bool {
         self.content()
             .chars()
             .all(char::is_whitespace)
    }

    pub fn is_nonempty(&self) -> bool {
         !self.is_empty()
    }
}
