# x402-vietqr

An x402 endpoint that lets an AI agent pay any VietQR code in Vietnam with USDC. The agent pays in test USDC on Stellar testnet or Base Sepolia. The server then settles the amount in VND to the bank account inside the QR through the Gaian sandbox API.

Everything here runs on testnets and a sandbox. No real money moves.

## Why

Most shops, homestays and tour guides in Vietnam take payment by VietQR, the national bank QR standard. They do not accept crypto, so an agent that holds USDC cannot pay them directly.

x402 gives the agent a standard way to pay for an HTTP request: the server answers `402 Payment Required`, the agent signs a USDC payment, and the server settles it. This project puts a VietQR payout behind that 402. The agent pays USDC, and the merchant receives VND in a normal bank account. The merchant does not need a wallet or any new software.

The demo story is a travel agent. A user asks Claude for "2 nights in Da Lat, somewhere quiet, budget 40 USD". Claude searches a demo catalogue, checks the budget, and pays the homestay's VietQR.

## How a payment works

1. The agent asks for a quote with `POST /v1/quote` and the QR string. The server reads the QR, prices the VND amount in USDC and returns a quote ID. Nothing moves.
2. The agent checks the quote against its limits (see below). If any limit fails, it stops here.
3. The agent calls `POST /v1/pay?quoteId=...`. The server answers 402 with the exact quoted price on Stellar testnet and, if configured, Base Sepolia.
4. The agent signs an x402 payment. The server uses the x402 "authorization" flow. It verifies the signed payment first, then reserves the payout order, and only then settles the agent's payment on chain. If the reservation fails, settlement is cancelled and the agent keeps its USDC.
5. After settlement succeeds, a treasury wallet funds the Gaian order in USDC, and Gaian sends VND to the account in the QR.
6. The agent follows the order with `GET /v1/orders/:id` until it is `completed` or `failed`.

The order of steps 4 and 5 is the main design choice. Money only leaves the agent after a payout order exists, and the payout is only funded after the agent's payment has settled.

## Spend limits

An agent with a wallet needs hard limits that do not depend on the model behaving well. There are three, and each one is checked in code.

- **User budget per session.** The agent adds up what it has paid in the session and refuses any payment that would go over the budget the user gave. Payments run one at a time, so two parallel tool calls cannot both pass the check.
- **Maximum per order (default 50 USD).** This is checked in three places: by the agent before it signs, by the x402 client's spend controls, and by the server when it creates the quote.
- **Pay only the quote, only to a known recipient.** The agent signs only if the amount in the 402 response is not above the quoted amount and the `payTo` address is on its trusted list. A server that changes the price or the recipient after the quote gets no signature.

Two more rules sit on the quote itself:

- A quote can be paid once. A second payment on the same quote returns HTTP 409.
- A quote expires after 5 minutes (`QUOTE_TTL_SECONDS`). After that, payment returns HTTP 410.

## Mock and sandbox modes

| | `GAIAN_MODE=mock` (default) | `GAIAN_MODE=sandbox` |
|---|---|---|
| x402 payment on Stellar testnet | real (testnet) | real (testnet) |
| VND to USDC price | demo rate, 26,300 VND per USDC, no fee | Gaian sandbox quote |
| Payout order and VND transfer | simulated, reports `completed` after 3 seconds | Gaian sandbox |
| Beneficiary name | "DEMO MERCHANT" | name Gaian reads from the QR |

Mock mode needs no API keys. It is the mode used for the tests and the recorded demo run.

## Run it

You need Node 20 or later.

```bash
git clone https://github.com/KhaTruong123/x402-vietqr.git
cd x402-vietqr
npm ci
npm test                # 21 tests
npm run setup:testnet   # creates throwaway Stellar testnet wallets and writes them to .env
npm run demo            # search, budget check, x402 payment, order tracking, replay check
```

`setup:testnet` gets XLM from Friendbot, swaps it for test USDC on the Stellar testnet DEX, and saves the wallet secrets to `.env`. It never prints them. `.env` is gitignored. Use testnet wallets only.

To try sandbox mode, copy `.env.example` to `.env`, set `GAIAN_MODE=sandbox`, and fill in your own Gaian sandbox API key and secret plus a sandbox user that has passed KYC. The API is described at https://developer.gaian.network.

