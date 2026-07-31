import type { Metadata } from "next";
import "./styles.css";

export const metadata: Metadata = {
  title: "Forgekeeper | TrinityCore Workshop",
  description: "Local creature, gossip, and SmartAI authoring tools for TrinityCore",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
