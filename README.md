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
| `POST` | `/v1/pdf/text` | `$0.02` | Merged plaintext, page/word/char counts, metadata, `has_text_layer` flag |
| `POST` | `/v1/doc/keydata` | `$0.15` | Emails, phones, URLs, dates, amounts, companies, addresses |
| `POST` | `/v1/pdf/invoice` | `$0.25` | Invoice number, vendor, total, tax, currency, issue/due dates, PO |
| `POST` | `/v1/invoice/audit` | `$0.50` | **A decision**, not fields: `approve`/`review`/`reject`, risk score, reason codes, `dedupe_key` |
| `GET` | `/` | free | Service discovery: prices, network, `payTo`, calling instructions |
| `GET` | `/health` | free | Liveness plus current mode/network |

Request body accepts either `pdf_base64` or a public `url`:

```json
{ "pdf_base64": "<base64 of the PDF>" }
```

### `/v1/invoice/audit` — why the premium tier exists

Raw field extraction is a commodity: the on-chain median price for a document endpoint is
about `$0.002`, and no seller on the network has ever had more than 57 distinct buyers. You
cannot reach meaningful revenue selling PDF-to-text, because the buyer pool is too small to
make up in volume.

The audit route sells the thing an AP or audit team actually pays for — a *decision with
reasons* — and returns a `dedupe_key` for duplicate-payment prevention:

```json
{
  "decision": "review",
  "risk_score": 15,
  "checks_run": 7,
  "checks_failed": 1,
  "findings": [{ "code": "DUE_BEFORE_ISSUE", "severity": "major", "detail": "due 2026-01-05 precedes issue 2026-02-01" }],
  "dedupe_key": "9f2c...e41a",
  "extracted": { "total": 1250, "subtotal": 1213.59, "tax_amount": 36.41, "currency": "USD" },
  "audit": { "math_verified": true, "tolerance_abs": 0.02, "max_age_days": 365, "as_of": "2026-11-03" }
}
```

Seven deterministic checks run per document: required-field presence, `subtotal + tax == total`
arithmetic, tax plausibility, date ordering and staleness, conflicting totals, total below
subtotal without a discount line, and text-layer presence. `decision` is `reject` on any
critical finding, `review` on any major one, otherwise `approve`. No LLM is involved, so the
marginal cost of the most expensive endpoint is still effectively zero.

`dedupe_key` is a SHA-256 of invoice number + vendor + total + currency + issue date, so the
same invoice always hashes the same and a second submission can be caught before payment.

## Pricing model

Prices are set from measured on-chain data, not guesswork (see `revenue-agent/leverage.mjs`).
Among real document sellers on Base, daily revenue correlates with **price** (Spearman 0.43)
more strongly than with **call volume** (0.29):

- `intel.degenscan.io` — 14 calls/day at ~$60/call → **$855/day**
- `blockrun.ai` — 4,500 calls/day at $0.01 → **$45/day**

318× the calls, 19× less revenue. So the value tiers are priced up rather than raced to the
bottom. Calls needed per day to reach the $7/day target:

| Price | Calls/day for $7 |
|---|---|
| `$0.02` | 350 |
| `$0.15` | 47 |
| `$0.25` | 28 |
| `$0.50` | 14 |


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
npm test              # 45 deterministic assertions, no network
```

Then prove the whole payment path locally:

```bash
npm run selftest
```

`selftest` creates a throwaway buyer key (saved to `.buyer-key`), hits the endpoint unpaid to
confirm the `402`, then pays through the official `@x402/fetch` client with a hard per-payment
cap. On a wallet with no funds it stops at `PAYMENT_UNFUNDED` — which still proves the request
was signed and verified, because the
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
| `PRICE_PDF_TEXT` / `PRICE_DOC_KEYDATA` / `PRICE_PDF_INVOICE` / `PRICE_INVOICE_VALIDATE` | `.02` / `.15` / `.25` / `.50` | Per-endpoint USD price |
| `MAX_PDF_PAGES` | `200` | Page cap, protects compute margin |
| `CDP_API_KEY_ID` / `CDP_API_KEY_SECRET` | — | Only if you point `FACILITATOR_URL` at Coinbase CDP; not needed by default |

### Testnet vs mainnet

The free public facilitator `https://x402.org/facilitator` settles **testnets only** — it
advertises `eip155:84532` and not `8453`, so it cannot produce real revenue.

That does **not** mean CDP credentials are required. `https://facilitator.payai.network`
is a public facilitator that advertises `scheme=exact` on `eip155:8453` (Base mainnet) and
serves `/verify` and `/settle` without authentication. This was verified directly, not
assumed:

