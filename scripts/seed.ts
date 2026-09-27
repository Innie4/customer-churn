/**
 * Seed script.
 *
 * Creates the first administrator so the platform can be signed into, and
 * optionally seeds the retention strategy library from the study's documented
 * SHAP-to-strategy mapping.
 *
 * Safe to run repeatedly: existing accounts are left alone, and strategies are
 * matched on their driver so a re-run does not duplicate them.
 *
 *   npm run db:migrate
 *   SEED_ADMIN_EMAIL=admin@example.com SEED_ADMIN_PASSWORD=... npm run db:seed
 */

import { createDatabase, migrateClient } from "../db/client";
import { derivePasswordHash } from "../src/lib/auth/crypto";
import { checkPasswordPolicy } from "../src/lib/auth/policy";

interface SeedResult {
  createdUsers: number;
  skippedUsers: number;
  createdStrategies: number;
  skippedStrategies: number;
}

async function seed(): Promise<SeedResult> {
  const result: SeedResult = {
    createdUsers: 0,
    skippedUsers: 0,
    createdStrategies: 0,
    skippedStrategies: 0,
  };

  const email = process.env.SEED_ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.SEED_ADMIN_PASSWORD;

  if (!email || !password) {
    process.stderr.write(
      "SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD are both required. Nothing was seeded.\n" +
        "Generate a password with: openssl rand -base64 18\n",
    );
    process.exitCode = 1;
    return result;
  }

  const db = await createDatabase();

  try {
    const migration = await migrateClient(db, { verbose: true });
    if (migration.failed) {
      throw new Error(
        `Migration ${migration.failed.id} failed: ${migration.failed.error}`,
      );
    }

    const existing = await db.query<{ id: string }>(
      "SELECT id FROM users WHERE lower(email) = $1",
      [email],
    );

    if (existing.rows[0]) {
      process.stdout.write(
        `Administrator ${email} already exists. Left unchanged.\n`,
      );
      result.skippedUsers += 1;
    } else {
      // Hashed here rather than in a SQL literal, so the plain password never
      // reaches the database connection. The same policy the sign-up path
      // applies is enforced, so a seeded account meets the same bar.
      checkPasswordPolicy(password);
      const passwordHash = await derivePasswordHash(password);
      await db.query(
        `INSERT INTO users (email, password_hash, full_name, role, status)
         VALUES ($1, $2, 'Platform administrator', 'admin', 'active')
         RETURNING id`,
        [email, passwordHash],
      );
      await db.query(
        `INSERT INTO audit_logs (actor_email, action, resource_type, outcome, metadata)
         VALUES ($1, 'user.created', 'user', 'success', $2::jsonb)`,
        [email, JSON.stringify({ via: "seed script", role: "admin" })],
      );
      process.stdout.write(`Created administrator ${email}.\n`);
      result.createdUsers += 1;
    }

    // The strategy library from the study's SHAP-to-retention mapping, with the
    // source column set so each can be matched against a customer's SHAP
    // contributions.
    //
    // They are inserted as `proposed`, not `approved`. The schema requires an
    // approved strategy to record who approved it and when, and a seed script
    // has no person to attribute that to. Fabricating an approval would put a
    // false accountability record in the database. An administrator approves
    // each one through the UI, which is the intended workflow.
    const strategies = [
      {
        title: "Structured onboarding for new customers",
        description:
          "Customers with short tenure have had the least time to build a relationship with the provider and have the least to lose. Early, structured contact establishes the relationship before the point at which most churn happens.",
        triggeringCondition:
          "The customer's tenure is short and the model has flagged low tenure as pushing their churn risk up.",
        riskDriver: "Tenure (months)",
        sourceColumn: "tenure",
        intervention:
          "Run a structured onboarding sequence with check-ins at 30, 60 and 90 days, each confirming the service is working as expected.",
        priority: "high" as const,
      },
      {
        title: "Contract upgrade incentive",
        description:
          "Contract length is one of the strongest business-controlled levers the model identifies. A month-to-month customer can leave at any time with no friction; a longer commitment changes that.",
        triggeringCondition:
          "The customer is on a month-to-month contract and the model has flagged that as pushing their churn risk up.",
        riskDriver: "Contract: Month-to-month",
        sourceColumn: "Contract",
        intervention:
          "Offer a bill credit or a device upgrade in exchange for a 12-month commitment. Present it before their renewal date rather than after.",
        priority: "critical" as const,
      },
      {
        title: "Loyalty discount for high-bill, first-year customers",
        description:
          "Price sensitivity is real, and it is most acute early in the relationship when the customer has not yet built a sense of value against the bill.",
        triggeringCondition:
          "The customer's monthly charges are high and their tenure is short, and the model has flagged charges as pushing their churn risk up.",
        riskDriver: "Monthly charges",
        sourceColumn: "MonthlyCharges",
        intervention:
          "Offer a loyalty discount or a repriced bundle. Test whether price is genuinely the objection before assuming it is.",
        priority: "high" as const,
      },
      {
        title: "Move to automatic payment",
        description:
          "Manual billing correlates with lower engagement in the data. It is also a small, low-cost intervention that removes a recurring point of friction.",
        triggeringCondition:
          "The customer pays by a manual method and the model has flagged payment method as pushing their churn risk up.",
        riskDriver: "PaymentMethod",
        sourceColumn: "PaymentMethod",
        intervention:
          "Offer a one-time credit in exchange for moving to automatic card or bank transfer payment.",
        priority: "medium" as const,
      },
      {
        title: "Free trial of online security or technical support",
        description:
          "Customers without these add-ons correlate with higher churn in the data. Offering them is a way to increase engagement at the point where the model says engagement is thin.",
        triggeringCondition:
          "The customer does not have online security or technical support, and the model has flagged the absence as pushing their churn risk up.",
        riskDriver: "OnlineSecurity: No",
        sourceColumn: "OnlineSecurity",
        intervention:
          "Offer a free trial of online security or technical support, with a clear explanation of what each does for them.",
        priority: "medium" as const,
      },
      {
        title: "Proactive service quality check before renewal",
        description:
          "More active services mean more points at which something can go wrong. A proactive check before renewal catches problems before the customer decides to leave.",
        triggeringCondition:
          "The customer has few active services or an unusual service mix, and the model has flagged that as pushing their churn risk up.",
        riskDriver: "InternetService: Fiber optic",
        sourceColumn: "InternetService",
        intervention:
          "Run a service quality check shortly before the renewal date and resolve anything outstanding before the customer has to ask.",
        priority: "medium" as const,
      },
    ];

    for (const strategy of strategies) {
      const existing = await db.query<{ id: string }>(
        "SELECT id FROM retention_strategies WHERE risk_driver = $1 AND title = $2",
        [strategy.riskDriver, strategy.title],
      );
      if (existing.rows[0]) {
        result.skippedStrategies += 1;
        continue;
      }
      await db.query(
        `INSERT INTO retention_strategies
           (title, description, triggering_condition, risk_driver, source_column,
            suggested_intervention, priority, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'proposed')`,
        [
          strategy.title,
          strategy.description,
          strategy.triggeringCondition,
          strategy.riskDriver,
          strategy.sourceColumn,
          strategy.intervention,
          strategy.priority,
        ],
      );
      result.createdStrategies += 1;
    }

    await db.query(
      `INSERT INTO audit_logs (actor_email, action, resource_type, outcome, metadata)
       VALUES ($1, 'retention.strategy.created', 'strategy', 'success', $2::jsonb)`,
      [
        email,
        JSON.stringify({
          via: "seed script",
          created: result.createdStrategies,
          skipped: result.skippedStrategies,
        }),
      ],
    );

    process.stdout.write(
      `\nSeed complete.\n` +
        `  users created:       ${result.createdUsers}\n` +
        `  users skipped:       ${result.skippedUsers}\n` +
        `  strategies created:  ${result.createdStrategies}\n` +
        `  strategies skipped:  ${result.skippedStrategies}\n` +
        `\nSign in with ${email}.\n` +
        `Passwords are stored as scrypt hashes; the plain value is never written to the database.\n`,
    );
  } finally {
    await db.close();
  }

  return result;
}

seed()
  .then(() => {
    if (process.exitCode) process.exit(process.exitCode);
  })
  .catch((error: unknown) => {
    process.stderr.write(
      `Seeding failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  });
