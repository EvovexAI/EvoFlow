import type { Metadata } from "next";
import { HomePage } from "@/components/home/homepage";

export const metadata: Metadata = {
  title: "EvoFlow | Super-agent orchestration",
  description:
    "EvoFlow — super-agent framework for sub-agents, memory, sandbox execution, and extensible skills. Download releases and docs; star on GitHub for full source roadmap.",
};

export default function Page() {
  return <HomePage />;
}
