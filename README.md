# Fleet Management System: Integrations, API Gateway, Docs and Tests

A backend for a fleet administrator who needs to **track vehicle locations**, **find nearby
vehicles**, **receive SMS alerts** for critical vehicle events, and give developers **clear API
documentation**.

| Requirement | How it is implemented |
|---|---|
| Geolocation integration | **OpenStreetMap Nominatim** geocoding (address → lat/lng), GPS storage in MongoDB, radius search with **MongoDB `$geoNear`** (2dsphere index), **Leaflet** map UI |
| SMS notifications | Custom **SMS stub** (default) or a real **Twilio** trial account. Critical events and status changes trigger SMS, and every attempt is stored as `sent` / `failed` |
| API Gateway | Express + `http-proxy-middleware`: routing to 5 services, **API key** check, **per-key rate limiting**, 503/504/404 handling |
| Swagger / OpenAPI | OpenAPI 3.0 spec ([docs/openapi.yaml](docs/openapi.yaml)) served with **Swagger UI** at `/docs` |
| Automated tests | **Mocha + Chai** (+ Supertest, Sinon). **89 tests covering all 7 flows** |

---

## 1. Architecture

```
 Clients (Swagger UI, /map page, curl, demo script)
        │   x-api-key + Authorization: Bearer <JWT>
        ▼
 ┌──────────────────────────── API GATEWAY :8080 ────────────────────────────┐
 │  request id → API key check → rate limit (per key) → proxy → error map    │
 │  public: /docs (Swagger UI) · /openapi.json · /map (Leaflet) · /health     │
 └────┬─────────────┬──────────────┬──────────────┬──────────────┬───────────┘
      ▼             ▼              ▼              ▼              ▼
  /api/users   /api/vehicles  /api/telemetry   /api/maps   /api/notifications
  User Svc     Vehicle Svc    Telemetry Svc    Geo Svc     Notification Svc
   :4001         :4002           :4003          :4004           :4005
                   │               │              │                │
                   │               │              └─► OpenStreetMap Nominatim
                   │               │                               └─► SMS stub / Twilio
   Internal calls (x-internal-key):
     Vehicle Svc   ──geocode address──────────────► Geo Svc
     Vehicle Svc   ──status changed───────────────► Notification Svc
     Telemetry Svc ──critical event───────────────► Notification Svc

   All services ──► MongoDB: users · vehicles (2dsphere index) · telemetry · notifications
```

* **Each service is its own Express app on its own port.** `npm start` runs all of them, plus the
  gateway, in one Node process. That is convenient locally and lets the whole system deploy as one
  web service. Each service can also run as a separate process (`npm run svc:users`, …).
* **Auth is two-layered:** the gateway checks the **API key**, which identifies the client app. Each
  service checks the **JWT**, which identifies the user and their role.
* **Service-to-service calls** (vehicles → maps, telemetry/vehicles → notifications) use a shared
  `x-internal-key`. The gateway **strips** that header from client requests so clients cannot
  impersonate a service.
* For simplicity all services share one MongoDB database. In a production microservice setup each
  service would own its own database.

---

## 2. Quick start

**Requirements:** Node.js 22 or newer (`node -v`). Nothing else is needed: if no database is
configured, an in-memory MongoDB starts automatically with demo data.

```bash
npm install          # install dependencies
npm start            # start the gateway + 5 services
```

Then open:

| URL | What |
|---|---|
| http://localhost:8080/docs | **Swagger UI** (click *Authorize*: API key `dev-api-key-123` + JWT from login) |
| http://localhost:8080/map | **Map UI**: fleet on OpenStreetMap, nearby search, SMS log |
| http://localhost:8080/health | Gateway + service health |

In a **second terminal**, run the scripted end-to-end demo:

```bash
npm run demo                    # all scenarios
npm run demo -- --rate-limit    # also fires 130 requests to show HTTP 429
```

### Demo accounts (seed data)

| Role | Email | Password | Phone (fake) |
|---|---|---|---|
| admin | admin@fleet.local | Admin@123 | +919800000001 |
| admin | night.admin@fleet.local | Admin@123 | +919800000000 ← SMS **always fails** (stub magic number) |
| fleet_manager | manager@fleet.local | Manager@123 | +919800000002 |
| driver | driver1@fleet.local | Driver@123 | +919800000003 (assigned to DL01AB1234) |
| driver | driver2@fleet.local | Driver@123 | +919800000004 (assigned to DL03CD5678) |

Eight vehicles are seeded around Delhi NCR (Connaught Place, India Gate, Karol Bagh, Saket,
Gurugram, Noida, Manesar, Ghaziabad).

### Using a persistent database

