# CONI SVC DNS Checker

[![Build](https://github.com/manuxio/batch-dns-checker/actions/workflows/build.yml/badge.svg)](https://github.com/manuxio/batch-dns-checker/actions/workflows/build.yml)
[![CodeQL](https://github.com/manuxio/batch-dns-checker/actions/workflows/codeql.yml/badge.svg)](https://github.com/manuxio/batch-dns-checker/actions/workflows/codeql.yml)
[![Trivy security scan](https://github.com/manuxio/batch-dns-checker/actions/workflows/trivy.yml/badge.svg)](https://github.com/manuxio/batch-dns-checker/actions/workflows/trivy.yml)
[![Release](https://img.shields.io/github/v/release/manuxio/batch-dns-checker?logo=github&label=release)](https://github.com/manuxio/batch-dns-checker/releases)

[![Node.js](https://img.shields.io/badge/Node.js-20-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![React](https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=black)](https://react.dev/)
[![Ant Design](https://img.shields.io/badge/Ant%20Design-5-0170FE?logo=antdesign&logoColor=white)](https://ant.design/)
[![Express](https://img.shields.io/badge/Express-4-000000?logo=express&logoColor=white)](https://expressjs.com/)
[![Docker](https://img.shields.io/badge/Docker-Compose-2496ED?logo=docker&logoColor=white)](https://docs.docker.com/compose/)

A dockerized web app + REST API to **verify that third‑party domain owners have
applied the DNS changes you requested** — i.e. that a list of hostnames resolves,
on **all** of their authoritative nameservers, to the **type** and **value** you
expect.

You upload a CSV/Excel file (`hostname, type, value`), the app runs the checks as
an interruptible batch, shows a recap **grouped by secondary‑level domain**, and
lets you download the result (including the list of authoritative nameservers
queried). The last 10 batches are kept for later consultation.

> The UI defaults to **Italian** and is fully internationalized (`it` / `en`).
> The codebase, comments and identifiers are in English (camelCase). The UI uses
> a **dark theme**.

📖 **Full documentation:** in-depth architecture, API and component references
live in the [DeepWiki docs](docs/deepwiki/) (start at
[Overview](docs/deepwiki/Overview.md)).

---

## Table of contents

- [Why it works the way it does (DNS rationale)](#why-it-works-the-way-it-does-dns-rationale)
- [Features](#features)
- [Architecture](#architecture)
- [Quick start (Docker)](#quick-start-docker)
- [Local development](#local-development)
- [Input file format](#input-file-format)
- [Record types](#record-types)
- [Compound values (`&` / `|`)](#compound-values---)
- [How a result is decided](#how-a-result-is-decided)
- [Batches & single check](#batches--single-check)
- [API](#api)
- [Configuration](#configuration)
- [Network requirements](#network-requirements)
- [Security](#security)
- [Project structure](#project-structure)

---

## Why it works the way it does (DNS rationale)

This tool checks **compliance**: did a third party actually point a hostname to
the value we asked for? For that, the answer must be the **freshest and most
authoritative** possible. Two consequences drive the whole design:

### 1. Resolution starts from the root — every time

Instead of asking a recursive resolver (which **caches** answers and can return
stale data for minutes/hours), the engine performs **iterative resolution from
the root servers**, exactly like `dig +trace`:

```
root servers ──referral──▶ TLD servers (.net, .it, …) ──referral──▶ the domain's
authoritative nameservers
```

The domain's authoritative nameservers are taken from the **parent zone's
delegation**. This has two important properties:

- **Freshness:** no recursive resolver and no answer cache sit between the tool
  and the source of truth.
- **Robustness:** because the nameservers come from the parent delegation, the
  tool works even if a zone is misconfigured and does **not** publish `NS`
  records at its apex (a real case we hit: a domain with a working delegation but
  an empty apex — the old recursive approach wrongly reported "no authoritative
  nameservers").

### 2. Every authoritative nameserver is queried directly, with recursion off

Once the authoritative nameservers are known, the tool queries **each of them
directly** with **recursion disabled (`RD=0`)** and compares the answer. A host
is only "OK" if **all** authoritative nameservers agree; any inconsistency
between them is flagged. The per‑nameserver detail is recorded and included in
the downloadable result.

Only the *discovery* of which servers are authoritative is cached within a single
batch run (for speed). **Record values are never cached** — they are always read
live from the authoritative servers.

### 3. Fallback when the root path is blocked

Iterative resolution needs outbound DNS to arbitrary servers (see
[Network requirements](#network-requirements)). If the root servers cannot be
reached (e.g. a firewall only allows DNS to a fixed corporate resolver), the
engine automatically **falls back to the local/recursive resolver** and clearly
flags every such result with a warning ("resolved via local resolver — data may
be stale, not authoritative").

> ⚠️ Note: in a network locked down enough to block the root path, the local
> resolver may also be unable to resolve uncached names, so many checks can still
> fail. The fallback is a best‑effort degraded mode, not a full substitute. You
> can force this mode (or point it at a specific resolver) via
> `DNS_FORCE_LOCAL_RESOLVER` / `DNS_FALLBACK_SERVERS`.

---

## Features

- ✅ Upload **CSV or Excel** (`.csv`, `.xlsx`, `.xls`); CSV delimiter
  auto‑detected (comma or semicolon — Italian Excel exports).
- ✅ Verification against **all authoritative nameservers**, resolved **from
  root**, queried directly (fresh, `RD=0`).
- ✅ Standard record types **A, AAAA, CNAME, MX, TXT, NS, SRV, CAA** plus email
  **policy types SPF, DKIM, DMARC, MTA‑STS, TLS‑RPT, BIMI**.
- ✅ **Compound expected values**: `a & b` (both required) and `a | b` (one of,
  closed set).
- ✅ Results **grouped by secondary‑level domain**, with per‑nameserver detail.
- ✅ **Asynchronous, interruptible batches** with live progress; **re‑run** any
  batch (duplicated into history); last **10** batches kept (SQLite).
- ✅ **Single‑record** quick check on the home page.
- ✅ **Downloadable results** (XLSX/CSV) including the authoritative NS queried;
  downloadable **input template**.
- ✅ **Italian/English** UI (dark theme); documented **REST API** with
  **OpenAPI/Swagger** at `/api/docs`.
- ✅ No authentication required.

---

## Architecture

```text
┌────────────┐   http (host port WEB_PORT, default 8080)   ┌──────────────────────┐
│  Browser   │ ──────────────────────────────────────────▶│  web (nginx)         │
└────────────┘                                             │  • serves the SPA    │
                                                           │  • proxies /api ───┐ │
                                                           └────────────────────┼─┘
                                                                                │ docker net
                                                                                ▼
                                                           ┌──────────────────────┐
                                                           │  server (Express/TS) │
                                                           │  • REST API + OpenAPI│
                                                           │  • iterative DNS     │
                                                           │    engine (from root)│
                                                           │  • SQLite (/data)    │
                                                           └──────────┬───────────┘
                                                                      │ UDP/TCP :53
                                                                      ▼
                                              root → TLD → authoritative nameservers
```

- **server** — Node.js + Express + TypeScript. DNS engine (iterative from root,
  built on `dns-packet`), file parsing (`exceljs`/`papaparse`), result export,
  SQLite persistence (volume `dns_data`), OpenAPI/Swagger.
- **web** — React + TypeScript (Vite) with **Ant Design** (dark theme), served by
  **nginx**, which also reverse‑proxies `/api` to the backend (single origin → no
  CORS in production).

---

## Quick start (Docker)

Requirements: Docker + Docker Compose, and outbound DNS egress (see
[Network requirements](#network-requirements)).

```bash
git clone git@github.com:manuxio/batch-dns-checker.git
cd batch-dns-checker

# Optional: if port 8080 is busy, pick another one.
cp .env.example .env      # then set WEB_PORT=9090, etc.

docker compose up --build
```

Then open:

- App: `http://localhost:8080` (or your `WEB_PORT`)
- API docs (Swagger UI): `http://localhost:8080/api/docs`
- OpenAPI spec: `http://localhost:8080/api/openapi.json`

Batch history (SQLite) is persisted in the Docker volume `dns_data`.

```bash
docker compose logs -f     # tail logs
docker compose down        # stop (keep history)
docker compose down -v     # stop and wipe stored batches
```

A ready‑to‑upload sample is provided at [`samples/esempio-dns.csv`](samples/esempio-dns.csv).

### Run from published images (GHCR)

Each `vX.Y.Z` release publishes the images to the GitHub Container Registry, so
you can deploy without building:

```bash
export IMAGE_TAG=1.0.0          # or "latest"
docker compose -f docker-compose.ghcr.yml pull
docker compose -f docker-compose.ghcr.yml up -d
```

Images: `ghcr.io/manuxio/batch-dns-checker-server` and
`ghcr.io/manuxio/batch-dns-checker-web` (tags: `X.Y.Z`, `X.Y`, `X`, `latest`).

---

## Local development

Two terminals, no Docker:

```bash
# Terminal 1 — backend (http://localhost:3001)
cd server && npm install && npm run dev

# Terminal 2 — frontend (http://localhost:5173)
cd web && npm install && npm run dev
```

Vite proxies `/api` to `localhost:3001`, so the same relative `/api` base works
in dev and in production.

---

## Input file format

A header row with the columns **hostname**, **type**, **value** (any order;
common Italian aliases and case‑insensitive headers are accepted). One row = one
check.

| hostname               | type | value                               |
|------------------------|------|-------------------------------------|
| www.example.it         | A    | 93.184.216.34                       |
| example.it             | MX   | 10 mail.example.it                  |
| example.it             | DMARC| v=DMARC1; p=reject; rua=mailto:d@example.it |
| \_sip.\_tcp.example.it | SRV  | 10 60 5060 sip.example.it           |

Download a filled template from the home page (**Modello Excel / Modello CSV**)
or from `GET /api/template?format=xlsx|csv`.

---

## Record types

**Standard:** `A, AAAA, CNAME, MX, TXT, NS, SRV, CAA`.

**Policy types** (TXT records at conventional names; the app queries the right
name automatically and only compares the relevant record, matched by marker):

| Type     | Name queried                                     | Marker        |
|----------|--------------------------------------------------|---------------|
| SPF      | `<host>`                                          | `v=spf1`      |
| DMARC    | `_dmarc.<host>`                                    | `v=DMARC1`    |
| MTA‑STS  | `_mta-sts.<host>`                                  | `v=STSv1`     |
| TLS‑RPT  | `_smtp._tls.<host>`                                | `v=TLSRPTv1`  |
| BIMI     | `default._bimi.<host>`                             | `v=BIMI1`     |
| DKIM     | put the **full selector name** in `hostname`      | `v=DKIM1`     |

> CNAME values are the **canonical target** (alias). A name with a CNAME cannot
> have other records and may point to a chain — e.g. `shop.example.it , CNAME ,
> www.example.it`.

---

## Compound values (`&` / `|`)

The expected value may combine multiple values (operators must be space‑delimited):

- **`a & b`** → **both** values required (extra records are still allowed → a
  *warning*, like the single‑value case).
- **`a | b`** → **at least one** of the values **and only the listed values are
  allowed** (closed set). Example: with `a | b`, a returned set of `a & b` is
  accepted, while `a & c` is **rejected** (`c` is not an allowed value).

Mixing both operators in one cell is rejected as an invalid row. A literal `a&b`
without surrounding spaces stays a single value (e.g. inside a TXT record).

---

## How a result is decided

For each authoritative nameserver, the returned values are compared to the
expectation (contains / `&` / `|`). The per‑host status aggregates them:

| Status      | Meaning                                                              |
|-------------|---------------------------------------------------------------------|
| **ok**      | all nameservers return the expected value(s), no extra records       |
| **warning** | all match, but extra records are present (or local‑resolver fallback) |
| **error**   | a mismatch, an unreachable nameserver, or inconsistency between NS    |

Comparisons are normalized: case‑insensitive, trailing‑dot tolerant; MX compared
as `priority host`; TXT segment‑aware.

---

## Batches & single check

- **Batches** run asynchronously with live progress; you can **STOP** a running
  batch (remaining items become *cancelled*).
- A **soft limit** of 150 records per batch warns but does not block.
- The last **10** batches are retained (SQLite on the `dns_data` volume);
  batches left "running" after a restart are marked *interrupted*.
- **Re‑run** clones a batch into a new run (duplicated in history).
- The home page also has a **single‑record** check (`POST /api/check`) for quick
  ad‑hoc verification.

---

## API

Base path `/api`; interactive docs at `/api/docs`.

| Method | Endpoint                          | Description                               |
|--------|-----------------------------------|-------------------------------------------|
| GET    | `/health`                         | Service status                            |
| GET    | `/config`                         | Client configuration                      |
| GET    | `/record-types`                   | Supported record types                    |
| GET    | `/template?format=xlsx\|csv`      | Sample input template                     |
| POST   | `/check`                          | Synchronous single‑record check           |
| GET    | `/batches`                        | Last 10 batches                           |
| POST   | `/batches`                        | Upload file + start a batch (multipart)   |
| GET    | `/batches/:id`                    | Full batch with results                   |
| GET    | `/batches/:id/status`             | Progress (for polling)                    |
| GET    | `/batches/:id/groups`             | Results grouped by secondary‑level domain |
| POST   | `/batches/:id/stop`               | Request cancellation                      |
| POST   | `/batches/:id/rerun`              | Re‑run (duplicate into history)           |
| DELETE | `/batches/:id`                    | Delete a batch                            |
| GET    | `/batches/:id/export?format=...`  | Download results (incl. NS queried)       |

---

## Configuration

All via environment variables (Docker reads `.env`; see `.env.example`).

| Variable                   | Default               | Description                                   |
|----------------------------|-----------------------|-----------------------------------------------|
| `WEB_PORT`                 | `8080`                | Host port for the UI                          |
| `PORT`                     | `3001`                | Internal backend port                         |
| `DATA_DIR`                 | `/data`               | SQLite directory                              |
| `DNS_TIMEOUT_MS`           | `5000`                | Per‑query timeout                             |
| `DNS_TRIES`                | `2`                   | Resolver tries (fallback path)               |
| `DNS_HOST_CONCURRENCY`     | `8`                   | Hostnames checked in parallel                 |
| `DNS_MAX_RETRIES`          | `10`                  | Retries on transient errors                   |
| `DNS_BACKOFF_MS`           | `100,500,1000,2000`   | Backoff between retries (last value repeats)   |
| `DNS_FORCE_LOCAL_RESOLVER` | `false`               | Skip the root path; always use local resolver  |
| `DNS_FALLBACK_SERVERS`     | *(empty)*             | Resolver IP(s) for the fallback path           |
| `SOFT_MAX_RECORDS`         | `150`                 | Soft cap on records per batch                  |
| `MAX_UPLOAD_BYTES`         | `10485760`            | Max upload size                                |
| `MAX_BATCHES`              | `10`                  | Batches retained in history                    |

---

## Network requirements

Because resolution goes **root → TLD → authoritative**, the **server container
needs outbound `UDP/53` (and `TCP/53` for large answers) to arbitrary internet
IPs** — not just to an internal resolver. This is the price of guaranteed
freshness.

If your environment only permits DNS to a fixed resolver, set
`DNS_FORCE_LOCAL_RESOLVER=true` (optionally with `DNS_FALLBACK_SERVERS=10.0.0.53`)
to use that resolver. Results obtained this way are flagged as non‑authoritative
and possibly stale.

---

## Security

CI runs SAST and dependency/IaC scanning on every push/PR (see
[`.github/workflows`](.github/workflows)):

- **CodeQL** (`codeql.yml`) — JavaScript/TypeScript static analysis
  (`security-and-quality`), results in the **Security** tab.
- **Trivy** (`trivy.yml`) — filesystem scan for dependency vulns, secrets and
  Dockerfile/compose misconfigurations, SARIF uploaded to the Security tab.
- **Build** (`build.yml`) — type-check/build server, web and the Docker images,
  plus `npm audit`.

> Code scanning results (CodeQL/Trivy SARIF) appear in the Security tab for
> public repos automatically; for **private** repos this requires GitHub
> Advanced Security.

A full local SAST + DAST pass was run and remediated:

- **Dependencies (`npm audit`): 0 vulnerabilities.** Transitive CVEs are pinned
  via `overrides` (`cross-spawn`, `glob`, `minimatch`, `tar`, `uuid`). The
  earlier `xlsx`/SheetJS ReDoS was removed by switching to `exceljs`.
- **Container images (Trivy):** the web image has **0** HIGH/CRITICAL; the
  server image carries **0** Node-package CVEs (npm is removed from the runtime
  image, and the app runs node-only). OS-package patches are applied
  (`apt-get upgrade` / `apk upgrade`); a handful of Debian base CVEs remain that
  upstream marks `will_not_fix`/`fix_deferred` (e.g. zlib, perl) — not reachable
  from this app.
- **DAST (OWASP ZAP baseline): 0 alerts.** nginx sets a strict CSP (relaxed only
  for Swagger UI), `X-Frame-Options`, `X-Content-Type-Options`,
  `Referrer-Policy`, `Permissions-Policy`, `Cross-Origin-Opener-Policy`, and
  hides its version (`server_tokens off`). Remaining ZAP items are informational
  (e.g. cacheable static assets, `style-src 'unsafe-inline'` required by Ant
  Design's runtime styles).
- **Dev-only:** `vite` → `esbuild` advisories affect only the Vite dev server;
  esbuild/Vite are not present in the nginx runtime image.
- **Hardening applied:** both containers run as **non-root** (the server as
  `node`; the web tier on the unprivileged nginx image listening on `8080`),
  each with a `HEALTHCHECK`. ReDoS findings from CodeQL were fixed by replacing
  backtracking regexes with linear split-based parsing.

> Note: the server runs as `node` and owns its `/data` volume. An existing
> deployment created before this change must reinitialize the volume once
> (`docker compose down -v`) so the SQLite directory is writable by `node`.

---

## Project structure

```text
batch-dns-checker/
├── docker-compose.yml
├── .env.example
├── samples/esempio-dns.csv
├── server/                       # Express + TypeScript API
│   ├── src/
│   │   ├── services/
│   │   │   ├── dnsClient.ts          # low-level UDP/TCP DNS (RD=0, EDNS)
│   │   │   ├── iterativeResolver.ts  # root → TLD → domain delegation
│   │   │   ├── recursiveFallback.ts  # local-resolver fallback
│   │   │   ├── dnsChecker.ts         # discovery + compare + aggregate
│   │   │   ├── batchRunner.ts        # async/stop/persist/rerun
│   │   │   ├── fileParser.ts         # CSV/XLSX parsing
│   │   │   ├── exporter.ts           # XLSX/CSV export
│   │   │   └── template.ts           # demo template
│   │   ├── routes/                   # batches, checks, meta
│   │   ├── db/database.ts            # SQLite (last 10)
│   │   ├── utils/                    # domain (PSL), retry
│   │   └── openapi.ts                # OpenAPI spec
│   └── Dockerfile
└── web/                          # React + Ant Design (Vite)
    ├── src/
    │   ├── pages/                    # Upload (home), Batch, History
    │   ├── components/               # ResultsTable, StatusTag, …
    │   ├── api/                      # client + types
    │   └── i18n/                     # it.json, en.json
    ├── nginx.conf
    └── Dockerfile
```
