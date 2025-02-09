use std::{fs, process, io, io::Read};
use clap::Parser;
use lectic::parse;
use lectic::handle;
use lectic::args::Args;

fn process_lectic(args: Args, lectic_str : String) {
    let lectic_data = parse::parse(&lectic_str)
        .expect("data parsing failed");
    match handle::handle(&args, lectic_data) {
        Ok(rslt) => {
            if args.short {
                print!("{}", rslt);
            } else {
                print!("{}\n\n{}", lectic_str.trim(), rslt);
            }
        }
        Err(e) => {
            eprintln!("Chat error: {}", e);
            process::exit(1)
        }
    }
}

fn from_stdin(args: Args) {
    let mut lectic_str = String::new();
    match io::stdin().read_to_string(&mut lectic_str) {
        Ok(_) => process_lectic(args, lectic_str),
        Err(e) => {
            println!("Can't read from stdin: {}", e)
        }
    }
}

fn from_file(args : Args) {
    match fs::read_to_string(&args.lectic) {
        Ok(lectic_str) => process_lectic(args, lectic_str),
        Err(e) => {
            println!("Can't read file: {}", e)
        }
    }
}

fn main() {
    let args = Args::parse();

    match args.lectic.to_str() {
        Some("-") => from_stdin(args),
        _ => from_file(args),
    }
}

