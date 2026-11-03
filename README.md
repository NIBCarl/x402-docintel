# x402-docintel

Document intelligence for AI agents, sold per call with the [x402](https://x402.org) payment protocol.
No API keys, no signup, no billing accounts — the buyer pays a few cents in USDC and gets JSON back.

## Why this exists

AI agents increasingly need to read documents but have no way to pay for a small API call.
x402 makes the HTTP `402 Payment Required` status a real paywall: the server quotes a price,
the client signs a stablecoin authorization, and a facilitator settles it on-chain.

This service is deliberately **deterministic** — every field is extracted with `unpdf` plus
regex, with **zero LLM calls**. That makes marginal cost per request effectively zero, so each
paid call is almost pure margin, and results are reproducible for a given PDF.

## Endpoints

| Method | Path | Price | What it returns |
|---|---|---|---|
| `POST` | `/v1/pdf/text` | `$0.01` | Merged plaintext, page/word/char counts, metadata, `has_text_layer` flag |
| `POST` | `/v1/pdf/invoice` | `$0.05` | Invoice number, vendor, total, tax, currency, issue/due dates, PO |
| `POST` | `/v1/doc/keydata` | `$0.03` | Emails, phones, URLs, dates, amounts, companies, addresses |
| `GET` | `/` | free | Service discovery: prices, network, `payTo`, calling instructions |
| `GET` | `/health` | free | Liveness plus current mode/network |

Request body accepts either `pdf_base64` or a public `url`:

```json
{ "pdf_base64": "<base64 of the PDF>" }
```

## How payment works

1. Client `POST`s without payment → server replies `402` with a `PAYMENT-REQUIRED` header
   containing price, `asset`, `payTo`, `network`, and a bazaar `schema` for indexing.
2. Client signs an **EIP-3009 `transferWithAuthorization`** for the exact amount. This is gasless
   for the buyer: they sign a message, they do not send a transaction.
3. Client replays the request with a `PAYMENT-SIGNATURE` header.
4. The facilitator verifies, **pays the gas**, and settles on-chain. The handler runs and returns JSON.

## Quick start

```bash
npm ci
npm run genwallet     # testnet receiver wallet -> writes PAY_TO_ADDRESS into .env
npm start             # http://127.0.0.1:4021
npm test              # 19 deterministic extraction tests, no network
```

Then prove the whole payment path locally:

```bash
npm run selftest
```

`selftest` creates a throwaway buyer key (saved to `.buyer-key`), hits the endpoint unpaid to
confirm the `402`, then pays through the official `@x402/fetch` client with a hard
`0.25 USDC` per-payment cap. On a wallet with no funds it stops at
`PAYMENT_UNFUNDED` — which still proves the request was signed and verified, because the
facilitator only rejects on balance. Fund the printed address at
<https://faucet.circle.com/> (Base Sepolia) and rerun to reach `PAID_LOOP_OK`.

## Configuration

Copy `.env.example` to `.env`:

| Variable | Default | Purpose |
|---|---|---|
| `X402_MODE` | `testnet` | `testnet` = Base Sepolia (`eip155:84532`), `mainnet` = Base (`eip155:8453`) |
| `PAY_TO_ADDRESS` | — | **Required.** Wallet that receives settlement |
| `PORT` | `4021` | HTTP port |
| `FACILITATOR_URL` | see below | Override the facilitator endpoint |
| `PRICE_PDF_TEXT` / `PRICE_PDF_INVOICE` / `PRICE_DOC_KEYDATA` | `.01` / `.05` / `.03` | Per-endpoint USD price |
| `MAX_PDF_PAGES` | `200` | Page cap, protects compute margin |
| `CDP_API_KEY_ID` / `CDP_API_KEY_SECRET` | — | Mainnet only |

### Testnet vs mainnet

The free public facilitator `https://x402.org/facilitator` settles **testnets only** — it
advertises `eip155:84532` and not `8453`. Real revenue therefore requires the
**Coinbase CDP facilitator** (`https://api.cdp.coinbase.com/platform/v2/x402`) with an API key.
Switching is a config change, not a code change: set `X402_MODE=mainnet` plus the CDP
credentials and a real `PAY_TO_ADDRESS`.

## Deploy

```bash
docker build -t x402-docintel .
docker run -p 4021:4021 -e PAY_TO_ADDRESS=0xYourWallet x402-docintel
```

Or use the included `render.yaml` blueprint (Docker runtime, health check on `/health`,
`PAY_TO_ADDRESS` supplied through the dashboard rather than committed).

## Custody warning

`gen-wallet.mjs` writes a private key to `.payto-key` on disk. That is acceptable for
**testnet only**. For mainnet revenue, set `PAY_TO_ADDRESS` to a wallet you actually control
(hardware wallet, exchange deposit address, or a Safe) and never leave a hot key on a server.
`.env`, `.buyer-key`, and `.payto-key` are all gitignored.

## Limits and honest scope

- **No OCR.** Image-only or scanned PDFs return `has_text_layer: false` and empty text.
  Run OCR upstream, or treat the flag as a signal to skip the document.
- **Extraction is heuristic.** Invoice parsing handles common layouts and amount formats
  (`$1,120.00`, `1,120.00 USD`, `USD 1,120.00`) but unusual templates may need tuning.
- **No persistence.** Requests are processed in memory and not stored.
- `url` fetching is restricted to `http(s)` and bounded by timeout and size caps.

## License

MIT

