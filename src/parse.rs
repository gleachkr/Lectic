use crate::types::{
    LecticHeader,
    LecticBlock,
    LecticData,
};

use nom::{
  IResult,
  Parser,
  sequence::delimited,
  bytes::is_not,
  bytes::take_until,
  character::char,
  character::multispace0,
  multi::many0,
  branch::alt,
  combinator::rest,
  combinator::complete,
  bytes::tag
};

fn yaml_header(input: &str) -> IResult<&str, &str> {
  delimited(tag("---"), is_not("---"), tag("---")).parse(input)
}

fn div_open(input: &str) -> IResult<&str, &str> {
    let (input, _) = tag(":::")
        .and(many0(char(':')))
        .parse(input)?;
    let (input, name) = is_not(":\n").parse(input)?; //captures whitespace
    let (input, _) = many0(char(':'))
        .and(multispace0())
        .parse(input)?;
    Ok((input,name.trim())) //trims whitespace
}

fn named_div<'a>(input: &'a str) -> IResult<&'a str, LecticBlock<'a>> {
    let (input, name) = div_open(input)?;
    let (input, content) = take_until(":::")
        .parse(input)?;
    let (input, _) = tag(":::")
        .and(many0(char(':')))
        .parse(input)?;
    Ok((input, LecticBlock::InterlocBlock{ name, content}))
}

fn user_chunk(input: &str) -> IResult<&str, LecticBlock> {
    let (input, content) = alt((complete(take_until(":::")), rest)).parse(input)?;
    Ok((input, LecticBlock::UserBlock{content}))
}

fn lectic_body(input: &str) -> IResult<&str, Vec<LecticBlock>> {
    many0(complete(alt((named_div, user_chunk)))).parse(input)
}

fn get_header(lectic_str : &str) -> Result<(LecticHeader, &str), String> {
    match yaml_header(lectic_str) {
        Ok((input, the_match)) => {
            match serde_yaml::from_str::<LecticHeader>(the_match) {
                Ok(header) => Ok((header, input)),
                Err(e) => Err(format!("couldn't parse yaml!: {}", e).to_string())
            }
        },
        Err(_) => Err("Couldn't locate YAML header!".to_string())
    }
}

fn get_body(lectic_str : &str) -> Result<Vec<LecticBlock>, String> {
    match lectic_body(&lectic_str) {
        Ok((_, body)) => Ok(body),
        Err(e) => Err(format!("Couldn't read div content: {}", e))
    }
}

pub fn parse(lectic_str : &str) -> Result<LecticData, String> {

    let (header, lectic_str) = get_header(lectic_str)?;

    let body = get_body(lectic_str)?;

    let body = body
        .into_iter()
        .filter(|block| block.is_nonempty())
        .collect();

    Ok(LecticData { body, header })
}
