# FundiConnect — Independent Local Edition

FundiConnect is a React + TypeScript construction-workforce platform for Kenya. This edition removes AppDeploy-specific dependencies and runs locally with an Express API and a SQLite database.

## Technology

- Frontend: React, TypeScript, Vite and Lucide icons
- Backend: Node.js, Express and TypeScript
- Database: SQLite using `better-sqlite3`
- Authentication: local email/password accounts, bcrypt password hashing and JWT sessions
- Evidence files: local `uploads/` directory (5 MB maximum per file)

## Requirements

- Node.js 20 or newer (Node 22 LTS recommended)
- npm
- VS Code (recommended editor)

## Run on Windows

1. Extract the `FundiConnect-Local.zip` archive.
2. Open the extracted `FundiConnect-Local` folder in VS Code (`File` → `Open Folder`).
3. Open the VS Code terminal (`Terminal` → `New Terminal`).
4. Install dependencies:

   ```bash
   npm install
   ```

5. Copy `.env.example` to `.env`. It defaults to development mode. For production, run `npm start`, which forces `NODE_ENV=production`, and set `JWT_SECRET` to the standard Base64 encoding of 48 cryptographically random bytes (for example, generate one with `node -e "console.log(require('node:crypto').randomBytes(48).toString('base64'))"`); the production entry point refuses to start unless the value has this format and passes additional strength checks. Production also requires an HTTPS `CLIENT_ORIGIN` and absolute `DATABASE_FILE` and `UPLOAD_DIR` paths. Use persistent storage if your host provides it; local paths inside an ephemeral deployment filesystem may be cleared by the host.
6. Start frontend and backend together:

   ```bash
   npm run dev
   ```

7. Open **http://localhost:5174**. The API runs at **http://localhost:4000**. Vite uses port 5174 by default so its origin matches the local password-reset links.

The SQLite database is created automatically at `data/fundiconnect.sqlite` the first time the API starts. Uploaded evidence is saved privately in `uploads/` and is downloadable only by its owner or an assessor/administrator through authenticated API requests. Evidence uploads accept PDF, JPEG and PNG files up to 5 MB.

For a separately hosted production frontend, set `VITE_API_BASE_URL` to the API host origin (without an `/api` path) before building the frontend. The frontend appends its existing `/api/...` routes to this origin. Leave it empty for development or when a same-origin reverse proxy routes `/api` to the backend. Configure the backend `CLIENT_ORIGIN` to the exact frontend origin, use HTTPS for both hosts, and allow the frontend origin in any hosting-platform or gateway CORS policy. Build the frontend again after changing `VITE_API_BASE_URL`; it is a public build-time setting and must not contain credentials. Keep the API `JWT_SECRET`, database path, upload path and email-provider credentials exclusively in the backend environment.

Database upgrades run automatically as ordered, transactional migrations. The current schema version is available in `PRAGMA user_version`; the migration names and timestamps are recorded in `schema_migrations`. Foreign-key enforcement is enabled for the API connection, business-history relationships use restrictive deletion, and failed or inconsistent migrations stop startup without deleting records.

## Provision the first administrator

When ready to create the first administrator, stop the API and run this command from the project root in an interactive terminal:

```bash
npm run admin:bootstrap
```

The command uses the configured `DATABASE_FILE` or the existing `data/fundiconnect.sqlite` file. It refuses to create a missing database, does not run migrations, prompts for the name and email, and reads the password and confirmation without displaying their characters. Use a valid email and a password of at least 12 characters with at least 8 distinct characters. Creation is refused if an administrator already exists or the email is already in use. The account uses the existing `administrator` role and `pending` verification status; this status tracks worker/evidence verification and does not block administrator login or permissions. Do not mark the administrator verified unless a verification workflow explicitly supports that action. The account creation is recorded in the audit log. The password is hashed with bcrypt before storage. Public registration cannot create administrator accounts.

## Build for production

```bash
npm run build
npm start
```

