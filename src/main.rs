use clap::Parser;
use std::{fs, path::PathBuf};
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
            let _ = handle::handle(lectic_data)
                .expect("chat handling failed");
        }
        Err(e) => {
            println!("Can't read file {}", e)
        }
    }

}