## Use it from Claude Desktop

The project includes an MCP server, so Claude Desktop (or any MCP client) can act as the travel agent.

1. Start the API with `npm run server` and keep it running.
2. Add this to `claude_desktop_config.json`, with the paths changed to where you cloned the repo:

```json
{
  "mcpServers": {
    "x402-vietqr": {
      "command": "/path/to/x402-vietqr/node_modules/.bin/tsx",
      "args": ["/path/to/x402-vietqr/src/mcp.ts"]
    }
  }
}
```

3. Restart Claude Desktop and ask: "Find me a homestay in Hoi An for 2 nights, budget 45 USD, and pay if one fits."

The MCP server has three tools:

- `find_places` searches by city, kind (homestay or tour), nights, VND budget and tags.
- `pay_place` pays for one place and needs `budgetUsd`. It refuses if the price is over the budget or over the per-order limit.
- `get_order` returns an order's status.

## API

| Route | Paid | What it does |
|---|---|---|
| `GET /health` | no | Gaian mode and accepted networks |
| `GET /v1/places?city=&kind=&nights=&maxTotalVnd=&tags=` | no | search the demo catalogue |
| `POST /v1/quote {qrString, amountVnd?}` | no | USDC quote for any VietQR string |
| `POST /v1/pay?quoteId=` | yes, x402 | pay a quote on Stellar testnet or Base Sepolia |
| `GET /v1/orders/:id` | no | order status: reserved, funding, processing, completed, failed |

## Evidence

- [docs/evidence/test-run-2026-10-25.txt](docs/evidence/test-run-2026-10-25.txt): full `npm test` and `npm run typecheck` output, 21 of 21 tests passing.
- [docs/evidence/testnet-demo-2026-10-25.txt](docs/evidence/testnet-demo-2026-10-25.txt): an end-to-end run on Stellar testnet. The agent paid 34.23 test USDC for a 900,000 VND booking in transaction [6a80f42a...](https://stellar.expert/explorer/testnet/tx/6a80f42a572890a10ef7ba696031c7b99dbb2c57eebee035d7bd730037f91df7). A replay of the same quote was refused with HTTP 409.

## Limits

- **Testnet and sandbox only.** Do not point it at mainnet. The code has not had a security review.
- **Sandbox payout is not proven yet.** The sandbox code path is written (read QR, quote, place order, fund the order, verify, poll status), but it has not completed a full run. It needs a sandbox user that has passed KYC.
- **Base Sepolia payment is not proven yet.** The server offers Base in its 402 response, and a test checks that. No agent wallet with Base test USDC was used, because Circle's faucet cannot be scripted. To try it, fund a wallet at https://faucet.circle.com and set `AGENT_EVM_PRIVATE_KEY`.
- **The treasury signs Gaian's funding transaction without checking it.** In sandbox mode, `src/payout.ts` signs the transaction Gaian returns with the treasury key and submits it. It does not first check the amount, the asset or the destination. Before any use outside a sandbox, the server must decode that transaction and refuse to sign unless it sends the quoted USDC amount to the order's deposit address.
- **There is no automatic refund.** If funding the Gaian order fails after the agent's payment has settled, the order is marked `failed` and the agent's USDC stays in the `payTo` wallet. Someone has to send it back by hand.
- **State lives in memory.** Quotes, orders and the session budget reset when the process restarts. A real deployment needs a database and a lock around quote use.
- **The catalogue is fake.** The 10 places, their bank accounts and their QR codes are made up for testing. The QR codes are valid VietQR strings that point at fake accounts.
- **Runs locally only.** It has not been deployed anywhere.

## Project layout

- `src/server.ts`: HTTP API and the x402 middleware.
- `src/payout.ts`: quote, order reservation, and funding after settlement.
- `src/gaian/client.ts`: Gaian API v2 client with HMAC request signing.
- `src/vietqr.ts`: builds VietQR strings and checks their CRC.
- `src/places.ts`: the demo catalogue.
- `src/agent/pay.ts`: the agent side, with the x402 client and the spend limits.
- `src/mcp.ts`: MCP server for Claude Desktop.
- `scripts/setup-testnet.ts` and `scripts/demo.ts`: wallet setup and the end-to-end run.

## License

MIT. See [LICENSE](LICENSE).
