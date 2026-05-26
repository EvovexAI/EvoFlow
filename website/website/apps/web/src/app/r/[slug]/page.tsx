import { ResumePage } from "@/components/resume-page";
import { ResumeAccessGate } from "@/components/resume/resume-access-gate";
import { RESUME_SECRET_SLUG } from "@/lib/resume-access";
import type { Metadata } from "next";
import { notFound } from "next/navigation";

/**
 * 私密履历：/r/{RESUME_SECRET_SLUG}?k=MTIzNDU2（123456 的 Base64）
 * 本地示例：http://localhost:3000/r/h8f2-xK9m-p7wR?k=MTIzNDU2
 */
export const metadata: Metadata = {
  title: "景银泰 · 履历",
  description:
    "Agent Harness 研发方向的个人履历：EvoFlow 与企业级 AI/架构经验。支持导出 Word / PDF。",
  robots: { index: false, follow: false },
};

export function generateStaticParams() {
  return [{ slug: RESUME_SECRET_SLUG }];
}

export default async function Page({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  if (slug !== RESUME_SECRET_SLUG) {
    notFound();
  }

  return (
    <ResumeAccessGate>
      <ResumePage />
    </ResumeAccessGate>
  );
}
