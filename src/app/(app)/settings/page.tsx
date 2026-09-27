import type { Metadata } from "next";
import Link from "next/link";
import { ThresholdsForm, MlSettingsPanel } from "@/components/settings/panels";
import {
  Badge,
  Card,
  CardBody,
  CardHeader,
  Detail,
  DetailList,
  Notice,
  PageHeader,
  Section,
  StatusBadge,
  Table,
  Td,
  Th,
  Tr,
} from "@/components/ui";
import { currentActor } from "@/lib/dal/access";
import { getDependencyStatus } from "@/lib/dal/reports";
import { getMlSettings, getRiskThresholds, listSettings } from "@/lib/dal/settings";
import { validateConfig, ENV_SPECS } from "@/lib/env";
import { formatDate, formatNumber } from "@/lib/format";

export const metadata: Metadata = { title: "Settings" };
export const dynamic = "force-dynamic";

/**
 * Settings.
 *
 * Reports the operator-relevant state of the deployment: what is configured,
 * what is not, and whether the dependencies answer. Configuration problems are
 * named but never valued, so this page cannot leak a secret.
 */
export default async function SettingsPage() {
  const [actor, thresholds, ml, settings, dependencies] = await Promise.all([
    currentActor(),
    getRiskThresholds(),
    getMlSettings(),
    listSettings(),
    getDependencyStatus(),
  ]);

  const problems = validateConfig();
  const canManage = actor?.role === "admin" || actor?.role === "analyst";

  return (
    <>
      <PageHeader
        title="Settings"
        description="Platform configuration, the state of this deployment, and the environment it needs."
        actions={
          <div className="flex gap-2">
            <Link
              href="/settings/profile"
              className="rounded-control border border-line-strong bg-surface px-2.5 py-1.5 text-sm text-ink hover:bg-surface-sunken"
            >
              Your profile
            </Link>
            <Link
              href="/settings/team"
              className="rounded-control border border-line-strong bg-surface px-2.5 py-1.5 text-sm text-ink hover:bg-surface-sunken"
            >
              Team
            </Link>
            <Link
              href="/settings/model"
              className="rounded-control border border-line-strong bg-surface px-2.5 py-1.5 text-sm text-ink hover:bg-surface-sunken"
            >
              Model settings
            </Link>
          </div>
        }
      />

      {problems.length > 0 ? (
        <Section title="Configuration">
          <Notice tone="caution" title={`${problems.length} configuration requirement(s) not met`}>
            <ul className="mt-1 list-disc space-y-1 pl-4">
              {problems.map((problem) => (
                <li key={problem.variable}>
                  <span className="font-medium">{problem.variable}</span> —{" "}
                  {problem.message}
                </li>
              ))}
            </ul>
            <p className="mt-2 text-xs">
              The platform still runs; whatever depends on the missing value will
              not work. See{" "}
              <code className="font-mono">ENVIRONMENT.md</code> for where each
              value comes from.
            </p>
          </Notice>
        </Section>
      ) : (
        <Section title="Configuration">
          <Notice tone="positive" title="Configuration is complete">
            Every environment variable this deployment needs is set. The platform
            declares {ENV_SPECS.length} variables in total.
          </Notice>
        </Section>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <Section title="Risk thresholds">
          <Card>
            <CardHeader
              title="Bands applied to every prediction"
              description="Stored with each prediction, so a band can always be re-derived from its probability."
            />
            <CardBody>
              {canManage ? (
                <ThresholdsForm thresholds={thresholds} />
              ) : (
                <DetailList>
                  <Detail label="High at or above">
                    {(thresholds.high * 100).toFixed(0)}%
                  </Detail>
                  <Detail label="Medium at or above">
                    {(thresholds.medium * 100).toFixed(0)}%
                  </Detail>
                </DetailList>
              )}
              <p className="mt-3 border-t border-line pt-3 text-xs text-ink-subtle">
                Changing the thresholds does not re-band existing predictions. They
                keep the thresholds that were in force when they were made, so a
                historical reading stays reproducible. Re-score to apply new
                thresholds.
              </p>
            </CardBody>
          </Card>
        </Section>

        <Section title="Dependencies">
          <Card>
            <CardHeader
              title="What this deployment is talking to"
              description="Reported as reachable or not. No configuration value is shown."
            />
            <CardBody>
              <Table>
                <thead>
                  <tr>
                    <Th>Dependency</Th>
                    <Th>Status</Th>
                    <Th>Detail</Th>
                  </tr>
                </thead>
                <tbody>
                  <Tr>
                    <Td>Database</Td>
                    <Td>
                      <StatusBadge status="ok" />
                    </Td>
                    <Td className="text-xs text-ink-muted">
                      Answering queries
                    </Td>
                  </Tr>
                  <Tr>
                    <Td>Machine learning service</Td>
                    <Td>
                      {dependencies.ml ? (
                        <StatusBadge status="ok" />
                      ) : (
                        <StatusBadge status="failed" />
                      )}
                    </Td>
                    <Td className="text-xs text-ink-muted">
                      {dependencies.ml
                        ? `Version ${dependencies.ml.version}. ${
                            dependencies.ml.authentication_required
                              ? "API key required"
                              : "No API key configured"
                          }`
                        : "Not answering. Training, prediction and explanation are unavailable until it is running."}
                    </Td>
                  </Tr>
                </tbody>
              </Table>

              {dependencies.ml ? (
                <div className="mt-3">
                  <h3 className="mb-1.5 text-2xs font-semibold tracking-wide text-ink-subtle uppercase">
                    Library versions in the ML service
                  </h3>
                  <div className="flex flex-wrap gap-1.5">
                    {Object.entries(dependencies.ml.library_versions).map(
                      ([name, version]) => (
                        <Badge key={name} tone="neutral">
                          {name} {version}
                        </Badge>
                      ),
                    )}
                  </div>
                  <p className="mt-2 text-xs text-ink-subtle">
                    Recorded so a result can be reproduced: version differences can
                    shift figures slightly.
                  </p>
                </div>
              ) : null}
            </CardBody>
          </Card>
        </Section>
      </div>

      <Section title="Model settings">
        <Card>
          <CardBody>
            <MlSettingsPanel settings={ml} />
            <p className="mt-3 border-t border-line pt-3 text-xs text-ink-subtle">
              These are the defaults a new training run uses. Each run records the
              values it actually used, so changing a default never rewrites
              history.
            </p>
          </CardBody>
        </Card>
      </Section>

      <Section title="All settings">
        <Card>
          <Table>
            <thead>
              <tr>
                <Th>Key</Th>
                <Th>Value</Th>
                <Th>Last changed</Th>
                <Th>By</Th>
              </tr>
            </thead>
            <tbody>
              {settings.map((setting) => (
                <Tr key={setting.key}>
                  <Td className="font-mono text-xs">{setting.key}</Td>
                  <Td className="font-mono text-2xs text-ink-muted">
                    {JSON.stringify(setting.value)}
                  </Td>
                  <Td align="right" className="text-xs text-ink-subtle">
                    {formatDate(setting.updatedAt, "short")}
                  </Td>
                  <Td className="text-xs text-ink-muted">
                    {setting.updatedByName ?? "System"}
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
          <div className="border-t border-line px-4 py-3">
            <p className="text-xs text-ink-subtle">
              {formatNumber(settings.length)} settings. Every change is recorded in
              the audit trail with who made it.
            </p>
          </div>
        </Card>
      </Section>
    </>
  );
}
