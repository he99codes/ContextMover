# ContextMover Verification & Migration Plan

## Phase 1: System Verification

### Semantic Index & Transformers
- [ ] ONNX embedding (all-MiniLM-L6-v2, 384-dim) working
- [ ] Offscreen document spawns for heavy indexing
- [ ] Chunks stored in chunkEmbeddings table
- [ ] Cosine similarity retrieval working
- [ ] Query embedding cache (30s TTL) functional

### Attention Engine & Tree-Sitter
- [ ] Tree-sitter WASM loads (web-tree-sitter)
- [ ] Language grammars loaded (TS, JS, Python, etc.)
- [ ] Code block extraction from messages
- [ ] AST parsing (functions, classes, imports)
- [ ] Fallback to regex when tree-sitter fails
- [ ] AppStructure persistence across sessions

### Tier 3 Migration Pipeline
- [ ] Session indexed before Tier 3
- [ ] Attention chunks retrieved by query
- [ ] Message ranking by relevance score
- [ ] Top-K selection (default 15 chunks)
- [ ] XML generation with full context
- [ ] Code-aware extraction working

## Phase 2: Session ID Analysis

### Current System
```
Our ID: chatgpt-56b50f461f (generated)
ChatGPT: /c/abc-123-def (from URL)
Perplexity: /search/uuid-456 (from URL)
Claude: No native ID (SPA)
Grok: No native ID (SPA)
Gemini: No native ID (SPA)
DeepSeek: No native ID (SPA)
```

### Storage Locations
1. chrome.storage.local: "cf:urlMap" → URL → ourSessionId
2. IndexedDB: sessions table with our sessionId as PK
3. Drive sync: uses our sessionId
4. Chunk embeddings: sessionId field

## Phase 3: Migration to Native LLM IDs

### Goals
- Use LLM provider IDs when available (ChatGPT, Perplexity)
- Keep generated IDs for others (Claude, Grok, Gemini, DeepSeek)
- ZERO data loss during migration
- Backward compatibility

### Implementation Plan

#### Task 1: Extract Native IDs (Week 1)
- [ ] Modify fetch-interceptor.ts to capture conversation_id
- [ ] Store nativeId in session metadata
- [ ] Create mapping: nativeId → ourSessionId

#### Task 2: Dual ID System (Week 2)
```typescript
interface Session {
  id: string;              // Our generated ID (stable PK)
  nativeId?: string;       // LLM provider ID (when available)
  platform: Platform;
  // ... rest
}
```

#### Task 3: URL-Only Platforms (Week 2)
- Claude: Use URL hash (no native ID)
- Grok: Use URL hash (no native ID)
- Gemini: Use URL + conversation state hash
- DeepSeek: Use URL hash (no native ID)

#### Task 4: Data Migration (Week 3)
- [ ] Map existing sessions to native IDs
- [ ] Update Drive sync records
- [ ] Update chunk embeddings
- [ ] Handle conflicts (duplicate detection)

#### Task 5: Verification (Week 4)
- [ ] All 6 LLMs tested
- [ ] No data loss
- [ ] Drive sync working
- [ ] Semantic index intact
- [ ] Tier 3 migration functional

### Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Data loss during ID change | Keep our ID as PK, add nativeId field |
| Drive sync conflicts | Migration script with conflict resolution |
| Chunk embeddings orphaned | Update sessionId field in embeddings |
| URL-only platforms | Keep using URL-based IDs (no change) |

## Console Commands for Verification

```javascript
// Check indexing status
await getPerfStatsFromConsole()

// Check session storage
await listRecentSessions(20)

// Verify chunk embeddings
const chunks = await dexieDb.chunkEmbeddings.count()
console.log(`Total chunks: ${chunks}`)

// Test retrieval
const result = await semanticIndex.retrieve("session-id", "test query", 5)
console.log(`Retrieved ${result.chunks.length} chunks`)

// Check tree-sitter
console.log(`Tree-sitter available: ${attentionEngine.treeSitterAvailable}`)
```

## Success Criteria
- [ ] All indexing under 5s per session
- [ ] Tree-sitter parses 90%+ code blocks
- [ ] Tier 3 retrieval returns relevant chunks
- [ ] No session ID collisions
- [ ] Drive sync stable
- [ ] Zero data loss post-migration