Copy `.env.example` to `.env` and set `MONGODB_URI` to a local MongoDB
(`mongodb://127.0.0.1:27017/fleet`) or a MongoDB Atlas connection string. On the first start
with an empty database the demo data is loaded automatically. `npm run seed` resets it.

### npm scripts

| Script | Purpose |
|---|---|
| `npm start` | Gateway + all services (in-memory DB if `MONGODB_URI` is empty) |
| `npm run start:memory` | Force in-memory DB with fresh demo data |
| `npm run dev` | Same as start, restarts on file changes |
| `node src/start-all.js --skip=telemetry` | Start without one service, to demo **503 Service Unavailable** |
| `npm run gateway` / `npm run svc:<name>` | Run the gateway or one service as its own process (needs `MONGODB_URI`) |
| `npm run seed` | Reset and seed the database in `MONGODB_URI` |
| `npm run demo` | Scripted end-to-end walkthrough (system must be running) |
| `npm test` | Mocha/Chai test suite |

---

## 3. API Gateway

| Gateway route | Target service | Port |
|---|---|---|
| `/api/users/*` | User Service | 4001 |
| `/api/vehicles/*` | Vehicle/Fleet Service | 4002 |
| `/api/telemetry/*` | Telemetry Service | 4003 |
| `/api/maps/*` | Geolocation Service | 4004 |
| `/api/notifications/*` | Notification Service | 4005 |

Code: [src/gateway/app.js](src/gateway/app.js), [src/gateway/middleware.js](src/gateway/middleware.js)

Pipeline for every `/api/*` request:

1. **Request id**: adds `X-Request-Id` (kept if the client sent one) and forwards it to the service for tracing.
2. **API key verification**: `x-api-key` header. Missing → `401 API_KEY_MISSING`, unknown → `403 API_KEY_INVALID`. Keys come from `API_KEYS` and are compared in constant time.
3. **Rate limiting**: `express-rate-limit`, a fixed window **per API key** (default 100 requests / 60 s). It sends standard `RateLimit` / `RateLimit-Policy` headers and returns `429 RATE_LIMIT_EXCEEDED` with `Retry-After`.
4. **Forwarding**: `http-proxy-middleware` keeps method, path, query, body and headers, removes `x-api-key` and `x-internal-key`, adds `x-forwarded-*`, and tags the response with `X-Served-By: <service>-service`.
5. **Errors** (same JSON shape everywhere):

| Situation | Status | Code |
|---|---|---|
| Path not owned by any service | 404 | `NO_ROUTE` |
| Service not running / unreachable | 503 | `SERVICE_UNAVAILABLE` (+ `Retry-After`) |
| Service too slow (`PROXY_TIMEOUT_MS`) | 504 | `GATEWAY_TIMEOUT` |
| Malformed JSON body | 400 | `MALFORMED_JSON` (from the service) |

```json
{ "error": { "status": 503, "code": "SERVICE_UNAVAILABLE",
             "message": "Telemetry Service is currently unavailable. Please try again later.",
             "details": { "service": "telemetry" }, "requestId": "4f1c…" } }
```

---

## 4. Third-party integrations

### 4a. Geolocation (OpenStreetMap)

Code: [src/services/maps/](src/services/maps/)