The production frontend build is written to `dist/`. `npm start` runs the API in production mode and serves that frontend and its client-side routes from the same web service. For a single-service deployment such as Render, use build command `npm ci --include=dev && npm run build` and start command `npm start`. Set `NODE_ENV=production`, `JWT_SECRET` (standard Base64 encoding of 48 cryptographically random bytes), `DATABASE_FILE` and `UPLOAD_DIR` (absolute writable paths, such as `/tmp/fundiconnect.sqlite` and `/tmp/fundiconnect-uploads` on an ephemeral Linux service). Render's `RENDER_EXTERNAL_URL` automatically provides the public HTTPS service URL for CORS; set `CLIENT_ORIGIN` only if you use a custom domain or need to override it. Do not set `VITE_API_BASE_URL`; same-origin relative API requests are used. SQLite and uploaded evidence remain local to the service and may be lost when its ephemeral filesystem is cleared. The production process uses Render's `PORT` and binds to `0.0.0.0`. CORS is restricted to the configured client origin. Leave password-reset email disabled unless Resend credentials and sender configuration have been securely supplied and verified. Set `TRUST_PROXY` only to the actual trusted proxy hop count or IP ranges used by the deployment; it defaults to disabled. The API applies per-process, per-IP limits to login (10 per 15 minutes), registration (5 per hour), password-reset requests (5 per hour) and reset submissions (10 per 15 minutes). Override each count/window with the corresponding `*_RATE_LIMIT_MAX` and `*_RATE_LIMIT_WINDOW_MS` settings in `.env.example`. For multiple API replicas, configure equivalent limits at the gateway because in-memory API counters are not shared across instances.

### Deploy this repository to Render

Use the connected repository's `main` branch and a **Free Web Service**. Set the build command to `npm ci --include=dev && npm run build` and the start command to `npm start`. Add these service environment variables before deploying:

| Key | Value |
| --- | --- |
| `NODE_ENV` | `production` |
| `JWT_SECRET` | Generate a unique value with `node -e "console.log(require('node:crypto').randomBytes(48).toString('base64'))"` and keep it private. |
| `CLIENT_ORIGIN` | Optional. Render's `RENDER_EXTERNAL_URL` is used automatically; set this only to override it (for example, when using a custom domain). |
| `DATABASE_FILE` | `/tmp/fundiconnect.sqlite` |
| `UPLOAD_DIR` | `/tmp/fundiconnect-uploads` |
| `TRUST_PROXY` | `1` |

Render supplies `PORT`; do not set it manually. Leave `VITE_API_BASE_URL` unset so the frontend uses same-origin API requests. Do not enable password-reset email unless Resend credentials and sender configuration are ready. The free instance's database and uploaded files are ephemeral; export or back up any data you need to keep. After deploying, create the initial administrator with `npm run admin:bootstrap` in an interactive service shell if that feature is available for the service plan. The bootstrap command refuses to overwrite an existing administrator.

## Main features included

- Public registration and login with roles: fundi and foreman. Public assessor registration is disabled. Administrators can provision assessor accounts from **Users**; choose a strong initial password and share it with the assessor through a separate secure channel. Provisioning is audited.
- Administrator-only access is reserved for an administrator account provisioned by the project owner with `npm run admin:bootstrap`; public registration cannot select administrator
- Fundi profile and trade information
- Foreman job posting, editing, closing/reopening and owner-scoped application review
- Fundi application history with pending, accepted, rejected and withdrawn states; pending applications can be edited or withdrawn
- Applications are checked against the existing matching and eligibility rules, and acceptance does not create an assignment
- Explainable rule-based job matching
- Job matching weights are skills 30%, verification 25%, experience 15%, location 10%, availability 10% and published performance 10%.
- Multi-trade crew recommendations
- Employer work rosters are grouped by job; only accepted applications can be deliberately turned into assignments
- Assignment editing, valid status transitions, cancellation without history deletion, fundi progress updates and employer attendance management
- Role-scoped assignment details and participation history, with status/progress/attendance changes recorded in the existing audit log
- Skills evidence uploads and assessor review
- Performance reviews require valid assignment and verified attendance relationships and cannot be duplicated for an assignment
- Dispute submission
- Notifications and administrator overview/audit log API
- The administrator dashboard presents read-only counts from users, jobs, applications, assignments, attendance, disputes, evidence and notifications; access requires an administrator account.

