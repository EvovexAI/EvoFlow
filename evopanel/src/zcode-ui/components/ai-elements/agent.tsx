/*
 * Derived from vercel/ai-elements (packages/elements/src/agent.tsx).
 * Copyright 2023 Vercel, Inc. Licensed under Apache-2.0.
 * Modified by ZCode: local integration, formatting and adaptations.
 * See THIRD-PARTY-NOTICES.md in the repository root for license and provenance.
 */
"use client";

import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "../ui/accordion.js";
import { Badge } from "../ui/badge.js";
import { cn } from "../lib/utils.js";
import type { Tool } from "ai";
import { BotIcon } from "lucide-react";
import type { ComponentProps } from "react";
import { memo } from "react";

import { CodeBlock } from "./code-block.js";

export type AgentProps = ComponentProps<"div">;

export const Agent = memo(({ className, ...props }: AgentProps) => (
  <div className={cn("not-prose w-full rounded-md border", className)} {...props} />
));

export type AgentHeaderProps = ComponentProps<"div"> & {
  name: string;
  model?: string;
};

export const AgentHeader = memo(({ className, name, model, ...props }: AgentHeaderProps) => (
  <div className={cn("flex w-full items-center justify-between gap-4 p-3", className)} {...props}>
    <div className="flex items-center gap-2">
      <BotIcon className="size-4 text-muted-foreground" />
      <span className="font-medium text-ui-base">{name}</span>
      {model && (
        <Badge className="font-mono text-ui-base" variant="secondary">
          {model}
        </Badge>
      )}
    </div>
  </div>
));

export type AgentContentProps = ComponentProps<"div">;

export const AgentContent = memo(({ className, ...props }: AgentContentProps) => (
  <div className={cn("space-y-4 p-4 pt-0", className)} {...props} />
));

export type AgentInstructionsProps = ComponentProps<"div"> & {
  children: string;
};

export const AgentInstructions = memo(
  ({ className, children, ...props }: AgentInstructionsProps) => (
    <div className={cn("space-y-2", className)} {...props}>
      <span className="font-medium text-muted-foreground text-ui-base">Instructions</span>
      <div className="rounded-md bg-muted/50 p-3 text-muted-foreground text-ui-base">
        <p>{children}</p>
      </div>
    </div>
  ),
);

export type AgentToolsProps = ComponentProps<typeof Accordion>;

export const AgentTools = memo(({ className, ...props }: AgentToolsProps) => (
  <div className={cn("space-y-2", className)}>
    <span className="font-medium text-muted-foreground text-ui-base">Tools</span>
    <Accordion className="rounded-md border" {...props} />
  </div>
));

export type AgentToolProps = ComponentProps<typeof AccordionItem> & {
  tool: Tool;
};

export const AgentTool = memo(({ className, tool, value, ...props }: AgentToolProps) => {
  const schema = "jsonSchema" in tool && tool.jsonSchema ? tool.jsonSchema : tool.inputSchema;

  return (
    <AccordionItem className={cn("border-b last:border-b-0", className)} value={value} {...props}>
      <AccordionTrigger className="px-3 py-2 text-ui-base hover:no-underline">
        {tool.description ?? "No description"}
      </AccordionTrigger>
      <AccordionContent className="px-3 pb-3">
        <div className="rounded-md bg-muted/50">
          <CodeBlock code={JSON.stringify(schema, null, 2)} language="json" />
        </div>
      </AccordionContent>
    </AccordionItem>
  );
});

export type AgentOutputProps = ComponentProps<"div"> & {
  schema: string;
};

export const AgentOutput = memo(({ className, schema, ...props }: AgentOutputProps) => (
  <div className={cn("space-y-2", className)} {...props}>
    <span className="font-medium text-muted-foreground text-ui-base">Output Schema</span>
    <div className="rounded-md bg-muted/50">
      <CodeBlock code={schema} language="typescript" />
    </div>
  </div>
));

Agent.displayName = "Agent";
AgentHeader.displayName = "AgentHeader";
AgentContent.displayName = "AgentContent";
AgentInstructions.displayName = "AgentInstructions";
AgentTools.displayName = "AgentTools";
AgentTool.displayName = "AgentTool";
AgentOutput.displayName = "AgentOutput";
