# wiseway-feedback-dash — admin feedback dashboard

A tiny read-only web dashboard that lets an admin **analyse the feedback staff
leave on assistant answers** (the 👍 / 👎 + reason tag they pick in LibreChat).

LibreChat stores each rating as a `feedback: { rating, tag }` object **on the
message document** in Mongo and ships **no admin view** for it. This service is
that view.

```
http://localhost:8050
```

## What it shows

- Headline KPIs — total ratings, 👍, 👎, % positive.
- **Sentiment split** (👍 vs 👎) — doughnut.
- **By reason tag** — the real LibreChat tags (`accurate_reliable`,
  `inaccurate`, `not_helpful`, …), coloured by sentiment.
- **By staff role** — `warehouse` / `driver` / `office` / `hr-admin` (joined
  from the user doc) stacked up vs down.
- **Over time** — daily 👍 / 👎 trend.
- **Recent feedback** table — latest 40 ratings with the answer excerpt.

## How it reads the data

It connects to the same Mongo LibreChat writes (`MONGO_URI`, default
`mongodb://mongodb:27017/LibreChat`) and **only reads**. Empty DB → empty
dashboard. The one join worth knowing: `messages.user` is stored as a **string**
while `users._id` is an **ObjectId**, so the role/email lookup converts with
`$convert … to: 'objectId'` first.

## Run it

It's a normal compose service:

```bash
docker compose up -d --build wiseway-feedback-dash
docker compose logs -f wiseway-feedback-dash
```

## Local demo data (dev machine only)

To see the charts populated locally, seed sample ratings:

```bash
./deploy/seed-feedback.local.sh        # gitignored — never committed, never in prod
```

The seed and the data it writes stay on your machine: the script is gitignored,
and the rows it inserts live only in your local Mongo volume. A fresh prod
deploy has neither — its dashboard starts empty and fills with real ratings.

Remove the demo rows again any time:

```bash
docker exec wiseway-mongodb mongosh LibreChat --quiet \
  --eval 'db.messages.deleteMany({_sample:true}); db.users.deleteMany({_sample:true})'
```

## ⚠ Security (PoC)

There is **no auth** on this service — anyone who can reach the port sees all
feedback (including the answer text and which user/role left it). Before any
real data: gate it behind admin-only SSO, or keep it on an internal-only
network. INTEGRATE — see `docs/INTEGRATION.md`.
