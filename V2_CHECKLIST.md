# ContextMover V2 - AI Memory Layer

## Marketing Positioning: "Universal AI Memory"

### Current Problem
Sidebar shows technical badges ("⚡ indexing...", "📱 Local") instead of communicating value.

### New Positioning Strategy
Position as **AI Memory Infrastructure** - not just "chat exporter"

### UI Changes Required

#### 1. Header Rebranding
FROM: "ContextMover CMD CENTER v1"
TO: "AI Memory Layer" / "Universal Context Across AIs"

#### 2. Empty State Value Prop
"Your conversations become searchable memory. Open ChatGPT, Claude, or Gemini to start building your cross-AI context layer."

#### 3. Badge Language
- "⚡ indexing..." → "Building memory index..."
- "📱 Local" → "Private storage"

#### 4. Feature Prominence
Move **Knowledge Synthesizer** to primary UI - currently hidden. This is the moat feature.

---

## V2 Features

### Cross-Browser Compatibility
- [ ] **Firefox** - MV3 support, replace chrome.identity, handle missing sidePanel
- [ ] **Safari** - Web Extension conversion, App Store distribution
- [ ] **Edge/Brave** - Testing matrix (Chromium-based)

### Personalized AI (Cross-LLM Knowledge Base)
- [ ] Extract patterns from migrated context across all LLMs
- [ ] Build user-specific knowledge base (stack, preferences, recurring problems)
- [ ] Surface personalized AI in sidebar with full cross-LLM history awareness
- [ ] Privacy-first: local processing with opt-in cloud sync

---

## Knowledge Synthesizer V2

### Architecture: 2-Step Deep Context System

#### STEP 1: Full Context Aggregation
**User Flow:**
1. User writes query about topic they want to work on
2. Semantic search finds ALL sessions with related context
3. System combines FULL context from matching sessions into XML file

**Example:**
- User query: "Build a React component library"
- Matches: 5 sessions (Claude design discussion, ChatGPT implementation, Gemini debugging)
- Output: Combined XML with all messages from all 5 sessions
- Size: ~4MB (uncompressed full context)

**Technical:**
- Semantic query across all session embeddings
- Retrieve full message arrays from matched sessions
- Generate unified migration XML with session boundaries preserved
- Single-click migration to target LLM

#### STEP 2: Deep Context (Compressed Intelligence)
**User Flow:**
When 4MB is too large or user wants optimized context:
1. Same semantic search finds related sessions
2. Attention Engine extracts ONLY most relevant message chunks
3. Knowledge synthesizer compresses into distilled context

**Example:**
- Same 5 sessions (4MB full)
- Deep Context extracts key insights, decisions, code blocks, solutions
- Output: 1MB compressed knowledge file
- Contains: Essential patterns without conversation fluff

**Technical:**
- Multi-session chunk ranking by relevance score
- Deduplication across sessions (same solution mentioned twice = once)
- Hierarchical summarization: session-level → cross-session synthesis
- Code block preservation with context
- Decision/rationale extraction

### UI Implementation
- [ ] "Knowledge Synthesizer" button in sidebar header
- [ ] Step selector: "Full Context (4MB)" vs "Deep Context (1MB)"
- [ ] Query input with semantic preview (shows which sessions match)
- [ ] Migration preview before sending

### Competitive Moat
ContextWizard = Chat manager  
ContextMover = **AI Memory Infrastructure with Knowledge Synthesis**

---
