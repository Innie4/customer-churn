import type { Metadata } from "next";
import {
  Card,
  CardBody,
  CardHeader,
  PageHeader,
  Section,
  Table,
  Td,
  Th,
  Tr,
} from "@/components/ui";
import { currentActor } from "@/lib/dal/access";
import { getMlSettings, getRiskThresholds } from "@/lib/dal/settings";
import { validateConfig, ENV_SPECS } from "@/lib/env";

/**
 * Model and pipeline settings.
 *
 * A dedicated view of the values a training run depends on, plus the reference
 * for every environment variable this deployment reads. Names and purposes are
 * shown; no value is ever displayed.
 */
export const metadata: Metadata = { title: "Model settings" };
export const dynamic = "force-dynamic";

export default async function ModelSettingsPage() {
  await currentActor();
  const [ml, thresholds] = await Promise.all([
    getMlSettings(),
    getRiskThresholds(),
  ]);
  const problems = validateConfig();

  return (
    <>
      <PageHeader
        title="Model settings"
        description="The values a new training run uses, and the environment this deployment needs to run at all."
      />

      <Section title="Pipeline defaults">
        <Card>
          <CardHeader
            title="Applied to new runs"
            description="Every run records the values it actually used, so changing a default never rewrites history."
          />
          <CardBody>
            <Table>
              <thead>
                <tr>
                  <Th>Setting</Th>
                  <Th align="right">Value</Th>
                  <Th>Why it matters</Th>
                </tr>
              </thead>
              <tbody>
                <Tr>
                  <Td>Cross-validation folds</Td>
                  <Td align="right">{ml.cvFolds}</Td>
                  <Td className="text-xs text-ink-muted">
                    Stratified folds inside the training split. More folds give a
                    steadier estimate and take proportionally longer.
                  </Td>
                </Tr>
                <Tr>
                  <Td>Random seed</Td>
                  <Td align="right">{ml.randomSeed}</Td>
                  <Td className="text-xs text-ink-muted">
                    Fixes the split and the tuning search, so a run can be
                    reproduced exactly.
                  </Td>
                </Tr>
                <Tr>
                  <Td>SMOTE</Td>
                  <Td align="right">{ml.smoteEnabled ? "Enabled" : "Disabled"}</Td>
                  <Td className="text-xs text-ink-muted">
                    Balances the churn class during training only. The test split
                    is never resampled, so evaluation keeps the real class
                    distribution.
                  </Td>
                </Tr>
                <Tr>
                  <Td>Test share</Td>
                  <Td align="right">{(ml.testSize * 100).toFixed(0)}%</Td>
                  <Td className="text-xs text-ink-muted">
                    Held out from training and tuning. Larger values give a
                    steadier estimate and less training data.
                  </Td>
                </Tr>
                <Tr>
                  <Td>Model families</Td>
                  <Td align="right">{ml.defaultModelTypes.length}</Td>
                  <Td className="text-xs text-ink-muted">
                    {ml.defaultModelTypes.map((type) => type.replace(/_/g, " ")).join(", ")}
                  </Td>
                </Tr>
                <Tr>
                  <Td>Scoring metric</Td>
                  <Td align="right">AUC-ROC</Td>
                  <Td className="text-xs text-ink-muted">
                    Used to choose hyperparameters, because it measures ranking
                    quality across every threshold rather than at one cutoff.
                  </Td>
                </Tr>
                <Tr>
                  <Td>Risk thresholds</Td>
                  <Td align="right">
                    {(thresholds.medium * 100).toFixed(0)}% /{" "}
                    {(thresholds.high * 100).toFixed(0)}%
                  </Td>
                  <Td className="text-xs text-ink-muted">
                    medium / high. Stored with every prediction, so a band can
                    always be re-derived from its probability.
                  </Td>
                </Tr>
              </tbody>
            </Table>
          </CardBody>
        </Card>
      </Section>

      <Section title="Environment this deployment needs">
        <Card>
          <CardHeader
            title={`${ENV_SPECS.length} variables`}
            description="Names, purposes and where each value comes from. No value is ever displayed here."
          />
          <Table>
            <thead>
              <tr>
                <Th>Variable</Th>
                <Th>Purpose</Th>
                <Th>Source</Th>
                <Th align="right">Required</Th>
              </tr>
            </thead>
            <tbody>
              {ENV_SPECS.map((spec) => {
                const unmet = problems.some(
                  (problem) => problem.variable === spec.name,
                );
                return (
                  <Tr key={spec.name}>
                    <Td>
                      <code className="font-mono text-xs">{spec.name}</code>
                      {unmet ? (
                        <span className="ml-1.5 text-2xs text-critical">
                          not set
                        </span>
                      ) : null}
                    </Td>
                    <Td className="max-w-md text-xs text-ink-muted">
                      {spec.purpose}
                    </Td>
                    <Td className="text-2xs text-ink-subtle">{spec.source}</Td>
                    <Td align="right" className="text-xs">
                      {spec.required ? (
                        <span className="text-critical">yes</span>
                      ) : (
                        <span className="text-ink-faint">optional</span>
                      )}
                    </Td>
                  </Tr>
                );
              })}
            </tbody>
          </Table>
          <div className="border-t border-line px-4 py-3">
            <p className="text-xs text-ink-subtle">
              Full detail, including which service reads each variable and
              whether it is safe in a browser, is in{" "}
              <code className="font-mono">ENVIRONMENT.md</code>. Only variables
              prefixed with <code className="font-mono">NEXT_PUBLIC_</code> reach
              browser code, and none of them is secret.
            </p>
          </div>
        </Card>
      </Section>
    </>
  );
}
