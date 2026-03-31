# mcp-crypto

Crypto MCP — cryptocurrency prices and currency conversion

Part of the [Pipeworx](https://pipeworx.io) open MCP gateway.

## Tools

| Tool | Description |
|------|-------------|
| `get_crypto_market` | Get top cryptocurrencies by market cap with prices and 24h changes |
| `get_exchange_rate` | Get the exchange rate between two fiat currencies |

## Quick Start

Add to your MCP client config:

```json
{
  "mcpServers": {
    "crypto": {
      "url": "https://gateway.pipeworx.io/crypto/mcp"
    }
  }
}
```

Or use the CLI:

```bash
npx pipeworx use crypto
```

## License

MIT
