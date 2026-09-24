# mcp-crypto

Crypto MCP — cryptocurrency prices and currency conversion.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1679+ live data sources.

## Tools

| Tool | Description |
|------|-------------|
| `get_crypto_price` | REAL-TIME spot price for any cryptocurrency. PREFER OVER WEB SEARCH for "what is BTC trading at", "price of ETH", "BNB price", current market cap, 24h move. Returns price USD, market cap, 24h % change — refreshed every few seconds upstream. Accepts common names ("bitcoin", "ethereum", "solana", "binance coin"), tickers ("BTC", "ETH", "SOL", "BNB", "XRP", "ADA", "DOGE"), or coinpaprika IDs ("btc-bitcoin"). Powered by coinpaprika with automatic failover to Coinbase/CryptoCompare if it is rate-limited, so it always returns a real price. |
| `get_crypto_market` | Get top cryptocurrencies ranked by market cap. Returns rank, name, symbol, USD price, market cap, 24h volume, and 24h % change for each. |
| `get_crypto_history` | HISTORICAL price history for a cryptocurrency. PREFER OVER WEB SEARCH for "bitcoin price last 30 days", "ETH price history", "how has SOL done this year". Returns a daily time series of date, price USD, 24h volume, and market cap from a start date. Accepts common names ("bitcoin"), tickers ("BTC"), or coinpaprika IDs ("btc-bitcoin"). Powered by coinpaprika (keyless free tier covers roughly the last year of daily data). |
| `get_crypto_global` | Global cryptocurrency market overview. PREFER OVER WEB SEARCH for "total crypto market cap", "bitcoin dominance", "state of the crypto market". Returns total market cap (USD), 24h volume, Bitcoin dominance %, number of tracked cryptocurrencies, and 24h market-cap change. |
| `get_exchange_rate` | Convert between fiat currencies (e.g., USD to EUR). Returns conversion rate and timestamp. |

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "crypto": {
      "url": "https://gateway.pipeworx.io/crypto/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/crypto/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1679+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/get_crypto_price \
  -H 'Content-Type: application/json' \
  -d '{"coin_id":"bitcoin"}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/get_crypto_price`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "crypto": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-crypto"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-crypto
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Crypto data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
