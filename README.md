# CONI SVC DNS Checker

Verifica che una lista di hostname sia risolta da **tutti** i rispettivi name
server autoritativi con il **tipo** e il **valore** attesi. Carichi un file
CSV/Excel, l'applicazione esegue le verifiche in batch (interrompibili) e mostra
un riepilogo raggruppato per **dominio di secondo livello**, scaricabile in
Excel/CSV (incluso l'elenco dei name server autoritativi interrogati).

> The UI is in Italian by default and fully internationalized (it / en). The
> codebase, comments and identifiers are in English (camelCase).

---

## Architettura

```
┌────────────┐      http (porta WEB_PORT, default 8080)      ┌──────────────────┐
│  Browser   │ ───────────────────────────────────────────► │  web (nginx)     │
└────────────┘                                               │  - serve la SPA  │
                                                             │  - proxy /api →  │
                                                             └─────────┬────────┘
                                                                       │ docker network
                                                                       ▼
                                                             ┌──────────────────┐
                                                             │  server (Express)│
                                                             │  - API REST      │
                                                             │  - motore DNS    │
                                                             │  - SQLite (/data)│
                                                             └──────────────────┘
```

- **server** — Node.js + Express + TypeScript. Motore di verifica DNS, parsing
  file, export, persistenza su **SQLite** (volume `dns_data`). API documentate
  con **OpenAPI/Swagger**.
- **web** — React + TypeScript (Vite) con **Ant Design**. Servita da **nginx**,
  che fa anche da reverse proxy verso il backend (nessun problema di CORS in
  produzione, singola origin).

### Routing HTTP
Il browser parla solo con nginx sulla porta pubblicata. nginx serve i file
statici della SPA e inoltra `/api/*` (incluse `/api/docs` e `/api/openapi.json`)
al container `server:3001` sulla rete Docker. Solo il container `web` pubblica
una porta sull'host: il backend è raggiungibile esclusivamente dalla rete
interna e non può entrare in conflitto con altre porte della macchina.

---

## Avvio con Docker (consigliato)

```bash
# (opzionale) se la porta 8080 è occupata, scegline un'altra:
cp .env.example .env   # poi imposta WEB_PORT=9090, ad es.

docker compose up --build
```

Poi apri:

- App: `http://localhost:8080` (o la `WEB_PORT` scelta)
- Documentazione API (Swagger UI): `http://localhost:8080/api/docs`
- Spec OpenAPI: `http://localhost:8080/api/openapi.json`

I dati (storico batch in SQLite) sono persistiti nel volume Docker `dns_data`.

---

## Sviluppo locale (senza Docker)

Due terminali:

```bash
# Terminale 1 — backend (http://localhost:3001)
cd server
npm install
npm run dev

# Terminale 2 — frontend (http://localhost:5173)
cd web
npm install
npm run dev
```

Il dev server di Vite fa da proxy di `/api` verso `localhost:3001`, quindi la
stessa base relativa `/api` funziona sia in sviluppo sia in produzione.

---

## Formato del file di input

Header obbligatorio con le colonne **hostname**, **type**, **value** (qualsiasi
ordine; i nomi sono riconosciuti anche in italiano e con alias comuni). Per i
CSV il delimitatore (virgola o punto e virgola) è rilevato automaticamente; sono
supportati anche `.xlsx` / `.xls`.

| hostname             | type | value                          |
|----------------------|------|--------------------------------|
| www.example.it       | A    | 93.184.216.34                  |
| example.it           | MX   | 10 mail.example.it             |
| example.it           | TXT  | v=spf1 include:_spf.example.it -all |
| \_sip.\_tcp.example.it | SRV  | 10 60 5060 sip.example.it       |

Una riga = una verifica. Per attendersi più valori sullo stesso hostname, usa
più righe. Scarica un modello pronto dalla home (`Modello Excel` / `Modello CSV`)
o da `GET /api/template?format=xlsx|csv`.

**Tipi supportati:** `A, AAAA, CNAME, MX, TXT, NS, SRV, CAA`.

---

## Logica di verifica

Per ogni riga:

1. si individua la **zona** (delegation point) più specifica e il suo set di NS
   autoritativi (Public Suffix List per il dominio registrabile);
2. si interroga **ogni** NS autoritativo direttamente;
3. il valore atteso è confrontato in modalità **"contains"** (corretto se il
   valore atteso è presente; eventuali record extra generano un **avviso**);
4. gli esiti dei singoli NS vengono aggregati:
   - **ok** — tutti gli NS rispondono col valore atteso, senza extra;
   - **warning** — tutti corretti ma con record aggiuntivi;
   - **error** — almeno un NS non corrisponde / irraggiungibile, oppure risposte
     incoerenti tra NS.

I confronti sono normalizzati (case-insensitive, punto finale tollerato, TXT/MX
gestiti per segmenti). Gli errori di risoluzione **transitori** (timeout,
SERVFAIL, REFUSED, ...) vengono ritentati fino a **10 volte** con backoff
`100ms → 500ms → 1s → 2s → 2s…`; un NXDOMAIN/NODATA definitivo non viene
ritentato (è un mismatch).

---

## Batch

- Esecuzione **asincrona** con avanzamento in tempo reale (polling).
- **Interrompibile** dalla UI (gli elementi rimanenti diventano *annullati*).
- Vengono conservati gli **ultimi 10 batch** per consultazione (SQLite).
- **Soft limit** di 150 record per batch: file più grandi sono accettati ma
  segnalati con un avviso.
- I batch rimasti "in corso" dopo un riavvio del server vengono marcati come
  *interrotti*.

---

## API principali

Base path: `/api` — documentazione interattiva su `/api/docs`.

| Metodo | Endpoint                         | Descrizione                              |
|--------|----------------------------------|------------------------------------------|
| GET    | `/health`                        | Stato del servizio                       |
| GET    | `/config`                        | Configurazione per il client             |
| GET    | `/record-types`                  | Tipi di record supportati                |
| GET    | `/template?format=xlsx\|csv`     | Modello di input di esempio              |
| GET    | `/batches`                       | Ultimi 10 batch                          |
| POST   | `/batches`                       | Upload file + avvio batch (multipart)    |
| GET    | `/batches/:id`                   | Batch completo con risultati             |
| GET    | `/batches/:id/status`            | Avanzamento (per polling)                |
| GET    | `/batches/:id/groups`            | Risultati per dominio di secondo livello |
| POST   | `/batches/:id/stop`              | Richiede l'interruzione                  |
| DELETE | `/batches/:id`                   | Elimina un batch                         |
| GET    | `/batches/:id/export?format=...` | Scarica i risultati (incl. NS interrogati)|

---

## Configurazione (variabili d'ambiente)

| Variabile              | Default                | Descrizione                                  |
|------------------------|------------------------|----------------------------------------------|
| `WEB_PORT`             | `8080`                 | Porta host della UI                          |
| `PORT`                 | `3001`                 | Porta interna del backend                    |
| `DATA_DIR`             | `/data`                | Cartella del database SQLite                 |
| `DNS_TIMEOUT_MS`       | `5000`                 | Timeout per query DNS                        |
| `DNS_TRIES`            | `2`                    | Tentativi del resolver per query             |
| `DNS_HOST_CONCURRENCY` | `8`                    | Hostname verificati in parallelo             |
| `DNS_MAX_RETRIES`      | `10`                   | Retry su errori transitori                   |
| `DNS_BACKOFF_MS`       | `100,500,1000,2000`    | Backoff tra i retry (l'ultimo si ripete)     |
| `SOFT_MAX_RECORDS`     | `150`                  | Soft limit record per batch                  |
| `MAX_UPLOAD_BYTES`     | `10485760`             | Dimensione massima upload                    |
| `MAX_BATCHES`          | `10`                   | Batch conservati nello storico               |

---

## Note sulla sicurezza delle dipendenze

`npm audit` segnala alcune vulnerabilità **transitive** che non sono sfruttabili
in questo progetto:

- **server** — `exceljs` → `uuid <11.1.1` (moderate): riguarda solo la
  generazione di UUID v3/v5/v6 con il parametro `buf`. exceljs usa UUID v4 senza
  quel parametro, quindi il percorso vulnerabile non è raggiungibile. (La libreria
  `xlsx`/SheetJS è stata sostituita proprio per eliminare una ReDoS *high* che
  era invece nel percorso di parsing dei file.)
- **web** — `vite` → `esbuild` (moderate/high): riguarda **solo il dev server**
  di Vite. In produzione la SPA è servita da nginx come file statici: Vite ed
  esbuild non sono presenti nell'immagine runtime, quindi non c'è esposizione.

## Struttura del progetto

```
dns-checker/
├── docker-compose.yml
├── .env.example
├── server/                 # API Express + TypeScript
│   ├── src/
│   │   ├── services/       # dnsChecker, batchRunner, fileParser, exporter, template
│   │   ├── routes/         # batches, meta
│   │   ├── db/             # SQLite
│   │   ├── utils/          # domain (Public Suffix List)
│   │   └── openapi.ts      # spec OpenAPI
│   └── Dockerfile
└── web/                    # React + Ant Design (Vite)
    ├── src/
    │   ├── pages/          # Upload, Batch, History
    │   ├── components/     # ResultsTable, StatusTag, ...
    │   ├── api/            # client + tipi
    │   └── i18n/           # it.json, en.json
    ├── nginx.conf
    └── Dockerfile
```
