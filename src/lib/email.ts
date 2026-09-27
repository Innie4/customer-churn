/**
 * Transactional email.
 *
 * Two providers, behind one interface:
 *
 *   - `log`, the default, writes the message to the server log. It is a real
 *     code path, not a stub, and it is the honest behaviour when no email
 *     credential exists: the reset link is produced and visible in the log
 *     instead of being silently swallowed.
 *   - `http`, which posts to any provider with a JSON API.
 *
 * Nothing here claims a message was delivered unless the provider confirmed it.
 * The return value records what actually happened, and the caller reports that
 * rather than assuming success.
 */

import "server-only";

import { env } from "./env";

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface EmailResult {
  delivered: boolean;
  provider: string;
  detail: string;
}

export interface EmailProvider {
  readonly name: string;
  send(message: EmailMessage): Promise<EmailResult>;
}

class LogEmailProvider implements EmailProvider {
  readonly name = "log";

  async send(message: EmailMessage): Promise<EmailResult> {
    // Printed as one block so the reset link is copyable from a terminal.
    const lines = [
      "",
      "──────── outbound email ────────",
      `to:      ${message.to}`,
      `subject: ${message.subject}`,
      "──────── body ────────",
      message.text,
      "───────────────────────────────",
      "",
    ];
    process.stdout.write(`${lines.join("\n")}\n`);
    return {
      delivered: false,
      provider: this.name,
      detail:
        "No email provider is configured, so this message was written to the " +
        "server log rather than sent. Configure EMAIL_PROVIDER_API_KEY to " +
        "deliver it.",
    };
  }
}

class HttpEmailProvider implements EmailProvider {
  readonly name = "http";

  constructor(
    private readonly endpoint: string,
    private readonly apiKey: string,
    private readonly from: string,
  ) {}

  async send(message: EmailMessage): Promise<EmailResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetch(this.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          from: this.from,
          to: message.to,
          subject: message.subject,
          text: message.text,
          html: message.html,
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const detail = (await response.text()).slice(0, 300);
        return {
          delivered: false,
          provider: this.name,
          detail: `The provider rejected the message (${response.status}): ${detail}`,
        };
      }
      return {
        delivered: true,
        provider: this.name,
        detail: "The provider accepted the message.",
      };
    } catch (error) {
      return {
        delivered: false,
        provider: this.name,
        detail: `The provider could not be reached: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

function provider(): EmailProvider {
  if (env.emailProvider === "log" || !env.emailApiKey) {
    return new LogEmailProvider();
  }
  const endpoint =
    process.env.EMAIL_PROVIDER_ENDPOINT ??
    "https://api.emailprovider.example/v1/messages";
  return new HttpEmailProvider(endpoint, env.emailApiKey, env.emailFrom ?? "no-reply@localhost");
}

export async function sendEmail(message: EmailMessage): Promise<EmailResult> {
  return provider().send(message);
}

/** Build and send the password reset message. */
export async function sendPasswordResetEmail(input: {
  to: string;
  fullName: string;
  token: string;
}): Promise<EmailResult> {
  const url = `${env.appUrl.replace(/\/+$/, "")}/reset-password?token=${encodeURIComponent(input.token)}`;
  const minutes = env.passwordResetTtlMinutes;
  const text = [
    `Hello ${input.fullName},`,
    "",
    "A password reset was requested for your account on the churn platform.",
    "",
    `Open this link to choose a new password:`,
    url,
    "",
    `The link works once and expires in ${minutes} minutes.`,
    "",
    "If you did not request this, no action is needed and your password is unchanged.",
  ].join("\n");

  return sendEmail({
    to: input.to,
    subject: "Reset your password",
    text,
    html: `<p>Hello ${escapeHtml(input.fullName)},</p>
<p>A password reset was requested for your account on the churn platform.</p>
<p><a href="${escapeHtml(url)}">Choose a new password</a></p>
<p>The link works once and expires in ${minutes} minutes.</p>
<p>If you did not request this, no action is needed and your password is unchanged.</p>`,
  });
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