### Matching and eligibility

Matching scores are capped to 0–100. Skills contribute 30 points proportionally to required job skills (30 when the job has no specific skill requirements). Verification contributes 25 points for a verified profile and 0 otherwise. Experience contributes up to 15 points in proportion to the job minimum, capped at 15; a zero minimum earns 15. Location contributes 10 points for an exact case-insensitive location match and 0 otherwise. Availability contributes 10 points only for the explicit `Available` status. Performance contributes 10 points scaled from the average published 1–5 review. When there are no published reviews, a documented neutral rating of 2.5/5 contributes 5 points.

Trade is a hard eligibility requirement and does not add points outside the six weighted categories. Eligibility also requires all specified skills, sufficient experience, `Available` status, and verification when the job requires it. Recommendation results and API application checks use this same matcher; recommendations show eligible candidates first and include reasons and unmet criteria.

Experience values are stored in the existing numeric duration and unit columns. Matching normalizes them using 365 days per year and 12 months per year (365/12 days per month). Missing legacy units default to years. New fundi registrations and profile updates require a positive, bounded duration; a job minimum may be zero. Fundi skills and job required skills use the existing JSON-backed columns and accept comma-separated names or name arrays.

## Local data and backup

- Database: `data/fundiconnect.sqlite`
- Uploaded evidence: `uploads/`

Stop the server before copying the SQLite database for a backup. Back up both the database and uploads folder. Deleting either removes local project data.

## Important limitations

This is an independent local migration of the existing FundiConnect concept and workflows, not a byte-for-byte copy of the AppDeploy deployment. The original cloud app's users, database records, uploaded evidence and authentication sessions are **not** automatically copied into this local edition. The local SQLite database starts empty. The application uses local storage and local authentication; it does not provide public hosting, SMS delivery, or email delivery unless the production Resend integration is configured and independently verified. It does not provide statutory trade accreditation. Review and test all workflows before using it with real users or sensitive records.

Forgot-password requests in development write a single-use reset link to the API server console; links expire after 30 minutes. In development, the API logs its environment, resolved database path and configured frontend origin at startup, and logs whether a reset request matched an account (with the email masked). Production password-reset delivery supports Resend: configure `EMAIL_PROVIDER=resend`, `RESEND_API_KEY`, `EMAIL_FROM` and an HTTPS `CLIENT_ORIGIN`. Delivery stays disabled unless `PASSWORD_RESET_EMAIL_ENABLED=true`; enable it only after configuring and independently verifying the provider with your account. Automated tests mock provider responses and do not verify real delivery. Reset tokens are never returned by the production API or written to production logs. Successful password resets invalidate existing JWT sessions. Configure your hosting provider’s rate limiter too when running multiple API instances.

Run the password-reset API integration tests with:

```bash
npm test
```

The test suite uses isolated temporary SQLite databases and also covers fresh schema initialization, legacy upgrades, migration repeatability and rollback, foreign keys and constraints, job ownership, application lifecycle transitions, accepted-application assignment creation, assignment authorization and transitions, attendance, progress history, eligibility, duplicate submissions and database integrity. It does not write to `data/fundiconnect.sqlite`.

## Troubleshooting

- If port 5174 or 4000 is busy, stop the other process or set `VITE_PORT` / `PORT` to an available port. Set `CLIENT_ORIGIN` to the frontend URL used to open reset links.
- If native SQLite installation fails, install the current Node.js LTS release and Windows build tools, then retry `npm install`.
- If you change `.env`, restart the backend process.
