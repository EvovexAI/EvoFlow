import type { Metadata } from "next";
import { TerminalPage } from "@/components/terminal/terminal-page";

export const metadata: Metadata = {
  title: "Terminal",
  description: "Interactive terminal interface for the AI-native platform.",
};

export default function Page() {
  return <TerminalPage />;
}
