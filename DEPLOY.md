# Deploy runbook

State: **DEPLOYED AND LIVE on mainnet.**

- Public URL: <https://x402-docintel.onrender.com>
- Health: `GET /health` → 200 `{"ok":true,"mode":"mainnet","network":"eip155:8453"}`
- Paywall: all 4 endpoints return 402 with a valid mainnet challenge (32/32 live assertions passed)
- Blueprint sync: `ee1a47a`, branch `main`, private repo `NIBCarl/x402-docintel`
- Paying to: `0x4A223A518FA9C3bb1c086c30277ACb69E8D5E868` (verified in the live 402 challenge)

Note: the POSTs in Step 6 below used `http://` in the challenge URL because Render terminates
TLS and forwards over HTTP — the resource URL in the payload reflects the internal hop, which is
harmless: buyers use the public `https://` URL they were given, and the signed payment scheme
(`eip155:8453` + amount + payTo) is what gets settled, not the advertised string.

Everything that can be checked without a hosting account has been checked; the remaining steps
require a Render account, which only the account holder can create.


## Verified, with evidence

| Check | Command | Result |
|---|---|---|
| Unit + parser tests | `npm test` | 45 pass, 0 fail |
| Real PDF end-to-end audit | `npm run e2e` | 18 pass, 0 fail |
| Paywall + no data leak | `npm run smoke` | 16 pass, 0 fail |
| All 4 prices, mainnet | live `/v1/*` 402 headers | `$0.02 / $0.15 / $0.25 / $0.50` |
| Mainnet challenge shape | decode `PAYMENT-REQUIRED` | `eip155:8453`, `scheme=exact`, USDC `0x8335…2913` |
| Binds Render's `$PORT` | `PORT=10000 node src/server.mjs` | listens on 10000, `/health` → 200 |
| Container layout boots | isolate `src/` + `package.json` + `node_modules`, **no `.env`** | boots mainnet, `/health` → 200, 4× 402 correct |
| Docker install step | `npm ci --omit=dev` | exit 0, 97 packages, no lockfile drift |
| Facilitator serves mainnet | `GET facilitator.payai.network/supported` | `scheme=exact` on `eip155:8453` |
| Facilitator settles free | `POST facilitator.payai.network/settle` | `400 invalid_payment_requirements` (input error, **not** 401 auth) |
| No CDP needed to settle | same two calls | confirmed — but see "Discovery" below: no CDP does **not** mean indexed |
| Mnemonic ↔ address | derive address from `.payto-mnemonic` | matches `.env` exactly — funds recoverable |
| Secrets untracked | `git check-ignore` + remote tree scan | `.env`, `.payto-mnemonic`, `.payto-key`, `.buyer-key` all absent |
| Fails closed on mainnet | `X402_MODE=mainnet`, `PAY_TO_ADDRESS` unset | exit 1, FATAL, never serves — cannot eat payments |
| Boots on mainnet when set | same with real address | listens, `/health` → 200, `payTo` correct |

Docker is not installed on this machine, so the image itself was never built; the three
things that break a build (lockfile drift, deps in `devDependencies`, imports leaving `src/`)
were each verified separately instead.

## The one remaining step: create the Render account

No hosting credential exists on this machine — no `RENDER_API_KEY` in the environment, nothing
in Windows Credential Manager, no `render`/`railway`/`flyctl`/`vercel`/`gh` CLI, and Composio
exposes no hosting toolkit. The account is the hard boundary.

### Step 0 — What you need before starting

- A GitHub account that can see `NIBCarl/x402-docintel` (it is **private**).
- A browser. Nothing to install.
- **No credit card.** Render's free tier does not require one.
- About 10 minutes, plus 3-5 minutes of build time.

### Step 1 — Sign up for Render

Go to <https://render.com> and click **Get Started** / **Sign Up**.

Choose **GitHub** as the sign-up method, not email. You connect GitHub in Step 2 anyway, and
using the same identity avoids ending up with two accounts and a repo you cannot reach.

There is no card prompt on the free tier. If Render asks for one, you have wandered onto a paid
resource — back out and use the Blueprint flow below.

