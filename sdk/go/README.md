# EClaw Go SDK

Auto-generated Go client for the [EClaw Platform API](https://eclawbot.com/api/docs).

## Installation

```bash
go get github.com/HankHuang0516/eclaw-sdk-go
```

## Quick Start

```go
package main

import (
    "context"
    "fmt"
    eclaw "github.com/HankHuang0516/eclaw-sdk-go"
)

func main() {
    cfg := eclaw.NewConfiguration()
    cfg.Servers = eclaw.ServerConfigurations{
        {URL: "https://eclawbot.com"},
    }
    client := eclaw.NewAPIClient(cfg)

    // Health check
    health, _, err := client.HealthAPI.GetHealth(context.Background()).Execute()
    if err != nil {
        panic(err)
    }
    fmt.Printf("Server status: %s\n", health.GetStatus())

    // Send message to entity
    resp, _, err := client.CommunicationAPI.ClientSpeak(context.Background()).Body(eclaw.ClientSpeakRequest{
        DeviceId:     "your-device-id",
        DeviceSecret: "your-device-secret",
        EntityId:     0,
        Text:         "Hello from Go SDK!",
    }).Execute()
    if err != nil {
        panic(err)
    }
    fmt.Printf("Sent: %v\n", resp.GetSuccess())
}
```

## Authentication

EClaw uses three authentication methods:
- **DeviceSecret**: For device owner operations (passed as query/body param)
- **BotSecret**: For bot operations (passed as query/body param)
- **Bearer Token**: For OAuth 2.0 authenticated requests

## Regenerating

```bash
# From project root
./sdk/generate.sh go
```

Requires [OpenAPI Generator](https://openapi-generator.tech/docs/installation/).

## API Reference

See the full [interactive API docs](https://eclawbot.com/api/docs).
