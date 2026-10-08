import { ChevronDown, Loader2, Plus, Sparkles } from "lucide-react";
import type { CreateTaskRequest } from "@/app-shell/types.js";
import { Button } from "@/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { usePluginCreator } from "@/hooks/usePluginCreator.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export function PluginAddMenu({
  onCreateTask,
  onAddMarketplace,
  testId,
}: {
  onCreateTask?: (request?: CreateTaskRequest) => void;
  onAddMarketplace: () => void;
  testId: string;
}) {
  const { intl } = useZCodeIntl();
  const creator = usePluginCreator(onCreateTask);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="default" data-testid={testId}>
          {creator.busy ? <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> : null}
          {intl.formatMessage({ id: "pluginCreator.add" })}
          <ChevronDown className="size-3.5" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" data-testid="plugin-add-menu">
        <DropdownMenuItem
          data-testid="plugin-create-menu-item"
          disabled={creator.busy || !creator.available}
          onSelect={() => void creator.create()}
        >
          <Sparkles className="size-4" aria-hidden="true" />
          {intl.formatMessage({ id: "pluginCreator.create" })}
        </DropdownMenuItem>
        <DropdownMenuItem
          data-testid="plugin-store-add-source-menu-item"
          onSelect={onAddMarketplace}
        >
          <Plus className="size-4" aria-hidden="true" />
          {intl.formatMessage({ id: "pluginCreator.addMarketplace" })}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
