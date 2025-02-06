use crate::types::LecticData;
use llm::{
    builder::{LLMBackend, LLMBuilder}, // Builder pattern components
};

#[tokio::main]
pub async fn handle(ld : LecticData) -> Result<(), Box<dyn std::error::Error>> {
    // Get Anthropic API key from environment variable or use test key as fallback
    let api_key = std::env::var("ANTHROPIC_API_KEY").unwrap_or("anthro-key".into());

    // Initialize and configure the LLM client
    let llm = LLMBuilder::new()
        .backend(LLMBackend::Anthropic) // Use Anthropic (Claude) as the LLM provider
        .api_key(api_key) // Set the API key
        .model("claude-3-5-sonnet-20240620") // Use Claude Instant model
        .max_tokens(512) // Limit response length
        .temperature(0.7) // Control response randomness (0.0-1.0)
        .system(ld.header.interlocutor.prompt)
        .build()
        .expect("Failed to build LLM (Anthropic)");

    match llm.chat(&LecticData::to_chat(&ld.body)).await {
        Ok(text) => {
            println!("::: {}\n\n{}\n\n:::", ld.header.interlocutor.name, text)
        }
        Err(e) => eprintln!("Chat error: {}", e),
    }

    Ok(())
}