### Step 2 — Give Render access to the private repo (the step people get stuck on)

A private repo is invisible to Render until you explicitly grant access. Skipping this makes
the repo appear "not found" and looks like a broken blueprint link.

1. In the Render dashboard, open **Account Settings → GitHub** (sometimes under
   *Integrations* or *Connected Accounts*).
2. Click **Connect GitHub** and authorize the Render GitHub App.
3. On the GitHub authorization screen, choose **Only select repositories** and tick
   **`x402-docintel`**. Do not grant "All repositories".
4. If you already connected GitHub earlier and the repo is missing, click **Configure** next to
   the Render app on GitHub and add `x402-docintel` to the allowed list.

Confirm it worked: the repo becomes selectable when creating any service.
### Step 3 — Create the Blueprint

A "Blueprint" is Render's name for "read `render.yaml` from the repo and build what it says".
The file is already committed, so you are not filling in forms by hand.

1. Open this link directly:

   <https://dashboard.render.com/blueprint/new?repo=https://github.com/NIBCarl/x402-docintel>

   Or navigate manually: **New +** (top right) → **Blueprint** → pick `x402-docintel`.

2. Render reads `render.yaml` and shows a summary. It should say: service name
   **x402-docintel**, runtime **Docker**, plan **Free**, health check **/health**.
   If any of that looks wrong, stop — the blueprint was not read and you are on the wrong flow.

3. Give the Blueprint a name if asked (anything, e.g. `docintel`) and continue.

### Step 4 — Fill in `PAY_TO_ADDRESS`

The blueprint marks this variable `sync: false`, which means **the value is never stored in the
repo** — Render asks you for it during setup and holds it as a secret.

