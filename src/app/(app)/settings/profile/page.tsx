import type { Metadata } from "next";
import { ProfileForm, ChangePasswordForm } from "@/components/settings/profile-forms";
import {
  Card,
  CardBody,
  CardHeader,
  PageHeader,
  Section,
} from "@/components/ui";
import { currentActor } from "@/lib/dal/access";
import { getProfileDetail } from "@/lib/dal/users";
import { ROLE_DESCRIPTIONS, ROLE_LABELS } from "@/lib/dal/access";
import { notFound } from "next/navigation";

export const metadata: Metadata = { title: "Your profile" };
export const dynamic = "force-dynamic";

export default async function ProfileSettingsPage() {
  const actor = await currentActor();
  if (!actor) notFound();

  const profile = await getProfileDetail(actor.id);

  return (
    <>
      <PageHeader
        title="Your profile"
        description="Your name and contact details, and the password you sign in with."
      />

      <div className="grid gap-6 lg:grid-cols-2">
        <Section title="Details">
          <Card>
            <CardHeader
              title="Who you are"
              description={`${ROLE_LABELS[actor.role]} — ${ROLE_DESCRIPTIONS[actor.role]}`}
            />
            <CardBody>
              <ProfileForm
                fullName={actor.fullName}
                email={actor.email}
                jobTitle={profile?.job_title ?? ""}
                department={profile?.department ?? ""}
                phone={profile?.phone ?? ""}
              />
            </CardBody>
          </Card>
        </Section>

        <Section title="Password">
          <Card>
            <CardHeader
              title="Change your password"
              description="Changing it signs out every other session. This one stays, so you are not signed out of the page you are on."
            />
            <CardBody>
              <ChangePasswordForm />
            </CardBody>
          </Card>
        </Section>
      </div>
    </>
  );
}
