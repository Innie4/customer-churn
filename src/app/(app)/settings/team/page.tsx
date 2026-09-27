import type { Metadata } from "next";
import Link from "next/link";
import { ForceSignOutButton } from "@/components/settings/team-controls";
import {
  Badge,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Notice,
  PageHeader,
  Section,
  StatusBadge,
  Table,
  Td,
  Th,
  Tr,
} from "@/components/ui";
import { currentActor, ROLE_DESCRIPTIONS, ROLE_LABELS } from "@/lib/dal/access";
import { listUsers } from "@/lib/dal/users";
import { formatDate, formatRelative } from "@/lib/format";

export const metadata: Metadata = { title: "Team" };
export const dynamic = "force-dynamic";

/**
 * The team.
 *
 * Who can sign in, and what each role may do. Read-only apart from forcing a
 * sign-out: user provisioning is a deliberate operator action, not a button
 * anyone can press by accident.
 */
export default async function TeamPage() {
  const [users, actor] = await Promise.all([listUsers(), currentActor()]);
  const isAdmin = actor?.role === "admin";

  return (
    <>
      <PageHeader
        title="Team"
        description="Everyone with access to this platform, and what their role permits."
      />

      <Section title="Roles">
        <div className="grid gap-4 sm:grid-cols-3">
          {(["admin", "analyst", "viewer"] as const).map((role) => (
            <Card key={role}>
              <CardHeader
                title={ROLE_LABELS[role]}
                description={`${users.filter((user) => user.role === role).length} user(s)`}
              />
              <CardBody>
                <p className="text-sm text-ink-muted">
                  {ROLE_DESCRIPTIONS[role]}
                </p>
              </CardBody>
            </Card>
          ))}
        </div>
      </Section>

      {!isAdmin ? (
        <Section title="People">
          <Notice tone="info" title="Read-only">
            You can see who has access, but only an administrator can force a
            sign-out.
          </Notice>
        </Section>
      ) : null}

      <Section title="People">
        <Card>
          {users.length === 0 ? (
            <EmptyState
              title="No users"
              description="No accounts exist. Run the seed script with an administrator email and password to create the first one."
            />
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Name</Th>
                  <Th>Email</Th>
                  <Th>Role</Th>
                  <Th>Status</Th>
                  <Th align="right">Last signed in</Th>
                  {isAdmin ? <Th align="right">Sessions</Th> : null}
                </tr>
              </thead>
              <tbody>
                {users.map((user) => (
                  <Tr key={user.id}>
                    <Td>
                      <span className="font-medium">{user.fullName}</span>
                      {user.id === actor?.id ? (
                        <Badge tone="info" className="ml-1.5">
                          you
                        </Badge>
                      ) : null}
                      <p className="text-2xs text-ink-subtle">
                        Added {formatDate(user.createdAt, "short")}
                      </p>
                    </Td>
                    <Td className="text-xs text-ink-muted">{user.email}</Td>
                    <Td className="text-xs">{ROLE_LABELS[user.role]}</Td>
                    <Td>
                      <StatusBadge status={user.status} />
                    </Td>
                    <Td align="right" className="text-xs text-ink-subtle">
                      {user.lastLoginAt ? formatRelative(user.lastLoginAt) : "never"}
                    </Td>
                    {isAdmin ? (
                      <Td align="right">
                        {user.id === actor?.id ? (
                          <span className="text-2xs text-ink-faint">
                            current session
                          </span>
                        ) : (
                          <ForceSignOutButton
                            userId={user.id}
                            displayName={user.fullName}
                          />
                        )}
                      </Td>
                    ) : null}
                  </Tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      </Section>

      <p className="mt-2 text-sm">
        <Link href="/settings" className="text-action underline underline-offset-2">
          ← Back to settings
        </Link>
      </p>
    </>
  );
}
