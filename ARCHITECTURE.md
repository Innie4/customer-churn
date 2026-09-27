# Architecture

How the system is put together, and why it is put together that way. The README
covers how to run it; this covers the decisions behind it.

## The shape of the problem

Churn modelling is easy to demo badly. A notebook produces a score, a chart
looks convincing, and the number is treated as a fact. Three things make that
misleading, and they shape the design here:

1. **Oversampling before a train/test split leaks.** Resampling the whole
   dataset and then splitting puts synthetic near-duplicates of the same customer
   on both sides. Reported accuracy goes up and generalisation does not.
2. **A score is not actionable on its own.** Ranking customers by probability
   tells you who to worry about. It does not tell you what to offer them.
3. **A feature importance list is not an explanation.** A customer's
   contribution is specific to that customer, and a global importance ranking
   cannot substitute for it.

The platform therefore treats the explanation as a required output, not an
optional extra, and it verifies the explanation before trusting it.

## Layers

```
Browser
  │  Pages are server components. Mutations go through server actions.
  ▼
Route handlers and server actions        src/app/(app), src/app/actions, src/app/api
  │  Thin: parse input, check a capability, call the data access layer.
  ▼
Data access layer                          src/lib/dal/*
  │  Every function resolves the session and authorises before touching the
  │  database. This is the only place SQL is written.
  ├──────────────────────────────►  db/client.ts  ──►  PostgreSQL
  │                                  PGlite locally, managed server in production
  └──────────────────────────────►  src/lib/ml-client.ts  ──►  FastAPI service
                                     the only network path to Python
```

The rule that makes authorisation reliable: **no page, route or component
writes SQL.** A route handler that forgot a permission check would be a hole, so
route handlers cannot express one. `src/lib/dal/access.ts` exposes
`requireActor` and `requireCapability`, and the capability is named at the call
site, so reviewing a data access function shows its permissions in one line.

## Sessions and passwords

**Passwords** use scrypt from Node's own `crypto`, at N=2^15, r=8, p=1. The
stored value is self-describing:

```
scrypt$<N>$<r>$<p>$<salt-b64>$<hash-b64>
```

Carrying the cost parameters in the hash means they can be raised later without
invalidating existing passwords. Verification is constant-time and returns
`false` for a malformed stored hash rather than throwing, so a corrupted row
cannot turn the login path into a crash. `verifyPasswordHash` also caps the
parameters it will honour, so a hostile stored value cannot ask Node for an
enormous allocation.

**Sessions** are opaque random tokens in an `HttpOnly`, `SameSite=Lax` cookie.
Only the SHA-256 of the token is stored, so a database disclosure does not yield
usable session cookies. The cookie carries no claims of its own: each request
reads the session row, which is what makes a role change or a sign-out take
effect immediately rather than at token expiry. Each user has a `session_epoch`
that is bumped when their password changes, so existing sessions stop working.

The pure cryptography and the policy live apart from the application wrapper:

- `src/lib/auth/crypto.ts` — scrypt, token hashing. No `server-only`, so the
  seed script and tests hash through the same code the application verifies with.
- `src/lib/auth/policy.ts` — the password rules.
- `src/lib/auth/password.ts` — `server-only`, composes the two for the app.

## Roles

| Role | Read | Upload data | Train | Activate a model | Create retention actions | Manage users and settings |
| --- | --- | --- | --- | --- | --- | --- |
| `admin` | yes | yes | yes | yes | yes | yes |
| `analyst` | yes | yes | yes | yes | yes | no |
| `viewer` | yes | no | no | no | no | no |

Activation is modelled separately from training even though both are granted to
the same two roles today. They are distinct permissions (`canManageModels` and
`canActivateModels`) because activation is the decision that puts a set of
assumptions into production, and the schema requires it to be attributable: a
model cannot be active without a recorded activation time and the person who
activated it. Separating the permission means that decision can be restricted on
its own without restructuring anything.

## The database

Eight ordered, checksum-tracked SQL migrations in `db/migrations`. They are
plain SQL rather than a generated schema, so a reviewer can read exactly what
each migration does to the database.

**PGlite** is real PostgreSQL compiled to WebAssembly. It runs the same SQL,
the same constraints and the same triggers as a managed server, in a process
with no external dependency. That means the local database and the test database
behave like production, and the 45 schema tests assert real constraint
behaviour rather than a mock's idea of it. Production sets `DATABASE_URL` and
the same client switches drivers.

The constraints do real work, and several caught genuine mistakes during
development:

- `retention_strategies_approved_consistent` requires an approved strategy to
  record who approved it and when. The seed script was written to insert
  strategies as `approved`; the database refused it, correctly, because a script
  has no person to attribute an approval to. They are seeded as `proposed`.
- Risk bands and model activation state are maintained by triggers, so a
  prediction's band cannot disagree with its probability.
- The audit table is append-only. The only permitted update is setting
  `actor_user_id` to null when the user is deleted, which keeps the log intact
  while not blocking deletion.

## The ML service

A separate FastAPI process, because the work is genuinely different in kind:
cross-validated grid search over three model families takes minutes and holds
hundreds of megabytes, and it does not belong in a web request.

`src/lib/ml-client.ts` is the only module in the application that speaks HTTP to
Python. Nothing else knows the service exists, so the boundary is one file to
review and one place to change.

**Training runs in the background.** The service keeps a run registry in memory
with per-run status, progress and errors, and the application polls it. A request
never waits on a grid search.

