/**
 * Crypto MCP — cryptocurrency prices and currency conversion
 *
 * Tools:
 * - get_crypto_price: single cryptocurrency price (CoinGecko)
 * - get_crypto_market: top cryptocurrencies by market cap (CoinGecko)
 * - get_exchange_rate: currency exchange rates (ExchangeRate API)
 */

interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
}

const COINGECKO = 'https://api.coingecko.com/api/v3';

const tools: McpToolExport['tools'] = [
  {
    name: 'get_crypto_price',
    description:
      'Get the current price, market cap, and 24h change for a cryptocurrency. Use CoinGecko IDs (e.g., "bitcoin", "ethereum", "solana").',
    inputSchema: {
      type: 'object',
      properties: {
        coin_id: {
          type: 'string',
          description: 'CoinGecko coin ID (e.g., bitcoin, ethereum, solana)',
        },
      },
      required: ['coin_id'],
    },
  },
  {
    name: 'get_crypto_market',
    description: 'Get top cryptocurrencies by market cap with prices and 24h changes',
    inputSchema: {
      type: 'object',
      properties: {
        vs_currency: {
          type: 'string',
          description: 'Quote currency (default: usd)',
        },
        limit: {
          type: 'number',
          description: 'Number of coins (1-100, default 10)',
        },
      },
    },
  },
  {
    name: 'get_exchange_rate',
    description: 'Get the exchange rate between two fiat currencies',
    inputSchema: {
      type: 'object',
      properties: {
        from: {
          type: 'string',
          description: 'Source currency code (e.g., USD, EUR, GBP)',
        },
        to: {
          type: 'string',
          description: 'Target currency code (e.g., EUR, JPY, GBP)',
        },
        amount: {
          type: 'number',
          description: 'Amount to convert (default: 1)',
        },
      },
      required: ['from', 'to'],
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'get_crypto_price': {
      const coinId = (args.coin_id as string).toLowerCase();
      const res = await fetch(
        `${COINGECKO}/coins/${encodeURIComponent(coinId)}?localization=false&tickers=false&community_data=false&developer_data=false`,
      );
      if (!res.ok) throw new Error(`CoinGecko error: ${res.status}`);
      const data = (await res.json()) as {
        id: string;
        name: string;
        symbol: string;
        market_data: {
          current_price: Record<string, number>;
          market_cap: Record<string, number>;
          price_change_percentage_24h: number;
          total_volume: Record<string, number>;
          high_24h: Record<string, number>;
          low_24h: Record<string, number>;
        };
      };
      const md = data.market_data;
      return {
        id: data.id,
        name: data.name,
        symbol: data.symbol.toUpperCase(),
        price_usd: md.current_price.usd,
        market_cap_usd: md.market_cap.usd,
        volume_24h_usd: md.total_volume.usd,
        change_24h_pct: md.price_change_percentage_24h,
        high_24h_usd: md.high_24h.usd,
        low_24h_usd: md.low_24h.usd,
      };
    }

    case 'get_crypto_market': {
      const currency = ((args.vs_currency as string) ?? 'usd').toLowerCase();
      const limit = Math.min(100, Math.max(1, (args.limit as number) ?? 10));
      const params = new URLSearchParams({
        vs_currency: currency,
        order: 'market_cap_desc',
        per_page: String(limit),
        page: '1',
        sparkline: 'false',
      });
      const res = await fetch(`${COINGECKO}/coins/markets?${params}`);
      if (!res.ok) throw new Error(`CoinGecko error: ${res.status}`);
      const data = (await res.json()) as {
        id: string;
        name: string;
        symbol: string;
        current_price: number;
        market_cap: number;
        market_cap_rank: number;
        total_volume: number;
        price_change_percentage_24h: number;
      }[];
      return {
        currency,
        coins: data.map((c) => ({
          rank: c.market_cap_rank,
          id: c.id,
          name: c.name,
          symbol: c.symbol.toUpperCase(),
          price: c.current_price,
          market_cap: c.market_cap,
          volume_24h: c.total_volume,
          change_24h_pct: c.price_change_percentage_24h,
        })),
      };
    }

    case 'get_exchange_rate': {
      const from = (args.from as string).toUpperCase();
      const to = (args.to as string).toUpperCase();
      const amount = (args.amount as number) ?? 1;
      const res = await fetch(
        `https://open.er-api.com/v6/latest/${encodeURIComponent(from)}`,
      );
      if (!res.ok) throw new Error(`ExchangeRate API error: ${res.status}`);
      const data = (await res.json()) as {
        result: string;
        rates: Record<string, number>;
        time_last_update_utc: string;
      };
      if (data.result !== 'success') throw new Error(`ExchangeRate: ${data.result}`);
      const rate = data.rates[to];
      if (rate === undefined) throw new Error(`Unknown currency: ${to}`);
      return {
        from,
        to,
        rate,
        amount,
        converted: Math.round(amount * rate * 100) / 100,
        last_updated: data.time_last_update_utc,
      };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool } satisfies McpToolExport;
