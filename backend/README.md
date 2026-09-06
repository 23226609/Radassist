# RadAssist AI — Backend

Express + Mongoose + MongoDB backend for the FYP system.

## Run locally

```bash
cd backend
npm install
npm run dev          # nodemon on :5002
# or
npm start            # plain node on :5002
```

## Seed the database

```bash
npm run seed
```

This inserts three demo users (doctor / nurse / admin) and ~6 sample
patient cases (with X-ray images uploaded to GridFS). The seed script
is idempotent: re-running it will skip records it has already created.

## Endpoints

| Method | Path | Auth | Notes |
|--------|------|------|-------|
| `GET`  | `/api/health`         | public | Pings MongoDB |
| `POST` | `/api/auth/login`     | public | Returns JWT + user |
| `POST` | `/api/auth/register`  | public | Self-signup nurse (doctors/admins seeded) |
| `GET`  | `/api/auth/me`        | auth   | Current user |
| `GET`  | `/api/users`          | admin  | List all users |
| `GET`  | `/api/cases`          | auth   | Filter by `status`, `patientId`, `q` |
| `POST` | `/api/cases`          | doctor | Upload X-ray + AI analysis |
| `GET`  | `/api/cases/:id`      | auth   | Single case |
| `PUT`  | `/api/cases/:id`      | doctor | Edit findings / finalize |
| `DELETE`| `/api/cases/:id`     | admin  | Hard delete |
| `GET`  | `/api/images/:id`     | auth   | Stream GridFS image |
| `GET`  | `/api/audit-logs`     | admin  | Audit trail, filter by action/user |
| `GET`  | `/api/stats`          | auth   | Dashboard counters |