**Preprocessing is fitted once and saved.** The fitted encoder and scaler are
serialised alongside the model. Scoring a new customer must use the
transformations that were fitted during training, not a fresh fit, or the
predictions are not comparable to the evaluation.

The cleaning that is *not* in that transformer — coercing `TotalCharges` to a
number, resolving its blanks, folding spelling variants of Yes and No, turning a
missing category into an explicit `Missing` level — lives in one function,
`clean_frame`, that every consumer of a stored preprocessor calls. The
alternative is a class of bug that is invisible in testing and fatal in
production: the training rows get cleaned, a fresh upload does not, and the
model quietly receives a differently-shaped frame. A dataset with one blank
`TotalCharges` is not an edge case; it is the sample dataset.

**Oversampling happens inside the pipeline.** `imblearn`'s `Pipeline` refits the
resampler on each cross-validation fold, so validation folds see only real rows.
This is the difference between an honest estimate and an inflated one, and it is
why the numbers this system reports are lower than a leaked-split equivalent
would show.

**Explanations are verified.** After computing SHAP values, the contributions are
summed and compared against the model's own prediction. If they do not
reconstruct it, `isExact` is false, the rebuilt value is reported, and the reason
is shown in the interface. The check is recomputed by the application rather than
taken from the service's word, and the result is reported as data — including the
`units` the values are in — so a client never has to re-derive it or parse a
sentence to find out. Linear models are explained in log-odds and tree models in
probability units, because a SHAP value is only interpretable once you know which
scale it is on, and conflating the two is a common source of misreading.

**Charts are served as bytes.** The service writes PNGs to its own plot
directory and reports their paths. Those paths mean nothing to the application
process, which does not share that filesystem, so the service also serves the
bytes at `/v1/plots/{name}`. The application records the chart name against the
model and streams it through an authenticated route. Reading the file from disk
would have worked in local development and failed in deployment — the kind of
difference that is invisible until it is too late. The name is resolved strictly
inside the plot directory on both sides, so a crafted name cannot read anything
else.

## The application interface

**Server components by default.** Pages read through the data access layer and
render on the server. A `"use client"` boundary appears only where interaction
demands it: forms, filters and panels. This keeps customer data out of the
client bundle.

**Forms report field-level errors.** A server action returns a typed result that
the form renders next to the field that caused the problem, rather than a
message at the top of a page the operator has to scroll back up.

**Success callbacks are effects, not render-time calls.** After a mutation
succeeds, any callback runs in `useEffect`. Calling a parent's setter while
rendering is not supported by React and is a source of subtle bugs.

**Every section has `loading.tsx` and `error.tsx`.** Loading states reserve the
shape of the page so the layout does not jump. An error boundary shows a
reference code, never a stack trace, a query or a configuration value.

**Numbers are formatted, not hard-coded.** Every figure in the interface comes
from a measurement in the database. There are no placeholder statistics, and no
component invents a value to fill a space.

## Storage

Uploaded datasets, model artefacts, charts and reports go to a private directory
outside `public/`. Downloads are streamed through an authenticated route.

`safeRelative` in `src/lib/storage.ts` filters path characters and then resolves
the path and compares it against the storage root. The resolve-and-compare is
the actual defence; the character filter is a convenience. An upload filename
like `../../etc/passwd` cannot escape, and the check runs on reads and deletes as
well as writes.

## Audit trail

Consequential activity is recorded: sign-ins, uploads, validation,
preprocessing, training, activation, predictions, explanations, retention
changes, report generation, settings changes. Each entry records who, when, what
resource, and the outcome, including denied attempts — a pattern of denials is
worth investigating, so it is recorded rather than hidden.

The writer redacts secrets before they reach the table, and the table itself is
append-only at the database level. An audit record that could be edited after
the fact would not be evidence of anything.

## Deliberate limitations

- **SHAP is not causal.** A driver is a reason the score is high. Nothing in the
  interface claims otherwise, and the wording throughout is chosen to avoid it.
- **A dataset without an identifier column degrades to row order.** Customers are
  then keyed `row-1`, `row-2`, and predictions are matched back by position. That
  is recorded on the dataset, stated when customers are loaded, and warned about
  when predictions are generated, because it is invisible on a small file and
  quietly wrong on a real one.
- **The retention strategy library is a starting point.** Strategies are seeded
  as proposals and matched to customers through their SHAP contributions. An
  administrator approves them.
- **Predictions reflect the data supplied.** Upload a dataset with a different
  distribution and the metrics will say so. The platform reports what it
  measured rather than what would be reassuring.
- **No self-service sign-up.** Accounts are created by an administrator. Adding
  public registration would mean adding the verification and abuse controls that
  go with it.

## Deployment checklist

- `DATABASE_URL` points at a real PostgreSQL server; `DATABASE_SSL=true` if the
  provider requires it.
- `SESSION_SECRET` is a fresh 32+ character secret, not a development value.
  Rotating it signs everyone out.
- `EMAIL_PROVIDER` is a real provider with `EMAIL_PROVIDER_API_KEY` and
  `EMAIL_FROM` set. With `log`, password reset links never reach a user.
- `ML_SERVICE_URL` is `https` and the service runs with
  `ML_REQUIRE_API_KEY=true` and an `ML_API_KEY` matching
  `ML_SERVICE_API_KEY`.
- `STORAGE_DIR` is on a persistent volume. Without one, reports and datasets
  disappear on redeploy.
- `npm run verify` passes.
- Migrations are applied as a deploy step, not on application start, so a
  rolling deploy does not race on schema changes.
