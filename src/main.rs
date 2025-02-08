use std::{fs, process};
use clap::Parser;
use lectic::parse;
use lectic::handle;
use lectic::args::Args;

fn main() {
    let args = Args::parse();

    match fs::read_to_string(&args.lectic) {
        Ok(lectic_str) => {
            let lectic_data = parse::parse(&lectic_str)
                .expect("data parsing failed");
            match handle::handle(&args, lectic_data) {
                Ok(rslt) => {
                    print!("{}", rslt);
                }
                Err(e) => {
                    eprintln!("Chat error: {}", e);
                    process::exit(1)
                }
            }
        }
        Err(e) => {
            println!("Can't read file {}", e)
        }
    }

}

