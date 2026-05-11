import type { Metadata } from "next";
import { HomePage } from "@/components/home/homepage";

export const metadata: Metadata = {
  title: "EvoFlow | Super-agent orchestration",
  description:
    "EvoFlow — open-source framework for sub-agents, memory, sandbox execution, and extensible skills.",
};

export default function Page() {
  return <HomePage />;
}
