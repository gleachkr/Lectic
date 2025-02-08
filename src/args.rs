use clap::Parser;
use std::path::PathBuf;

#[derive(Parser, Debug)]
#[command(version, about, long_about = None)]
pub struct Args {
    /// Lectic to process, or '-' for stdin
    #[arg(default_value="-")]
    pub lectic: PathBuf,

    #[arg(long, short)]
    pub verbose: bool,
}
