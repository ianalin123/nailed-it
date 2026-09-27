import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "@fontsource-variable/archivo/standard.css";
import "@fontsource/courier-prime/latin-400.css";
import "@fontsource/courier-prime/latin-700.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "Nailed It",
  description: "A party game where a model reads each player, and the room finds out if it was right.",
};

export const viewport: Viewport = {
  themeColor: "#2b3fe0",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
