# @pipeworx/mcp-crypto

MCP server for cryptocurrency data — prices, market caps, and exchange rates.

## Tools

| Tool | Description |
|------|-------------|
| `get_crypto_price` | Get current price, market cap, and 24h change for a cryptocurrency |
| `get_crypto_market` | Get top cryptocurrencies by market cap |
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

Or run via CLI:

```bash
npx pipeworx use crypto
```

## License

MIT
