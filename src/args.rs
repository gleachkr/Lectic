use clap::Parser;
use std::path::PathBuf;

#[derive(Parser, Debug)]
#[command(version, about, long_about = None)]
pub struct Args {
    /// Lectic to process, or '-' for stdin
    #[arg(default_value="-")]
    pub lectic: PathBuf,

    /// Return only the response rather than the updated lectic
    #[arg(long, short)]
    pub short: bool,
}