```bash
# advertises eip155:8453 scheme=exact  -> this service can settle real USDC
curl -s https://facilitator.payai.network/supported | grep -o 'eip155:8453' | head -1

# settlement endpoint answers, and rejects only bad *input* (400), never auth (401)
curl -s -X POST https://facilitator.payai.network/settle -d '{}'
# {"success":false,"errorReason":"invalid_payment_requirements",...}
```

So mainnet is a config switch: `X402_MODE=mainnet` plus a real `PAY_TO_ADDRESS`. Set
`FACILITATOR_URL` to the CDP endpoint only if you specifically want Coinbase's facilitator.

### Settlement vs. discovery (an important distinction)

No CDP account is needed to **settle** payments, as shown above. Discovery is a different
question, and the answer is less convenient:

- Bazaar indexing is earned by **settlement**, not by deploying. A facilitator catalogs a
  resource only after it has seen a payment succeed.
- The CDP catalog is "discovered by the CDP Facilitator". payai mirrors a 15k subset of CDP's
  105k entries — and whether a payai-settled payment propagates into either catalog is
  **unverified**.
- Measured 2026-11-03: our resource appears in neither catalog, and a search for `docintel`
  returns 0 results. There is no manual registration endpoint (`POST /discovery/register` → 404).

Practical meaning: a valid 402 that nobody pays is a price tag on a shop with no door. Being
deployed is not the same as being findable, and waiting does not close that gap. See
`DEPLOY.md` → "Discovery: deployed, but not indexed" for the numbers and the options.



## Deploy

```bash
docker build -t x402-docintel .
docker run -p 4021:4021 -e PAY_TO_ADDRESS=0xYourWallet x402-docintel
```

Or use the included `render.yaml` blueprint (Docker runtime, health check on `/health`,
`X402_MODE=mainnet`, and `PAY_TO_ADDRESS` supplied through the dashboard rather than
committed). The server binds `$PORT` when set, which is what Render's health check requires.


## Validation

```bash
npm test     # 45 deterministic assertions (extraction + audit engine), no network
npm run e2e  # real PDF bytes -> unpdf -> audit decision, no network
npm start &  # then, in another shell:
npm run smoke  # live paywall + price assertions against the running server
```

`npm run e2e` is the one that matters for regressions: the unit tests inject text directly,
which skips the PDF parser entirely. It builds a spec-valid PDF, pushes it through `unpdf`, and
checks that the clean invoice `approve`s, a tampered total `reject`s, and conflicting totals
are flagged.

## The experiment this is built for

This service exists to answer one question with real money at stake: **can a document API on
x402 earn $5–7/day?** The honest starting point is that it probably cannot, and the point of
running it is to find out cheaply rather than to assume.

What the data already establishes (full-registry census of 102,080 endpoints, 1,786 sellers):

- Only **3.7%** of document sellers earn ≥ $7/day, and 44.1% earn nothing at all.
- **Max 57 distinct buyers** on any seller — the buyer pool, not effort, is the ceiling.
- **22.5% of tracked document volume is wash trading.** One "whale" moving $39k/day is two
  wallets paying themselves, so headline market numbers are not trustworthy.
- Legitimate sellers do exist and do repeat: 8 sellers with 3–57 distinct buyers earn on 7/7
  days, led by `intel.degenscan.io` at $855/day.

Decision rules, fixed before the money is spent:

1. **$0 budget until a stranger pays.** Free hosting tier only. Revenue is $0 whether the
   service is asleep or awake, so paying for uptime before demand exists buys nothing.
2. **Deploy to Base mainnet, not testnet.** Testnet payments are invisible to the census and
   to Bazaar, which makes the experiment unmeasurable. This needs a real `PAY_TO_ADDRESS`;
   no CDP account is required, because `facilitator.payai.network` settles `eip155:8453`.

3. **The milestone is binary:** a USDC transfer into our `payTo` from an address that is not
   ours. `revenue-agent/watch-ours.mjs` detects exactly that and nothing else counts.
4. **Two weeks, then reprice or stop.** If no stranger payment lands, the price or the offer
   is wrong — do not extend the window and call it patience.

To check the only metric that matters:

```bash
cd ../revenue-agent && node watch-ours.mjs    # reads PAY_TO_ADDRESS from .env
```

It prints paid/not-paid, USD received, distinct senders, and active days. A control run against
a known-active seller address confirms the detector actually finds payments, so a `$0` result
is a real zero rather than a broken query.



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