When prompted (and afterwards under the service's **Environment** tab), set:

```
0x4A223A518FA9C3bb1c086c30277ACb69E8D5E868
```

Paste it exactly: `0x` + 40 hex characters, no spaces, no quotes. This address was verified to
derive from the mnemonic in `.payto-mnemonic`, so the funds are recoverable. **Back that
mnemonic up offline before promoting the service.**

Leaving it blank now fails the deploy on purpose, with
`FATAL: X402_MODE=mainnet requires a real PAY_TO_ADDRESS`. Before that guard existed the
service started happily and routed every payment to `0x000…000`, where it is unrecoverable.
A red deploy beats a silent loss.

The other variables come from the blueprint; verify they read:

| Key | Value |
|---|---|
| `X402_MODE` | `mainnet` |
| `FACILITATOR_URL` | `https://facilitator.payai.network` |
| `NODE_ENV` | `production` |

### Step 5 — Deploy and read the logs

1. Click **Apply** / **Deploy Blueprint**.
2. Render clones the repo and runs `docker build`. Expect **3-5 minutes**.
3. Watch the **Logs** tab. A healthy boot prints exactly:

   ```
   DocIntel x402 listening on :10000  mode=mainnet network=eip155:8453
   facilitator=https://facilitator.payai.network
   payTo=0x4A223A518FA9C3bb1c086c30277ACb69E8D5E868
   prices: {"pdfText":"$0.02","pdfInvoice":"$0.25","docKeydata":"$0.15","invoiceValidate":"$0.50"}
   ```

   `:10000` is expected — Render assigns the port and the server honours `$PORT`.

4. Wait for the status badge to read **Live**. That means `/health` returned 200.

**Check the `payTo=` line.** If it shows `0x0000000000000000000000000000000000000000`, the
environment variable did not take — fix it under **Environment**, save, and let it redeploy.
### Step 6 — Verify from the outside, as a stranger would

Do not trust the green badge; the only evidence that matters is a real 402 from the public URL.
Copy the URL from the top of the Render page (`https://x402-docintel.onrender.com` or similar):

```bash
curl -s -X POST https://YOUR-SERVICE.onrender.com/v1/invoice/audit \
  -H 'content-type: application/json' -d '{}' -D - | head -20
```

You want, in the headers:

- `HTTP/2 402` — the paywall is live
- a `PAYMENT-REQUIRED` header which, base64-decoded, contains `eip155:8453` and
  `"amount":"500000"` (0.50 USDC)

And a quick health check, expecting `{"ok":true,"mode":"mainnet","network":"eip155:8453",...}`:

```bash
curl -s https://YOUR-SERVICE.onrender.com/health
```

If `/health` works but there is no 402, you are on testnet: recheck `X402_MODE`.

### Step 7 — Point the milestone watcher at the live address

```bash
node tools/watch-ours.mjs 0xYOUR_PAY_TO_ADDRESS
```

This scans Base mainnet USDC transfers into the address and reports the only number that
matters: **how many distinct senders that are not you**. It is read-only (public RPC,
`eth_getLogs` only) and writes `ours-status.json` locally.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Repo not found / empty list | Render has no access to a private repo | Step 2 — add `x402-docintel` to the GitHub App |
| `FATAL: ... requires a real PAY_TO_ADDRESS` | Variable missing or blank | Set it under **Environment**, then **Manual Deploy → Deploy latest commit** |
| Build fails at `npm ci` | Lockfile drift | Verified passing locally — confirm you deployed `main`, not an older branch |
| Goes **Live** then **Failed** on health check | Crash or port binding | Read the logs; `$PORT` binding is verified |
| First request after idling takes ~40s | Free tier slept after 15 min idle | Expected, and it bills the caller, not you |
| `payTo=0x0000…` in the logs | Env var not applied | Edit under **Environment** and redeploy |

## What this costs

$0. The blueprint pins `plan: free`. Render spins a free instance down after ~15 minutes idle
and cold-starts on the next request. Revenue is $0 whether the service is awake or asleep, so
paying for always-on uptime before demand exists buys nothing — upgrade to `starter` ($7/mo)
only after the first stranger pays.






## Discovery: deployed, but not indexed — the real blocker

Deploying made the service reachable. It did **not** make it findable. Measured 2026-11-03:

| Check | Result |
|---|---|
| CDP canonical `GET api.cdp.coinbase.com/.../discovery/resources` | 200, `total=105661`, **ours absent** |
| payai mirror `GET facilitator.payai.network/discovery/resources` | 200, `total=15155`, **ours absent** |
| `GET .../discovery/search?query=docintel` | 200, **0 results** |
| `POST .../discovery/register` | 404 — no manual registration exists |

Three facts follow:

1. **Indexing is earned by settlement, not by deploying.** The Bazaar catalogs resources a
   facilitator has actually seen a payment for. A perfectly valid 402 challenge that nobody
   ever pays is invisible — it is a price tag on a shop with no door.
2. **We settle through payai, and payai is not CDP.** The CDP doc says the catalog is
   "discovered by the CDP Facilitator". payai mirrors a 15k subset of CDP's 105k. Whether a
   payai-settled payment propagates into either catalog is **unverified** — we cannot test it
   without a successful payment, which we cannot produce without a buyer.
3. **The 402 already carries the bazaar extension** (`info.input`, `info.output`, JSON schema),
   so the *precondition* for indexing is met. What is missing is the first paid call.

Consequence, stated plainly: **an unpaid, unadvertised, unindexed endpoint has no discovery
path, so 0 revenue is the expected outcome of waiting.** Time is not the missing ingredient.

The only wallet we control is the payee (`0x4A223A…E868`). Self-paying to seed the index is
USDC-in → USDC-out: net **-$0.50**, real money spent to buy one catalog entry of unknown
durability. Not done without an explicit decision — it is a marketing spend, not a test.

Cheaper alternatives, in order: post the URL where x402 buyers already look; point a paying
agent at it; or accept that the honest result of this experiment is "no distribution, no
revenue" rather than "waiting".

## Deliberately not done


The service was **not** exposed through a temporary tunnel (`cloudflared`/`ngrok` are not
installed). A quick tunnel would give a public URL for $0 today, but the URL changes on every
restart and dies with this machine, which would break Bazaar discovery and leave the milestone
watcher pointed at a dead host. A stable free host is worth the one-time signup.
