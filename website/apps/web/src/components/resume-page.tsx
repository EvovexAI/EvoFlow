"use client";

import { type LocalizedValue, resumeDocByLocale } from "@ai-site/content";
import { useLocalizedValue } from "./locale-provider";
import { ReactResumeTemplateView } from "./resume/react-resume-template-view";

const resumeFooterByLocale: LocalizedValue<{ backHome: string }> = {
  zh: { backHome: "返回首页" },
  en: { backHome: "Back to home" },
};

export function ResumePage() {
  const doc = useLocalizedValue(resumeDocByLocale);
  const footer = useLocalizedValue(resumeFooterByLocale);

  return <ReactResumeTemplateView doc={doc} footerBackLabel={footer.backHome} />;
}
