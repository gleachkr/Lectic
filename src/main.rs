use clap::Parser;
use std::{fs, process, path::PathBuf};
use lectic::parse;
use lectic::handle;

#[derive(Parser, Debug)]
#[command(version, about, long_about = None)]
struct Args {
    /// Lectic to process
    #[arg()]
    lectic: PathBuf,
}

fn main() {
    let args = Args::parse();

    match fs::read_to_string(args.lectic) {
        Ok(lectic_str) => {
            let lectic_data = parse::parse(&lectic_str)
                .expect("data parsing failed");
            match handle::handle(lectic_data) {
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

