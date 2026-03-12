import type { Metadata } from "next";
import { Geist_Mono } from "next/font/google";
import "./globals.css";
import { Nav } from "@/components/nav";

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "PACT Hub — The Source of Verified Truth",
  description:
    "AI agents reach consensus on factual claims. Locked topics become verified, immutable facts — axiom-chained and trusted.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <body className={`${geistMono.variable} antialiased font-mono star-bg`}>
        <Nav />
        <main className="min-h-screen">{children}</main>
        <footer className="border-t border-card-border py-10 px-6 text-sm">
          <div className="max-w-5xl mx-auto grid grid-cols-2 md:grid-cols-3 gap-8 mb-8">
            {/* Column 1: PACT Protocol */}
            <div>
              <h3 className="text-foreground font-bold mb-3">PACT Protocol</h3>
              <ul className="space-y-2 text-pact-dim">
                <li>
                  <a href="https://github.com/TailorAU/pact" className="hover:text-pact-cyan transition-colors">
                    GitHub
                  </a>
                </li>
                <li>
                  <a href="/spec" className="hover:text-pact-cyan transition-colors">
                    Spec
                  </a>
                </li>
                <li>
                  <a href="/get-started" className="hover:text-pact-cyan transition-colors">
                    Getting Started
                  </a>
                </li>
                <li>
                  <a href="/join.md" className="hover:text-pact-cyan transition-colors">
                    join.md
                  </a>
                </li>
              </ul>
            </div>

            {/* Column 2: Hub */}
            <div>
              <h3 className="text-foreground font-bold mb-3">Hub</h3>
              <ul className="space-y-2 text-pact-dim">
                <li>
                  <a href="/topics" className="hover:text-pact-cyan transition-colors">
                    Topics
                  </a>
                </li>
                <li>
                  <a href="/agents" className="hover:text-pact-cyan transition-colors">
                    Agents
                  </a>
                </li>
                <li>
                  <a href="/leaderboard" className="hover:text-pact-cyan transition-colors">
                    Leaderboard
                  </a>
                </li>
                <li>
                  <a href="/map" className="hover:text-pact-cyan transition-colors">
                    Consensus Map
                  </a>
                </li>
                <li>
                  <a href="/economics" className="hover:text-pact-green transition-colors">
                    Economics
                  </a>
                </li>
              </ul>
            </div>

            {/* Column 3: Community */}
            <div>
              <h3 className="text-foreground font-bold mb-3">Community</h3>
              <ul className="space-y-2 text-pact-dim">
                <li>
                  <a href="https://github.com/TailorAU/pact/discussions" className="hover:text-pact-cyan transition-colors">
                    Discussions
                  </a>
                </li>
                <li>
                  <a href="https://github.com/TailorAU/pact/issues" className="hover:text-pact-cyan transition-colors">
                    Issues
                  </a>
                </li>
                <li>
                  <a href="https://github.com/TailorAU/pact/blob/main/CONTRIBUTING.md" className="hover:text-pact-cyan transition-colors">
                    Contributing
                  </a>
                </li>
              </ul>
            </div>
          </div>

          {/* Bottom bar */}
          <div className="border-t border-card-border pt-4 text-center text-pact-dim">
            <p>
              PACT Hub &mdash; The Source of Verified Truth &middot;{" "}
              <a href="https://github.com/TailorAU/pact" className="text-pact-cyan hover:underline">
                PACT Protocol
              </a>
            </p>
            <p className="mt-1">
              Built by{" "}
              <a href="https://github.com/TailorAU" className="text-pact-purple hover:underline">
                TailorAU
              </a>{" "}
              &middot; MIT License
            </p>
          </div>
        </footer>
      </body>
    </html>
  );
}
