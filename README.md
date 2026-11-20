# UniqueResellzz

A small online shop for pre-loved designer pieces, running on **Cloudflare's free plan**.
Hosting costs nothing; the only cost is Stripe's fee on each sale.

- **The shop:** https://shop.naleyahscloset.workers.dev
- **The Studio (admin):** https://shop.naleyahscloset.workers.dev/admin

Shoppers browse, add pieces to a bag, and pay through Stripe's secure checkout, which also
collects their shipping address. Naleyah signs in to the Studio to post pieces, make them
live, see orders, and mark them shipped.

Every piece is one of a kind, so the shop never sells the same piece twice. While a buyer
is in checkout, their pieces show as **On hold**. If they don't finish within about 30
minutes, or they press back, the pieces go back on sale by themselves.

---

## Two things to do before the shop can take orders

Both happen in Cloudflare: **Workers & Pages → shop → Settings → Variables and Secrets → Add**.
Always choose type **Secret**.

### 1. Set the Studio password
Add a secret named `ADMIN_PASSWORD` (8 or more characters; make it a good one). Then open
`/admin` and sign in. Until this is set, the Studio shows a "locked" message.

### 2. Connect Stripe (test mode first)
1. Sign up at stripe.com and stay in **test mode** (no real money moves). If Naleyah is under 18,
   Stripe needs a parent or guardian added as the account owner.
2. **Developers → API keys**: copy the **Secret key** (`sk_test_...`) into Cloudflare as a secret
   named `STRIPE_SECRET_KEY`.
3. **Developers → Webhooks** (sometimes called **Event destinations**) → **Add endpoint**:
   - URL: `https://shop.naleyahscloset.workers.dev/stripe/webhook`
   - Events: `checkout.session.completed`, `checkout.session.expired`,
     `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`

   Copy its **Signing secret** (`whsec_...`) into Cloudflare as a secret named `STRIPE_WEBHOOK_SECRET`.
4. **Practice purchase:** post a piece, make it live, and buy it with card `4242 4242 4242 4242`
   (any future date, any CVC, any ZIP). The piece should show Sold and the order should appear
   under **Orders → To ship**. Delete the practice piece afterwards.
5. **Go live:** finish Stripe's account activation (bank account, identity check), turn off test
   mode, and replace `STRIPE_SECRET_KEY` with the live key (`sk_live_...`). Create the webhook
   again in live mode and replace `STRIPE_WEBHOOK_SECRET` with its new signing secret.
   Also turn on **Settings → Customer emails → Successful payments** so buyers get a receipt.

---

## Using the Studio (day to day)

**Post a piece**
1. Tap **+ New item**.
2. Add photos (up to 12). The first one is the cover; use the arrows to reorder.
   Photos from a phone are shrunk automatically so the shop loads fast.
3. Fill in the designer, title, price, and (optionally) the original retail price, which
   shows crossed out. Add condition, size, color, and a description that mentions any wear.
4. Tap **Save draft** to keep it hidden, or **Save & make live** to put it in the shop.

**Make a draft live:** tap **Make live** next to it. To preview a draft first, use **More → Preview**.
Shoppers never see drafts.

**Other actions (under More):** **Unpublish** hides a live piece. **Mark sold** is for a piece
sold somewhere else. **Relist** puts a sold piece back on sale. **Delete** removes it for good,
along with its photos.

**Outfits (styled sets)**
In the **Outfits** tab, tap **+ New outfit**, name the look, tick two or more of your items, and set
one price for the whole set (the editor shows what the pieces cost separately, so you can price a deal).
Add a styled photo of the full look if you have one. Shoppers can buy the whole outfit at the set price,
or any piece on its own at its normal price. If a piece sells on its own, the outfit stops selling as a
set and the remaining pieces carry on selling one by one.

**When someone buys**
1. The piece flips to **Sold** in the shop automatically. Stripe can also email you about each
   payment (turn on email notifications for successful payments in your Stripe profile).
2. The **Orders** tab shows it under **To ship**, with the buyer's address.
   Use **Copy address** or **Packing slip** (printable, with the address in big type).
3. After the post office, type the tracking number and tap **Mark shipped**.
4. Tap **Email buyer the tracking**. Your email app opens with a message ready to send.
   Buyers can also check their order page any time; it shows the tracking link once shipped.

**Shop settings** changes the shop name, headline, about text, policies, contact email,
Instagram handle, and the shipping charge (one flat charge per order; 0 means free). No code needed.
**Read the policies text before going live** so it says what Naleyah actually does (e.g. returns).

**Photo storage:** 1 GB, roughly 3,000 photos. The bottom of the Items list shows how much is used.
Deleting a piece frees its photos.

---

## Making changes

