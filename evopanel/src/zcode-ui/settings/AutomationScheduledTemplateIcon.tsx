import { Activity, FileText, List, Target, type LucideIcon } from "lucide-react";
import { ClientSceneLucideIcon } from "@/components/ClientSceneLucideIcon.js";

export type AutomationScheduledTemplateIconName = "target" | "activity" | "file" | "list";

const TEMPLATE_ICONS: Record<AutomationScheduledTemplateIconName, LucideIcon> = {
  target: Target,
  activity: Activity,
  file: FileText,
  list: List,
};

export function AutomationScheduledTemplateIcon({
  className,
  iconName,
  name,
}: {
  className?: string;
  iconName?: string;
  name: AutomationScheduledTemplateIconName;
}) {
  const Icon = TEMPLATE_ICONS[name];
  return (
    <ClientSceneLucideIcon
      className={className}
      name={iconName}
      aria-hidden="true"
      size={16}
      strokeWidth={2}
      fallback={
        <Icon
          aria-hidden="true"
          className={className}
          data-automation-template-icon={name}
          size={16}
          strokeWidth={2}
        />
      }
    />
  );
}
