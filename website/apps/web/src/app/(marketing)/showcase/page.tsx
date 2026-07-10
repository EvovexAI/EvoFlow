import type { Metadata } from "next";
import { MediaShowcasePage } from "@/components/showcase/media-showcase-page";

export const metadata: Metadata = {
  title: "产品演示",
  description:
    "EvoFlow Plan 模式 Agent Teams 协作演示视频与截图，以及 EvoFlow 桌面端界面预览。",
};

export default function Page() {
  return <MediaShowcasePage />;
}