| To change... | Edit... |
|---|---|
| Shop name, headline, about, policies, shipping price, contact | **Studio → Shop settings** (no code) |
| Colors and fonts | `static/shop.css`: the `:root` block at the top |
| Layout and wording of shop pages | `src/views.js` (one function per page) |
| Categories, conditions, photo limits, default text | the top of `src/store.js` |
| The Studio's screens | `static/admin.js` and `static/admin.css` |
| Checkout (shipping countries, hold time) | `src/index.js` (`allowed_countries`) and `src/store.js` (`HOLD_MS`) |

Then check and publish:

```bash
npm install     # first time only
npm test        # runs the whole shop against a fake Stripe; needs no accounts
npm run dev     # try it at http://localhost:8787 (copy .dev.vars.example to .dev.vars first)
npm run deploy  # publish to Cloudflare
```

### Publishing: three ways

1. **Automatic, from GitHub (recommended).** Put this folder in a GitHub repository. In Cloudflare:
   **Workers & Pages → shop → Settings → Builds → Connect**, pick the repository, keep the default
   deploy command (`npx wrangler deploy`). From then on every change pushed to GitHub is published
   within a minute or two.
2. **From a computer.** `npx wrangler login` once, then `npm run deploy`.
3. **Through Cloudflare's API** (how the first version was published). Run `npm run bundle` to
   build `dist/worker.js`, then upload that one file as module `worker.js` to the Worker named `shop`
   with `compatibility_date` `2026-11-01`, the two bindings below, and
   `keep_bindings: ["secret_text", "secret_key", "plain_text"]` so the password and Stripe keys stay.

All three keep the secrets set in the dashboard. The site's storage is already created and wired
up in `wrangler.jsonc`:

| Binding | What | Name / ID |
|---|---|---|
| `DB` | D1 database: items, orders, settings | `naleyahs-closet` / `8709ea03-7b45-42f8-b249-c67612ec704e` |
| `PHOTOS` | KV namespace: the photo files | `naleyahs-closet-photos` / `993e35aa0c7745dcb96de87ad1ddd84f` |

### Optional: your own domain
Buy a domain (Cloudflare sells them at cost, about $10/year for a .com) and add it under the Worker's
**Settings → Domains & Routes**. Then update the Stripe webhook URL to the new address. Cloudflare
recommends a custom domain over the `workers.dev` address for anything business-critical.

---

## What the free plan covers

| Limit | Free amount | What it means here |
|---|---|---|
| Requests per day | 100,000 | Each page and each photo is one. Thousands of shoppers a day. |
| Photo storage (KV) | 1 GB | Roughly 3,000 photos |
| Photo uploads per day (KV writes) | 1,000 | Far more than a closet needs |
| Database storage (D1) | 500 MB | Items and orders are tiny; effectively unlimited here |
| Processing time per request | 10 ms | The shop's pages use a small fraction of this |

If a daily limit were ever hit, the shop would pause until the reset at midnight UTC; nothing is
lost and nothing is charged. Cloudflare's paid plan ($5/month) raises every limit.

Cloudflare keeps about a week of database history (D1 "Time Travel"), so the database can be
rolled back to an earlier point if something goes wrong.

---

## How it is built

| File | What it does |
|---|---|
| `src/index.js` | The Worker: routes for shop pages, bag and checkout, Stripe webhook, photos, Studio API |
| `src/store.js` | Data: items, orders, holds and settings in D1; photo files in KV |
| `src/stripe.js` | Stripe Checkout calls and webhook signature checks (plain `fetch` and Web Crypto, no SDK) |
| `src/views.js` | Server-rendered pages, escaped by default via `src/html.js` |
| `static/` | Styles and browser scripts for the shop (`shop.*`) and the Studio (`admin.*`) |
| `scripts/embed-static.mjs` | Packs `static/` into `src/static.generated.js` (runs automatically before dev, test and deploy) |
| `scripts/bundle.mjs` | Builds the single-file `dist/worker.js` for API deploys |
| `test/` | Tests, plus stand-ins for D1, KV and Stripe |
| `wrangler.jsonc` | Cloudflare settings: entry point, build step, database and photo storage |

- Card details never touch this app. Stripe Checkout handles payment and address entry.
- A sale is recorded by whichever arrives first: the signed webhook, or the buyer landing
  on the thank-you page (which asks Stripe directly). Recording is idempotent.
- Holds are taken with conditional updates inside a D1 batch, so two buyers can't both
  check out the same piece. If a payment ever arrives for a piece that already sold, the
  order is flagged in the Studio as **Refund needed in Stripe** instead of being double-sold.
- The database tables are created automatically on first use; there are no migrations to run.
- Static files are served by the Worker with a content hash in the URL, so browsers cache them
  forever and still pick up a change the moment it is deployed.
- Checkout ships to US addresses only.
