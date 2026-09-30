# Customer Churn Prediction and Retention Platform

An interpretable customer churn system. It takes a churn dataset through
validation, preprocessing, model comparison and activation, then scores
customers, explains each score with SHAP, and turns those explanations into
retention actions a person approves and tracks.

The point of the platform is the last part of that chain. A churn score on its
own does not tell anyone what to do, and a feature importance list does not
belong to any individual customer. This system produces a per-customer,
mathematically verified explanation and then matches it to a concrete
intervention, so the reasoning behind an action is visible to the person taking
it.

## What it does not claim

- SHAP values show how the model reached a score. They are **not** causal. A
  driver is a reason the score is high, not proof that changing the factor
  changes the outcome.
- Model metrics are measured from the data you upload. Nothing is hard-coded and
  no figure in the interface is a placeholder.
- Retention suggestions are proposals. A person approves them, and the platform
  records who did and when.
- A model is not usable until an administrator activates it. Training a model
  does not put it into production.

## Stack

| Layer | Technology |
| --- | --- |
| Web application | Next.js 16 (App Router, React 19, TypeScript, Tailwind CSS 4) |
| Machine learning | Python 3.11, FastAPI, pandas, scikit-learn, imbalanced-learn, XGBoost, SHAP, Matplotlib |
| Database | PostgreSQL. Embedded PGlite locally and in tests; a managed server in production |
| Authentication | scrypt password hashing, opaque server-side sessions, role-based authorisation |
| Validation | Zod at every boundary |

## Browsing the interface without Python

The whole interface can be browsed with no Python installed and nothing
listening on port 8000. In that mode the machine learning service is stood in
for by an in-process simulator, and every figure it produces is generated rather
than learned.

    npm run demo:seed     # build a demo world
    npm run demo:dev      # start the application in simulated mode
    npm run demo:reset    # start again from an empty database
    npm run demo:check    # request every page and report what rendered

demo:seed writes the demo credentials to .data/demo-credentials.txt, which
is ignored by Git, and demo:dev prints them on start.

Nothing else changes. The pages, the data access layer, the eleven migrations,
sessions, roles and the audit trail are the same code either way; only the
outbound call to the Python service is replaced. That means an upload,
preprocessing, training, prediction, explanation, retention action and report
can all be performed from the browser with simulated mode on, and the demo data
is created by the same functions that serve the pages.

Two things are deliberately different, and both are stated on screen:

  - Every model metric, probability and SHAP value is generated. A banner
    appears on every page, and /api/health reports simulated: true.
  - The charts are drawn by a small renderer in src/lib/simulate/charts.ts
    rather than by Matplotlib.

Simulated mode is for looking at the product. It is not evidence that the model
works, and it must never be enabled in production: the value is read at runtime
and the health endpoint reports it.

## Quick start

Prerequisites: Node.js 20+ and Python 3.11+.

```bash
# 1. Install
npm install
python -m pip install -r ml-service/requirements.txt

# 2. Configure
cp .env.example .env.local
#    Set SESSION_SECRET to at least 32 characters:
#    node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"

# 3. Create the schema and the first administrator
npm run db:migrate
SEED_ADMIN_EMAIL=you@example.com SEED_ADMIN_PASSWORD='choose-a-strong-one' npm run db:seed

# 4. Start the machine learning service (terminal 1)
npm run ml:dev

# 5. Start the application (terminal 2)
npm run dev
```

Open <http://localhost:3000> and sign in with the administrator you seeded.

There is no separate registration page by design. Accounts are created by an
administrator, so an unauthenticated visitor cannot reach the platform at all.

To try it with data, upload `sample-data/Telco-Customer-Churn.csv`. It is the
public IBM Telco Customer Churn dataset: 7,043 rows, a 26.5% churn rate, and 11
rows with a blank `TotalCharges` where the customer happened to churn in their
first month. The dataset inspector reports those rows rather than silently
dropping them.

## How the pieces fit

```
Browser
  │  server components render pages; forms post to server actions
  ▼
Next.js application  ── src/lib/ml-client.ts is the only path to Python ──┐
  │                                                                       │
  ├── db/client.ts ──► PostgreSQL (PGlite locally)                        │
  │                    datasets, models, predictions,                    │
  │                    explanations, retention, audit                    │
  │                                                                       ▼
  └── src/lib/dal/*  ────────────────────────────►  FastAPI ML service
                                                         preprocessing,
                                                         training, SHAP,
                                                         charts
```

Model artefacts, charts and reports are written to the private storage
directory, never to `public/`. Downloads are streamed through an authenticated
route that resolves the path against the storage root and refuses anything
outside it.

`ARCHITECTURE.md` describes the layers, the request flow and the design
decisions in more detail.

## The pipeline, end to end

1. **Upload and inspect.** Structure, dtypes, missing values, duplicates and
   class balance are recorded as findings. Errors block the next step; warnings
   do not, and they stay visible on the dataset page.
2. **Validate and preprocess.** `TotalCharges` is coerced to numeric, and the
   blank values are filled with zero, which is the true total for a customer
   who churned in month zero. Categorical columns are normalised, binaries are
   mapped to 0/1, and the remainder are one-hot encoded. The scaler and encoder
   are fitted on the training split only and then saved, so scoring a new
   customer uses the same transformations that were fitted during training.
