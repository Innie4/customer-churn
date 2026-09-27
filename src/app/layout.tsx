import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

/*
 * Inter is loaded once, with a system fallback, so the interface renders the
 * same whether or not the font request succeeds.
 */
const interfaceFont = Inter({
  variable: "--font-interface",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: {
    default: "Churn Intelligence",
    template: "%s · Churn Intelligence",
  },
  description:
    "Interpretable customer churn prediction and strategic retention. " +
    "Every prediction traces to a model, every explanation says what it can " +
    "and cannot claim, and every retention action is recorded.",
  robots: {
    // The platform holds customer data. It has no business in an index.
    index: false,
    follow: false,
  },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${interfaceFont.variable} h-full`}>
      <body className="min-h-full">
        <a href="#main" className="skip-link">
          Skip to main content
        </a>
        {children}
      </body>
    </html>
  );
}
