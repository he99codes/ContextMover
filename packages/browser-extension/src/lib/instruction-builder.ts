import type { ContextSession } from './types'

export function buildInstructionPrompt(params: {
  session: ContextSession
  targetPlatform: string
  tier: 1 | 2 | 3
  task?: string
  filename: string
  estimatedTokens: number
  caveman?: boolean
}): string {
  const { session, targetPlatform, tier, task, filename, estimatedTokens, caveman } = params

  const tierNames: Record<number, string> = {
    1: 'Full Context',
    2: 'Smart Summary',
    3: 'Attention Engine'
  }

  const userMessages = session.messages.filter(m => m.role === 'user')
  const tail = session.messages.slice(-3)
  const originalGoal = userMessages[0]?.content?.slice(0, 200) ?? 'See uploaded file'
  const currentFocus = task
    ?? tail.find(m => m.role === 'user')?.content?.slice(0, 150)
    ?? 'Continue from where we left off'

  const caveatBlock = caveman
    ? '\n\nResponse style: Caveman mode. No filler. Code normal. Answer then stop.'
    : ''

  if (targetPlatform === 'claude') {
    return `<context_migration>
  <instruction>
    I am continuing a conversation from ${session.platform}.
    The full context has been exported as: ${filename}
    Please wait for me to upload this file, then continue
    from exactly where the conversation left off.
  </instruction>
  <session>
    <platform>${session.platform}</platform>
    <title><![CDATA[${session.title}]]></title>
    <messages>${session.messages.length}</messages>
    <migration_tier>${tierNames[tier]}</migration_tier>
    <estimated_tokens>~${estimatedTokens.toLocaleString()}</estimated_tokens>
  </session>
  <goal>
    <original><![CDATA[${originalGoal}]]></original>
    <current><![CDATA[${currentFocus}]]></current>
  </goal>
  <next_step>
    I will now upload the file: ${filename}
    Once uploaded, continue from exactly where we left off.
    Do not re-explain what was already decided.
    ${task ? `Current focus: ${task}` : ''}${caveatBlock}
  </next_step>
</context_migration>`
  }

  if (targetPlatform === 'gemini') {
    return `[CONTEXTMOVER MIGRATION]
Source: ${session.platform} | Messages: ${session.messages.length} | Tier: ${tierNames[tier]}

[INSTRUCTION]
I am continuing a conversation from ${session.platform}.
The full context has been exported to: ${filename}
I will upload this file now. Once uploaded, continue
from exactly where the conversation left off.

[ORIGINAL GOAL]
${originalGoal}

[CURRENT FOCUS]
${currentFocus}

[NEXT STEP]
Uploading file: ${filename}
After upload: continue from where we left off.
${task ? `Focus on: ${task}` : ''}
Do not re-explain what was already decided.${caveatBlock}`
  }

  // ChatGPT / Grok / Perplexity / DeepSeek
  return `## ContextMover Migration

**From:** ${session.platform} → **${targetPlatform}**
**Session:** ${session.title}
**Messages:** ${session.messages.length} | **Tier:** ${tierNames[tier]}
**Context file:** \`${filename}\`

### What's happening
I'm continuing a conversation from ${session.platform}.
The full context has been exported to \`${filename}\`.
I'm uploading it now — once uploaded, please continue
from exactly where we left off.

### Original goal
${originalGoal}

### Current focus
${currentFocus}

${task ? `### Task\n${task}\n` : ''}### Instructions
- Read the uploaded file for full context
- Continue from exactly where the conversation left off
- Do not re-explain what was already decided
- Treat all decisions and code in the file as shared context${caveatBlock}`
}
