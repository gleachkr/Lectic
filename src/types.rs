use serde_derive::Deserialize;
use serde_derive::Serialize;
use llm::{
    chat::{ChatMessage, ChatRole},     // Chat-related structures
};

#[derive(Debug, PartialEq, Serialize, Deserialize)]
pub struct Interlocutor {
    pub name : String,
    pub prompt : String,
    pub temperature : Option<u8>,
    pub token_limit: Option<u32>,
}

#[derive(Debug, PartialEq, Serialize, Deserialize)]
pub struct LecticHeader {
    pub interlocutor : Interlocutor,
}

pub struct LecticData<'a> {
    pub header : LecticHeader,
    pub body : Vec<LecticBlock<'a>>,
}

impl LecticData<'_> {
    pub fn as_chat(blocks : &Vec<LecticBlock>) -> Vec<ChatMessage> {
        blocks.into_iter().map(|b| b.to_msg()).collect()
    }

    pub fn get_prompt(&self) -> String {
        format!(r#"Your name is {}.
{}

You should use unicode symbols instead of LaTeX for mathematical notation.

You must line wrap at approximately 78 characters unless this harms readability.
"#,
            self.header.interlocutor.name,
            self.header.interlocutor.prompt
        )
    }

    pub fn get_temp(&self) -> f32 {
        match self.header.interlocutor.temperature {
            None => 0.7,
            Some(temp) => temp as f32 / 255.0
        }
    }

    pub fn get_token_limit(&self) -> u32 {
        match self.header.interlocutor.token_limit {
            None => 512,
            Some(limit) => limit,
        }
    }
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

    fn to_msg(&self) -> ChatMessage {
        match self {
            LecticBlock::InterlocBlock{content,..} => ChatMessage {
                role: ChatRole::Assistant, 
                content: content.to_string(),
            },
            LecticBlock::UserBlock{content} => ChatMessage {
                role: ChatRole::User,
                content: content.to_string(),
            },
        }
    }
}
