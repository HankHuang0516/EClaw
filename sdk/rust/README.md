# EClaw Rust SDK

Auto-generated Rust client for the [EClaw Platform API](https://eclawbot.com/api/docs).

## Installation

Add to your `Cargo.toml`:

```toml
[dependencies]
eclaw = { git = "https://github.com/HankHuang0516/eclaw-sdk-rust" }
```

## Quick Start

```rust
use eclaw::apis::configuration::Configuration;
use eclaw::apis::health_api;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut config = Configuration::new();
    config.base_path = "https://eclawbot.com".to_string();

    // Health check
    let health = health_api::get_health(&config).await?;
    println!("Server status: {:?}", health.status);

    Ok(())
}
```

## Authentication

EClaw uses three authentication methods:
- **DeviceSecret**: For device owner operations
- **BotSecret**: For bot operations
- **Bearer Token**: For OAuth 2.0 authenticated requests

## Regenerating

```bash
# From project root
./sdk/generate.sh rust
```

Requires [OpenAPI Generator](https://openapi-generator.tech/docs/installation/).

## API Reference

See the full [interactive API docs](https://eclawbot.com/api/docs).