* **Address → coordinates:** `GET /api/maps/geocode?address=India Gate, New Delhi` calls
  [Nominatim](https://nominatim.org/), which is free and needs no key. It sends the User-Agent that
  Nominatim's usage policy requires and caches results in memory.
* **On vehicle registration** (`POST /api/vehicles`), if only an `address` is given, the Vehicle
  Service asks the Geolocation Service to geocode it (`locationSource: "geocoded"`).
* **GPS from vehicles:** every `POST /api/telemetry` stores the reading and updates the vehicle's
  current position (`locationSource: "gps"`). Older out-of-order readings don't move the vehicle back.
* **Nearby search:** `GET /api/maps/nearby?lat=28.61&lng=77.23&radiusKm=5` (or `?address=…`) runs a
  MongoDB `$geoNear` aggregation on a **2dsphere** index and returns vehicles nearest first with `distanceKm`.
* **Map UI:** `/map` uses Leaflet + OpenStreetMap tiles. It shows colour-coded vehicle markers,
  runs a nearby search when you click the map or type an address (with a radius circle), and lists
  recent SMS notifications.
* `GEO_PROVIDER=mock` switches to an offline geocoder (used by the tests).

### 4b. SMS notifications

Code: [src/services/notifications/](src/services/notifications/)

| Trigger | Recipients |
|---|---|
| **Critical event** in telemetry: `engine_fault`, `low_battery`, `emergency_stop`, reported by the vehicle **or auto-detected** (battery < 15 %, engine > 110 °C, any OBD `faultCode`) | All **admins** (fleet administrators) |
| **Operational status change** (`PATCH /api/vehicles/:id/status`, e.g. `active → maintenance`) | Admins, fleet managers and the vehicle's **assigned driver** |

* Each attempt is stored in the `notifications` collection: `status` (`pending`/`sent`/`failed`),
  `provider`, `providerMessageId`, `error`, `attempts`.
  See `GET /api/notifications?status=failed`, `GET /api/notifications/stats`,
  and `POST /api/notifications/:id/retry`.
* **SMS stub** (default): prints each SMS to the console, keeps an outbox
  (`GET /api/notifications/outbox`), and **fails on purpose** for numbers ending in `0000` or
  numbers not in E.164 format, so the "failed" path can be demonstrated.
* **Twilio (optional):** set `SMS_PROVIDER=twilio`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` and
  `TWILIO_FROM_NUMBER`. A trial account can only text numbers you have verified in the Twilio console.
* If the Notification Service is down, telemetry and status updates **still succeed**. The response
  reports `notification.triggered: false` with the error.

---

## 5. Authentication and roles

* `POST /api/users/login` returns a **JWT** (HS256, 1 h) with claims `sub`, `role`, `name`, `email`, `iss`.
* Send it as `Authorization: Bearer <token>`. `GET /api/users/verify-token` shows the decoded claims.
* Errors: `401 TOKEN_MISSING`, `401 TOKEN_INVALID` (tampered or wrong secret), `401 TOKEN_EXPIRED`, `403 INSUFFICIENT_ROLE`.

| Action | admin | fleet_manager | driver |
|---|:-:|:-:|:-:|
| View vehicles, maps, nearby | ✅ | ✅ | ✅ |
| Register / edit vehicles | ✅ | ✅ | ❌ |
| Change vehicle status | ✅ | ✅ | own vehicle only |
| Submit / read telemetry | ✅ | ✅ | own vehicle only |
| **Delete vehicle** | ✅ | ❌ | ❌ |
| View notifications / stats | ✅ | ✅ | ❌ |
| Manual SMS, retry, outbox | ✅ | ❌ | ❌ |
| Create users / change roles | ✅ | ❌ | ❌ |

Public self-registration (`POST /api/users/register`) always creates a **driver**. A `role` field in the body is ignored.

---

## 6. API documentation (Swagger)

* Spec: [docs/openapi.yaml](docs/openapi.yaml), OpenAPI 3.0.3 with **30 operations**. Each has request/response
  schemas, examples, auth requirements (API key + JWT, roles in each description) and error responses.
* Swagger UI: **http://localhost:8080/docs** · raw JSON: `/openapi.json`
* To try requests: click **Authorize**, enter `dev-api-key-123` under *ApiKeyAuth*, run
  `POST /api/users/login`, then paste the returned `token` under *BearerAuth*.

---

## 7. Automated tests (Mocha + Chai)

```bash
npm install
npm test
```

* The first run downloads a MongoDB binary (~100 MB) for **mongodb-memory-server**. Later runs take about 10 s.
* No database, internet or API keys are needed. Tests start an in-memory MongoDB, all 5 services on random ports
  and the gateway, then send **real HTTP requests through the gateway** with Supertest.
* External services are mocked: **Sinon** stubs the geocoder, the SMS provider and `fetch` (for the Nominatim client).

| # | Flow (from the brief) | File | Tests |
|---|---|---|---|
| 1 | User login and JWT verification | [test/01-auth.test.js](test/01-auth.test.js) | 16 |
| 2 | Vehicle registration and retrieval | [test/02-vehicles.test.js](test/02-vehicles.test.js) | 12 |
| 3 | Telemetry submission and storage | [test/03-telemetry.test.js](test/03-telemetry.test.js) | 14 |
| 4 | Status update and notification triggering | [test/04-status-notifications.test.js](test/04-status-notifications.test.js) | 10 |
| 5 | Role-based access control (e.g. delete vehicle) | [test/05-rbac.test.js](test/05-rbac.test.js) | 9 |
| 6 | Nearby search with mocked geolocation | [test/06-nearby.test.js](test/06-nearby.test.js) | 11 |
| 7 | Gateway API key + rate limiting (+ routing, 503, 504) | [test/07-gateway.test.js](test/07-gateway.test.js) | 17 |
| | **Total** | | **89 passing** |

Run one flow: `npx mocha test/07-gateway.test.js`

---

## 8. Deployment (Render + MongoDB Atlas, free tiers)

The whole system (gateway + 5 services) runs as **one Render web service**. The gateway listens on
Render's `$PORT` and the services on internal localhost ports.

1. **MongoDB Atlas**: create a free M0 cluster at https://www.mongodb.com/cloud/atlas.
   * *Database Access*: add a database user and password.
   * *Network Access*: allow `0.0.0.0/0`, because Render has no fixed IP on the free plan.
   * *Connect → Drivers*: copy the connection string and put `/fleet` before the `?`, e.g.
     `mongodb+srv://user:pass@cluster0.xxxxx.mongodb.net/fleet?retryWrites=true&w=majority`
2. **GitHub**: push this folder to a repository. `.env` and `node_modules` are git-ignored.
3. **Render**: go to https://render.com → *New → Blueprint* → pick the repo. Render reads [render.yaml](render.yaml).
   When asked, enter:
   * `MONGODB_URI`: the Atlas string from step 1
   * `API_KEYS`: e.g. `demo-key-2026` (that is the key you will use and share)
   `JWT_SECRET` and `INTERNAL_SERVICE_KEY` are generated automatically.
4. Once the deploy is live, open `https://<your-app>.onrender.com/docs`. On the first start the
   database is empty, so the demo accounts are created automatically.
5. Run the demo against it:
   `BASE_URL=https://<your-app>.onrender.com API_KEY=demo-key-2026 npm run demo`
   (PowerShell: `$env:BASE_URL="https://…"; $env:API_KEY="demo-key-2026"; npm run demo`)

> The free Render plan sleeps after ~15 minutes idle, so the first request then takes ~30–60 s.
> The demo passwords are public in this README, so change them if the deployment stays online.

---

## 9. Screenshot / screencast checklist (Deliverable 5)

| Required evidence | How to capture it |
|---|---|
| **Vehicle geolocation and nearby retrieval** | `/map`: log in, type `India Gate, New Delhi`, radius 5, *Search nearby*. Screenshot the circle, markers and distance list. Also screenshot `GET /api/maps/nearby` in Swagger and the *Register a vehicle by ADDRESS* step of `npm run demo`. |
| **SMS notification for an event / status change** | Run `npm run demo`, then screenshot the **server terminal** (📱 SMS boxes), demo steps 8–10 (sent/failed records) and the *Recent SMS notifications* panel on `/map`. |
| **Gateway routing and API key verification** | Demo steps 1–2 (401 / 403 / 404), any response showing the `X-Served-By` header in Swagger, the `[gateway] … -> vehicles-service` log lines, and `node src/start-all.js --skip=telemetry` followed by a telemetry call to show **503**. `npm run demo -- --rate-limit` shows **429**. |
| **Swagger UI** | http://localhost:8080/docs: the overview, an expanded endpoint with its schema and examples, a successful *Try it out* after *Authorize*. |
| **Tests** (bonus) | Screenshot `npm test` showing 89 passing. |

---

## 10. Project structure

```
├── docs/openapi.yaml              OpenAPI 3.0 spec (served at /docs)
├── render.yaml                    Render deployment blueprint
├── scripts/
│   ├── demo.js                    end-to-end demo for screenshots
│   └── seed.js                    reset + seed MONGODB_URI
├── src/
│   ├── start-all.js               starts gateway + all services
│   ├── config.js                  all configuration (env vars)
│   ├── seed.js                    demo users and vehicles
│   ├── gateway/
│   │   ├── app.js                 routing, proxy, errors, Swagger UI, /health
│   │   ├── middleware.js          request id, API key check, rate limiter
│   │   └── public/map.html        Leaflet map UI
│   ├── services/
│   │   ├── users/                 login, JWT, user management
│   │   ├── vehicles/              registration, status changes, delete
│   │   ├── telemetry/             GPS + sensors, critical event detection
│   │   ├── maps/                  geocoder (nominatim | mock), nearby search
│   │   └── notifications/         SMS (stub | twilio), delivery records
│   └── shared/                    db, models, JWT/RBAC, errors, service client
└── test/                          Mocha/Chai suites (one per flow) + support/
```

## 11. Environment variables

All are optional locally. See [.env.example](.env.example) for the full list with comments.
The important ones: `MONGODB_URI`, `JWT_SECRET`, `INTERNAL_SERVICE_KEY`, `API_KEYS`,
`RATE_LIMIT_MAX`, `RATE_LIMIT_WINDOW_MS`, `GEO_PROVIDER` (`nominatim`|`mock`),
`SMS_PROVIDER` (`stub`|`twilio`) and the `TWILIO_*` settings.

## 12. Troubleshooting

* **`EADDRINUSE`**: something already uses port 8080 or 4001–4005. Stop it or change the ports in `.env`.
* **Address search returns 502**: Nominatim is unreachable (no internet or temporarily blocked). Set `GEO_PROVIDER=mock`.
* **First `npm test` / `npm start` is slow**: it is downloading the in-memory MongoDB binary once.
* **Windows PowerShell blocks `npm`**: run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`, or use `npm.cmd`.