3. **Train and compare.** Logistic Regression, Random Forest and XGBoost, each
   tuned by grid search against AUC-ROC with stratified 5-fold cross-validation.
   Oversampling happens inside the cross-validation loop, never before it;
   oversampling before the split leaks synthetic duplicates into the validation
   folds and inflates the scores.
4. **Evaluate.** Test-set metrics, confusion matrices, ROC curves and decile
   lift. Validation and test numbers are reported separately and never
   substituted for one another.
5. **Activate.** An administrator activates one model, giving a reason. The
   decision is recorded in the audit trail. Only the active model scores
   customers.
6. **Predict and explain.** Every customer gets a probability, a risk band, and
   a SHAP breakdown checked for additivity. If the contributions do not
   reconstruct the prediction, the explanation is marked as not exact and the
   reason is shown rather than hidden.
7. **Act.** The explanation is matched to the retention strategy library. An
   operator creates an action, which is tracked to completion.

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Application on <http://localhost:3000> |
| `npm run ml:dev` | ML service on <http://127.0.0.1:8000> |
| `npm run db:migrate` | Apply pending migrations |
| `npm run db:migrate:status` | Show which migrations have been applied |
| `npm run db:seed` | Create the first administrator and the strategy library |
| `npm run db:verify` | Check that the seeded account can authenticate |
| `npm run ml:smoke` | Run the whole ML pipeline on the sample dataset |
| `npm run test:e2e:ml` | Drive the running ML service over HTTP against the sample dataset |
| `npm run test:e2e:app` | Drive the running application end to end, through every stage |
| `npm run env:docs` | Regenerate `.env.example` and `ENVIRONMENT.md` |
| `npm run typecheck` | Generate route types, then typecheck |
| `npm run lint` | Lint the application, database, scripts and tests |
| `npm run test` | Database and API tests (Vitest) |
| `npm run ml:test` | Machine learning tests, including the HTTP layer (pytest) |
| `npm run verify` | Everything above that can run without a server |
| `npm run verify:all` | `verify` plus a production build |
| `npm run build` | Production build |

### End-to-end checks

Two scripts drive real processes over HTTP rather than calling functions. Both
need their service running:

```bash
# Machine learning service
ML_SERVICE_API_KEY=your-key npm run ml:dev            # terminal 1
ML_SERVICE_API_KEY=your-key npm run test:e2e:ml       # terminal 2

# The application, with the ML service also running
E2E_EMAIL=you@example.com E2E_PASSWORD=... npm run test:e2e:app
```

`test:e2e:app` walks the whole chain against the real sample dataset: sign in,
upload, validate, preprocess, load customers, train, activate, score all 7,043
customers, explain one, create and complete a retention action, generate and
download a report, change a setting, then read the audit trail back.

## Tests

```bash
npm run verify
```

165 database and API tests, and 139 machine learning tests. The API tests call
the real route handlers against a real PostgreSQL build with its real
constraints and triggers; only two things are substituted, the database being
isolated in memory and the machine learning service being a local stub. The stub
returns figures that are internally consistent — its SHAP contributions really do
rebuild its predictions — because an incoherent stub would let a real defect hide
behind it.

Several genuine defects lived only in the layer between the functions and the
wire, and none were visible to tests that called the functions directly: a
training submit that read a renamed field, a prediction that handed an
already-encoded matrix to a pipeline expecting raw columns, a helper that dropped
its keyword arguments, a plot route that failed on a missing import, and an
`ArtifactError` handler that crashed while reporting a 404. Those are covered in
`ml-service/tests/test_api.py` and `tests/api/`.

The pipeline tests also cover the failure cases: a missing target column, a
dataset with one class, a malformed stored hash, a hostile hash demanding an
enormous allocation, a missing categorical value, and an explanation whose
additivity check fails.

## Configuration

`.env.example` is generated from `src/lib/env-specs.ts`, which is the single
source of truth. `ENVIRONMENT.md` documents each variable. Two settings decide
where the platform can run at all:

- `DATABASE_URL` is optional locally, where PGlite provides a real embedded
  PostgreSQL. Production requires it.
- `EMAIL_PROVIDER` defaults to `log`, which writes password reset links to the
  server log. That is for local work. Production must set a real provider.

`npm run build` and the health endpoint both fail loudly if a required secret is
missing, rather than starting in a half-configured state.

## Project layout

```
db/                 Migrations and the database client
ml-service/         FastAPI service: pipeline, training, SHAP, tests
sample-data/        The public sample dataset
scripts/            Migration, seed and documentation tooling
src/app/            Routes, server actions, API handlers
src/components/     Presentational and interactive components
src/lib/            Auth, configuration, storage, audit, data access
tests/db/           Schema and constraint tests
ARCHITECTURE.md     How the system is put together
ENVIRONMENT.md      Every environment variable
```

## Deployment

The application builds with `npm run build` and runs with `npm start`. The ML
service runs under uvicorn and is reached only over the internal network, with
`ML_REQUIRE_API_KEY=true` so a stray process on the network cannot submit data
for training. A production deployment needs a real PostgreSQL server, a real
email provider, and a persistent volume for the storage directory. See
`ARCHITECTURE.md` for the deployment checklist.
