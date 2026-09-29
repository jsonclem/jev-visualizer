import type { Metadata } from "next";
import { Chakra_Petch, Share_Tech_Mono, Tektur } from "next/font/google";
import "./globals.css";

const sans = Chakra_Petch({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-chakra-petch",
});
const display = Tektur({ subsets: ["latin"], variable: "--font-tektur" });
const mono = Share_Tech_Mono({ subsets: ["latin"], weight: "400", variable: "--font-share-tech-mono" });

export const metadata: Metadata = {
  title: "Task History",
  description: "History of task-contract tasks in Active Tasks.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${sans.variable} ${display.variable} ${mono.variable}`}>
      <body className="min-h-screen font-sans antialiased">{children}</body>
    </html>
  );
}
