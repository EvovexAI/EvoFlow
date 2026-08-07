import type { Metadata } from "next";
import { HomePage } from "@/components/home/homepage";
import { getHomeLanding } from "@ai-site/content";

const landing = getHomeLanding();

export const metadata: Metadata = {
  title: landing.meta.title,
  description: landing.meta.description,
};

export default function Page() {
  return <HomePage />;
}
