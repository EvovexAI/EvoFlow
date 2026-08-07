import { SkillsPage } from "@/components/skills/skills-page";
import { getSkillsPage } from "@ai-site/content";

const copy = getSkillsPage();

export const metadata = {
  title: copy.meta.title,
  description: copy.meta.description,
};

export default function Page() {
  return <SkillsPage />;
}
