// packages/mcp-server/src/tools/apply-prompt-template.ts

import { z } from "zod";

import { SYSTEM_TEMPLATES, SYSTEM_TEMPLATE_KEYS }
  from "../lib/system-templates.js";
import type { SystemTemplateKey } from "../lib/system-templates.js";
import type { McpToolResult }     from "../types.js";

// Build the zod enum from the registry keys so we never drift.
const templateKeyEnum = z.enum(SYSTEM_TEMPLATE_KEYS as [SystemTemplateKey, ...SystemTemplateKey[]]);

export const applyPromptTemplateTool = {
  name: "apply_prompt_template",
  description:
    "Apply an expert prompt template to shape the AI's response style. " +
    "Templates configure the AI to act as a specific expert role. " +
    "Available: senior-engineer, debug-mode, code-reviewer, architecture, " +
    "teaching, speed, security-auditor, performance, test-writer, " +
    "documentation, refactoring, api-designer, database, devops, " +
    "open-source. Call at the start of a session to set the AI's persona.",
  inputSchema: z.object({
    template: templateKeyEnum.describe("Which expert persona to apply"),
    task:     z.string().max(2_000).optional().describe("Optional: specific task to focus on"),
    caveman:  z.boolean().default(false).describe("Caveman mode: strip filler words"),
  }),
};

type Input = z.infer<typeof applyPromptTemplateTool.inputSchema>;

export async function applyPromptTemplateHandler(input: Input): Promise<McpToolResult> {
  const template = SYSTEM_TEMPLATES[input.template];
  if (!template) {
    return {
      content: [{
        type: "text",
        text: `Template "${input.template}" not found. Available: ${SYSTEM_TEMPLATE_KEYS.join(", ")}`,
      }],
    };
  }

  const parts: string[] = [template.content];
  if (input.task) {
    parts.push(`\nCurrent task: ${input.task}`);
  }
  if (input.caveman) {
    parts.push(
`\nResponse style: Caveman mode.
No filler. No pleasantries. Code normal.
Technical terms exact. Answer then stop.`
    );
  }

  return {
    content: [{
      type: "text",
      text:
`${template.icon} ${template.name} mode activated.

Apply these instructions to all responses:

${parts.join("\n")}

---
Template applied. Proceed with your question.`,
    }],
  };
}
