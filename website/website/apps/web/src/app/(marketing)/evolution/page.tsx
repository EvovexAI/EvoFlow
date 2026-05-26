import type { Metadata } from "next";
import { EvolutionLogPage } from "@/components/platform-pages/evolution-log-page";

export const metadata: Metadata = {
  title: "演进日志 | EvoFlow",
  description:
    "超级总控智能体（Supervisor）长任务、上下游依赖、异步同步与任务监控、并发与持续运行、纠错重试与重新编排、定时任务与飞书汇报等产品能力演进里程碑（非编程语言清单）。",
};

export default function Page() {
  return <EvolutionLogPage />;
}

