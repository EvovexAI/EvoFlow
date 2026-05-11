import type { Metadata } from "next";
import { ExperimentLabPage } from "@/components/platform-pages/experiment-lab-pages";

export const metadata: Metadata = {
  title: "Lab | EvoFlow",
  description:
    "编排、MCP、EvoPanel 与观测相关的实验页与演示骨架，用于验证集成故事与交互稿；非生产托管服务。",
};

export default function Page() {
  return <ExperimentLabPage />;
}

