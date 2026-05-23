"use client";

import { type LocalizedValue, resumeDocByLocale } from "@ai-site/content";
import { useLocalizedValue, useSiteLocale } from "./locale-provider";
import { ReactResumeTemplateView } from "./resume/react-resume-template-view";

export function ResumePage() {
  const { locale } = useSiteLocale();
  const doc = useLocalizedValue(resumeDocByLocale);

  return (
    <ReactResumeTemplateView doc={doc} footerBackLabel="" locale={locale} />
  );
}
