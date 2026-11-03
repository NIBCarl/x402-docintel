# Deploy runbook

State: **ready to deploy, verified up to the account boundary.** Everything that can be
checked without a hosting account has been checked; the remaining steps require a Render
account, which only the account holder can create.

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
| No CDP needed | same two calls | confirmed |
| Mnemonic ↔ address | derive address from `.payto-mnemonic` | matches `.env` exactly — funds recoverable |
| Secrets untracked | `git check-ignore` + remote tree scan | `.env`, `.payto-mnemonic`, `.payto-key`, `.buyer-key` all absent |

Docker is not installed on this machine, so the image itself was never built; the three
things that break a build (lockfile drift, deps in `devDependencies`, imports leaving `src/`)
were each verified separately instead.

## The one remaining step: create the Render account

No hosting credential exists on this machine — no `RENDER_API_KEY` in the environment, nothing
in Windows Credential Manager, no `render`/`railway`/`flyctl`/`vercel`/`gh` CLI, and Composio
exposes no hosting toolkit. The account is the hard boundary.

1. Sign up at <https://render.com> (GitHub OAuth is fastest; it needs no card on the free tier).
2. Open the blueprint: <https://dashboard.render.com/blueprint/new?repo=https://github.com/NIBCarl/x402-docintel>
   Render reads `render.yaml` automatically: Docker runtime, `plan: free`, `X402_MODE=mainnet`,
   health check on `/health`.
3. When prompted for `PAY_TO_ADDRESS` (the blueprint marks it `sync: false` on purpose, so no
   real address is ever committed), paste:

   ```
   0x4A223A518FA9C3bb1c086c30277ACb69E8D5E868
   ```

   This address was verified to derive from `.payto-mnemonic`, so the funds are recoverable.
   Back that mnemonic up offline before sending anyone to pay you.
4. Deploy. First boot takes a few minutes; the free instance sleeps after 15 min idle and
   cold-starts in ~30-50s on the next request.

## Immediately after the URL exists

```bash
# the paywall must answer on the public host, in mainnet
curl -s -X POST https://<your-service>.onrender.com/v1/invoice/audit \
  -H 'content-type: application/json' -d '{}' -D - | head -20
# expect 402 + PAYMENT-REQUIRED carrying eip155:8453 and amount 500000

# then watch for the only thing that counts: a stranger's USDC
cd ../../revenue-agent
node watch-ours.mjs 0x4A223A518FA9C3bb1c086c30277ACb69E8D5E868
```

A non-zero sender count there is the milestone. Anything else — installs, health checks,
Bazaar impressions — is not.

## Deliberately not done

The service was **not** exposed through a temporary tunnel (`cloudflared`/`ngrok` are not
installed). A quick tunnel would give a public URL for $0 today, but the URL changes on every
restart and dies with this machine, which would break Bazaar discovery and leave the milestone
watcher pointed at a dead host. A stable free host is worth the one-time signup.
