use clap::Parser;
use std::path::PathBuf;

#[derive(Parser, Debug)]
#[command(version, about, long_about = None)]
pub struct Args {
    /// Lectic to process
    #[arg()]
    pub lectic: PathBuf,
}
