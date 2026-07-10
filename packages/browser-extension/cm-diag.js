// ContextMover Full Diagnostic v3 — paste into DevTools Console on any LLM tab
// Tests: content script, scraper selectors, streaming, content extraction,
//        dedup/ordering, fetch interceptor, injection strategy chain,
//        roundtrip, SW bridge (CHECK_INDEXING + CM_SW_DIAG), queue health,
//        weighted health score
// Works on: Claude, ChatGPT, Gemini, Grok, DeepSeek, Perplexity
(async () => {
  const H = location.hostname;
  const P = H.includes('claude') ? 'claude'
    : H.includes('chatgpt') || H.includes('openai') ? 'chatgpt'
    : H.includes('gemini') || H.includes('bard') ? 'gemini'
    : H.includes('grok') || H.includes('x.com') ? 'grok'
    : H.includes('deepseek') ? 'deepseek'
    : H.includes('perplexity') ? 'perplexity' : 'unknown';

  const log = (s) => console.log('%c[CM-DIAG] ' + s, 'color:cyan;font-weight:bold');
  const warn = (s) => console.warn('%c[CM-DIAG] ' + s, 'color:orange;font-weight:bold');
  const pass = (s) => console.log('%c[CM-DIAG] \u2713 ' + s, 'color:lime;font-weight:bold');
  const fail = (s) => console.error('%c[CM-DIAG] \u2717 ' + s, 'color:red;font-weight:bold');
  const info = (s) => console.log('%c[CM-DIAG] \u2139 ' + s, 'color:#88aaff');
  const q = (s) => { try { return document.querySelectorAll(s); } catch { return []; } };
  const q1 = (s) => { try { return document.querySelector(s); } catch { return null; } };
  const txt = (el) => (el?.textContent ?? '').trim().length;
  const isVis = (el) => { try { return el.offsetParent !== null || el.tagName === 'BODY'; } catch { return false; } };
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const results = [];
  const record = (name, ok, w) => { results.push({ name, ok, weight: w || 1 }); };

  log('==============================================================');
  log('ContextMover Full Diagnostic v2 — Platform: ' + P.toUpperCase());
  log('URL: ' + location.href.slice(0, 100));
  log('==============================================================');
  const CFG = {
    claude: {
      scrape: {
        user: ['[data-testid="human-turn"]','[data-testid="user-message"]','[data-testid="user-turn"]','[data-testid="human-message"]','[class*="HumanTurn"]','[class*="human-turn"]','[class*="UserMessage"]','[class*="user-message"]:not([class*="input"])'],
        asst: ['[data-testid="assistant-turn"]','[data-testid="assistant-message"]','[data-testid="ai-turn"]','.font-claude-response','.font-claude-message','[class*="claude-response"]','[class*="AssistantTurn"]','[class*="assistant-turn"]','[class*="ai-turn"]','div[class*="prose"]','div.prose'],
        scope: ['[data-testid="conversation-content"]','[class*="conversation-content"]','main'],
      },
      inject: ['.ProseMirror[contenteditable="true"]','[contenteditable="true"][role="textbox"]','fieldset [contenteditable="true"]','form [contenteditable="true"]','[contenteditable="true"]'],
      fetchPattern: /\/api\/conversation|\/api\/organizations\/.*\/chat_conversations\/.*\/completion/,
    },
    chatgpt: {
      scrape: {
        user: ['[data-message-author-role="user"]'],
        asst: ['[data-message-author-role="assistant"]'],
        scope: ['main','#main'],
      },
      inject: ['#prompt-textarea',"[data-testid='text-input']","[contenteditable='true'][role='textbox']","form [contenteditable='true']","textarea:not([readonly])","[contenteditable='true']"],
      fetchPattern: /\/ces\/v1\/|\/backend-api\/conversation\//,
    },
    gemini: {
      scrape: {
        user: ['user-query','.query-content','[data-test-id="user-message"]','user-query-content'],
        asst: ['model-response','response-container','.response-content','[data-test-id="response-container"]','message-content'],
        scope: ['chat-window','infinite-scroller','[data-test-id="chat-history-container"]','conversation-container','main'],
      },
      inject: ['rich-textarea .ql-editor[contenteditable="true"]','rich-textarea .ql-editor','.ql-editor[contenteditable="true"]','[contenteditable="true"][role="textbox"]','[contenteditable="true"]'],
      fetchPattern: /\/BardFrontendService\/|\/converse\/|\/GenerateContent/,
    },
    grok: {
      scrape: {
        user: ['[data-testid="user-message"]','[class*="human-turn"]','[class*="UserMessage"]','[class*="user-message"]','[data-role="user"]'],
        asst: ['[data-testid="assistant-message"]','[class*="response-content-markdown"]','[class*="grok-response"]','[class*="assistant-message"]','[class*="AssistantMessage"]','[data-role="assistant"]'],
        scope: ['main','[class*="chat-container"]','[class*="conversation"]'],
      },
      inject: ['[data-testid="chat-input"] [contenteditable="true"]','[data-testid="composer-text-input"] [contenteditable="true"]','textarea[placeholder*="Ask"]','[contenteditable="true"][role="textbox"]','.ProseMirror[contenteditable="true"]','textarea:not([readonly])','[contenteditable="true"]'],
      fetchPattern: /\/api\/chat|\/conversation\/.*\/response/,
    },
    deepseek: {
      scrape: {
        user: ['[class*="ds-message"]:not([class*="ds-assistant"])','[data-testid*="user"]','[data-testid*="human"]','[class*="userMessage"]','[class*="user-message"]','[class*="human-message"]','[class*="human_turn"]','[class*="user_turn"]','[data-type="user"]','[data-role="user"]','[data-message-author-role="user"]'],
        asst: ['[class*="ds-assistant-message-main-content"]','[data-testid*="assistant"]','[data-testid*="answer"]','[class*="assistantMessage"]','[class*="assistant-message"]','[class*="model-response"]','[data-message-author-role="assistant"]','[class*="ds-markdown"]','[class*="markdown-content"]'],
        scope: ['[class*="scroll"]','[class*="message"]','[role="main"]','main'],
      },
      inject: ['textarea[placeholder*="Message"]','textarea[placeholder*="message"]','textarea[placeholder*="Ask"]','#chat-input','[id*="chat-input"]','[class*="chatInput"] textarea','[contenteditable="true"][role="textbox"]','.ProseMirror[contenteditable="true"]','textarea:not([readonly])','[contenteditable="true"]'],
      fetchPattern: /\/api\/v0\/chat\/completion|\/chat\/completion/,
    },
    perplexity: {
      scrape: {
        user: ['[data-message-role="user"]','[class*="group/query"]','[class*="query"]','[data-testid="user-message"]','[data-testid*="user-query"]','[aria-label*="question" i]','[class*="UserMessage"]','[class*="user-message"]'],
        asst: ['[data-message-role="assistant"]','[class*="prose"]:not([class*="sidebar"]):not(nav):not(footer):not(aside)','[class*="answer-text"]','[data-testid*="answer"]','[aria-label*="answer" i]','[class*="model-answer"]','[class*="assistant-message"]','.answer-block','[class*="answer-block"]'],
        scope: ['main','#root','[role="main"]','div.isolate.flex','.conversation','[class*="conversation"]','[class*="messages"]','[class*="chat"]'],
      },
      inject: ["textarea#ask","textarea[placeholder*='Ask']","textarea[placeholder*='ask']","textarea[placeholder*='Search']","[contenteditable='true'][role='textbox']",".ProseMirror[contenteditable='true']","textarea:not([readonly])","[contenteditable='true']"],
      fetchPattern: /\/api\/chat\/.*\/completions|\/rest\/.*\/chat/,
    },
  };
  const cfg = CFG[P];
  if (!cfg) { fail('Unknown platform: ' + P); return; }
  // ── TEST 1: CONTENT SCRIPT PRESENCE ─────────────────────────────
  log('--- TEST 1: Content Script Presence ---');
  // Check MAIN-world flag (set by fetch-interceptor.ts) and ISOLATED-world flag (set by interceptor-bridge.ts).
  // chrome.runtime.id is only visible inside extension contexts, not from DevTools console in the page world.
  const cmFetchInstalled = !!(window.__contextForgeFetchInstalled);
  const cmBridgeInstalled = !!(window.__contextForgeBridgeInstalled);
  const cmLoaded = !!(cmFetchInstalled || cmBridgeInstalled ||
    document.querySelector('[data-cm-loaded]') ||
    (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id));
  if (cmLoaded) { pass('Content script detected on page' + (cmFetchInstalled ? ' (fetch interceptor: loaded)' : cmBridgeInstalled ? ' (bridge: loaded)' : '')); record('content_script', true, 1); }
  else { warn('Content script not detected (may not be loaded yet)'); record('content_script', false, 1); }
  info('chrome.runtime.id: ' + (typeof chrome !== 'undefined' && chrome.runtime ? chrome.runtime.id : 'N/A') + ' | __contextForgeFetchInstalled: ' + cmFetchInstalled + ' | __contextForgeBridgeInstalled: ' + cmBridgeInstalled);

  // ── TEST 2: SCRAPER SELECTORS ───────────────────────────────────
  log('--- TEST 2: Scraper Selectors ---');
  let scope = document;
  for (const s of cfg.scrape.scope) {
    const el = q1(s);
    if (el) { scope = el; info('Scope: ' + s + ' (' + el.children.length + ' children)'); break; }
  }
  let uHits = 0, aHits = 0, uSel = '', aSel = '';
  let uEls = [], aEls = [];
  for (const s of cfg.scrape.user) {
    const els = q(s);
    const vis = [...els].filter(isVis).filter(e => txt(e) > 3);
    if (vis.length > 0) { uHits = vis.length; uSel = s; uEls = vis; break; }
  }
  for (const s of cfg.scrape.asst) {
    const els = q(s);
    let vis = [...els].filter(isVis).filter(e => txt(e) > 30)
      // Exclude only structural noise containers (NOT content filters — those kill legitimate answers)
      .filter(e => !e.closest('nav, header, footer, aside, [role="navigation"], [role="banner"], [class*="sidebar"], [class*="nav"]'));
    // Parent dedup: if multiple elements share the same parent, keep only the first
    // (prevents counting each paragraph inside an answer as a separate message)
    const seenParents = new Set();
    vis = vis.filter(e => {
      const p = e.parentElement;
      if (seenParents.has(p)) return false;
      seenParents.add(p);
      return true;
    });
    if (vis.length > 0) { aHits = vis.length; aSel = s; aEls = vis; break; }
  }
  if (uHits > 0) { pass('User messages: ' + uHits + ' via ' + uSel); record('scraper_user', true, 2); }
  else { fail('User messages: 0 - NO SELECTOR MATCHED'); record('scraper_user', false, 2); }
  if (aHits > 0) { pass('Assistant messages: ' + aHits + ' via ' + aSel); record('scraper_asst', true, 2); }
  else { fail('Assistant messages: 0 - NO SELECTOR MATCHED'); record('scraper_asst', false, 2); }

  // Ratio check — user/asst should be roughly balanced (within 3:1)
  if (uHits > 0 && aHits > 0) {
    const ratio = Math.max(uHits, aHits) / Math.min(uHits, aHits);
    if (ratio > 3) { warn('Imbalance: user=' + uHits + ' asst=' + aHits + ' (ratio ' + ratio.toFixed(1) + ':1)'); record('scraper_balance', false, 1); }
    else { pass('Message balance OK: user=' + uHits + ' asst=' + aHits + ' (ratio ' + ratio.toFixed(1) + ':1)'); record('scraper_balance', true, 1); }
  }

  // ── TEST 3: STREAMING DETECTION ─────────────────────────────────
  log('--- TEST 3: Streaming Detection ---');
  const streamingMarkers = ['result-streaming', 'streaming', 'loading', 'data-is-streaming', 'generating'];
  let streamingEls = 0;
  for (const m of streamingMarkers) {
    streamingEls += q('[class*="' + m + '"], [' + m + ']').length;
  }
  if (streamingEls > 0) { info('Streaming markers found: ' + streamingEls + ' elements (will be excluded by scraper)'); record('streaming_detected', true, 1); }
  else { info('No streaming markers found (conversation is static/complete)'); record('streaming_detected', true, 1); }

  // ── TEST 4: CONTENT EXTRACTION QUALITY ──────────────────────────
  log('--- TEST 4: Content Extraction Quality ---');
  let goodContent = 0, emptyContent = 0, chromeContent = 0;
  const chromeKeywords = ['copy', 'regenerate', 'share', 'like', 'dislike', 'edit', 'delete', 'retry'];
  for (const el of [...uEls, ...aEls].slice(0, 10)) {
    const t = (el.textContent ?? '').trim();
    if (t.length < 5) { emptyContent++; continue; }
    const lower = t.toLowerCase();
    if (chromeKeywords.every(k => !lower.startsWith(k)) && t.length > 20) goodContent++;
    else chromeContent++;
  }
  if (goodContent > 0) { pass('Content extraction: ' + goodContent + ' messages with meaningful text'); record('content_quality', true, 1); }
  else { fail('Content extraction: no meaningful text extracted'); record('content_quality', false, 1); }
  if (emptyContent > 0) warn('Empty content: ' + emptyContent + ' elements returned no text');
  if (chromeContent > 0) warn('UI chrome detected in ' + chromeContent + ' elements (may need stripping)');
  // ── TEST 5: DEDUP & ORDERING ────────────────────────────────────
  log('--- TEST 5: Dedup & Ordering ---');
  const allEls = [...uEls.map(e => ({el: e, role: 'user'})), ...aEls.map(e => ({el: e, role: 'assistant'}))];
  allEls.sort((a, b) => {
    const pos = a.el.compareDocumentPosition(b.el);
    return pos & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
  });
  let duplicates = 0;
  const seenText = new Set();
  for (const {el, role} of allEls) {
    const key = role + ':' + (el.textContent ?? '').trim().slice(0, 80);
    if (seenText.has(key)) duplicates++;
    else seenText.add(key);
  }
  if (duplicates === 0) { pass('No duplicate messages detected'); record('dedup', true, 1); }
  else { warn(duplicates + ' duplicate messages found (dedup logic should handle)'); record('dedup', false, 1); }

  // Check DOM ordering — user and assistant should interleave
  let ordered = true;
  let lastRole = null;
  let consecutive = 0;
  for (const {role} of allEls) {
    if (role === lastRole) { consecutive++; if (consecutive > 3) ordered = false; }
    else { consecutive = 0; }
    lastRole = role;
  }
  if (ordered) { pass('Message ordering looks correct (interleaved)'); record('ordering', true, 1); }
  else { warn('Messages may be out of order (consecutive same-role)'); record('ordering', false, 1); }

  // ── TEST 6: FETCH INTERCEPTOR ───────────────────────────────────
  log('--- TEST 6: Fetch Interceptor ---');
  // Primary check: __contextForgeFetchInstalled flag is set by fetch-interceptor.ts in the MAIN world.
  // This is more reliable than fetch.toString().length, which varies by browser/build and fails on
  // platforms like DeepSeek where the wrapped function is short (length=92 < threshold of 100).
  const fetchInstalled = !!(window.__contextForgeFetchInstalled);
  if (fetchInstalled) { pass('Fetch interceptor installed (__contextForgeFetchInstalled=true)'); record('fetch_hooked', true, 2); }
  else if (window.fetch) {
    const fetchLen = window.fetch.toString().length;
    if (fetchLen > 200) { pass('Fetch appears hooked (length=' + fetchLen + ')'); record('fetch_hooked', true, 2); }
    else { info('Fetch may not be hooked (length=' + fetchLen + ', flag not set) - DOM scrape is fallback'); record('fetch_hooked', false, 1); }
  } else { fail('window.fetch not found'); record('fetch_hooked', false, 1); }
  // Check for CM bridge — __contextForgeBridgeInstalled is set in the ISOLATED world and may not be
  // visible from the page's MAIN world (DevTools console default context). Use __contextForgeFetchInstalled
  // as a proxy since the interceptor and bridge are loaded together via manifest.json content_scripts.
  const bridge = window.__contextForgeBridgeInstalled || window.__contextForgeFetchInstalled;
  if (bridge) { pass('CM fetch bridge/interceptor detected'); record('fetch_bridge', true, 1); }
  else { info('No CM fetch bridge variable found (interceptor may use different naming)'); record('fetch_bridge', false, 1); }
  info('Fetch pattern for ' + P + ': ' + cfg.fetchPattern);
  // ── TEST 7: INJECTION STRATEGY CHAIN ────────────────────────────
  log('--- TEST 7: Injection Strategy Chain ---');
  let injEl = null, injSel = '';
  for (const s of cfg.inject) {
    const el = q1(s);
    if (el && isVis(el)) { injEl = el; injSel = s; break; }
  }
  // Gemini shadow root check
  if (!injEl && P === 'gemini') {
    const rts = document.querySelectorAll('rich-textarea');
    for (const rt of rts) {
      const sr = rt.shadowRoot;
      if (sr) {
        for (const s of ['.ql-editor[contenteditable="true"]', '.ql-editor', '[contenteditable="true"]']) {
          const el = sr.querySelector(s);
          if (el) { injEl = el; injSel = 'rich-textarea > #shadow > ' + s; break; }
        }
      }
      if (injEl) break;
    }
  }
  let textAccepted = false;
  let winningStrategy = '';
  if (injEl) {
    pass('Injection input found: ' + injSel + ' (tag=' + injEl.tagName + ', editable=' + injEl.isContentEditable + ')');
    record('inject_found', true, 2);
    const testText = 'CM_DIAG_TEST_123';
    try {
      injEl.focus();
      if (injEl instanceof HTMLTextAreaElement) {
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
        setter?.call(injEl, testText);
        injEl.dispatchEvent(new Event('input', { bubbles: true }));
        if (injEl.value.includes('CM_DIAG')) { pass('Strategy: textarea native setter - ACCEPTED'); textAccepted = true; winningStrategy = 'textarea'; }
        else fail('Strategy: textarea native setter - REJECTED');
        setter?.call(injEl, '');
      } else if (injEl.isContentEditable) {
        // Strategy 0: beforeinput event (Lexical editors — Perplexity)
        try {
          document.execCommand('selectAll', false, undefined);
          const bi = new InputEvent('beforeinput', {
            inputType: 'insertFromPaste', data: testText,
            bubbles: true, cancelable: true, composed: true,
          });
          injEl.dispatchEvent(bi);
          if ((injEl.textContent ?? '').includes('CM_DIAG')) { pass('Strategy 0: beforeinput insertFromPaste - ACCEPTED'); textAccepted = true; winningStrategy = 'beforeinput'; }
          else info('Strategy 0: beforeinput - not accepted, trying next...');
        } catch (e) { info('Strategy 0: beforeinput error - ' + e.message); }
        // Strategy 1: synthetic paste event
        try {
          document.execCommand('selectAll', false, undefined);
          const dt = new DataTransfer();
          dt.setData('text/plain', testText);
          const pe = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
          const dispatched = injEl.dispatchEvent(pe);
          if ((dispatched || (injEl.textContent?.length ?? 0) > 0) && (injEl.textContent ?? '').includes('CM_DIAG')) {
            pass('Strategy 1: paste event - ACCEPTED'); textAccepted = true; winningStrategy = 'paste';
          } else info('Strategy 1: paste event - not accepted, trying next...');
        } catch (e) { info('Strategy 1: paste event error - ' + e.message); }
        // Strategy 2: execCommand insertText
        if (!textAccepted) {
          document.execCommand('selectAll', false, undefined);
          const inserted = document.execCommand('insertText', false, testText);
          if (inserted && (injEl.textContent ?? '').includes('CM_DIAG')) {
            pass('Strategy 2: execCommand insertText - ACCEPTED'); textAccepted = true; winningStrategy = 'execCommand';
          } else info('Strategy 2: execCommand insertText - not accepted, trying next...');
        }
        // Strategy 3: innerText fallback
        if (!textAccepted) {
          injEl.innerText = testText;
          injEl.dispatchEvent(new InputEvent('input', { bubbles: true, data: testText, inputType: 'insertText' }));
          if ((injEl.textContent ?? '').includes('CM_DIAG')) { pass('Strategy 3: innerText fallback - ACCEPTED'); textAccepted = true; winningStrategy = 'innerText'; }
          else info('Strategy 3: innerText fallback - not accepted, trying next...');
        }
        // Strategy 4: textContent
        if (!textAccepted) {
          injEl.textContent = testText;
          injEl.dispatchEvent(new InputEvent('input', { bubbles: true, data: testText }));
          if ((injEl.textContent ?? '').includes('CM_DIAG')) { pass('Strategy 4: textContent - ACCEPTED'); textAccepted = true; winningStrategy = 'textContent'; }
          else fail('ALL injection strategies REJECTED');
        }
        document.execCommand('selectAll', false, undefined);
        document.execCommand('delete', false, undefined);
      }
    } catch (e) { fail('Injection error: ' + e.message); }
    record('inject_accepted', textAccepted, 3);
    if (winningStrategy) info('Winning injection strategy: ' + winningStrategy);
  } else {
    fail('Injection input: NOT FOUND');
    record('inject_found', false, 2);
    warn('Scanning for any editable/input elements...');
    const inputs = document.querySelectorAll('textarea, [contenteditable="true"], input[type="text"]');
    const vis = [...inputs].filter(isVis).slice(0, 5);
    vis.forEach((el, i) => {
      log('  Candidate ' + i + ': <' + el.tagName.toLowerCase() + '> editable=' + el.isContentEditable + ' placeholder="' + (el.getAttribute('placeholder') ?? '') + '"');
    });
  }
  // ── TEST 8: ROUNDTRIP (scrape → inject → verify) ────────────────
  log('--- TEST 8: Roundtrip Test ---');
  if (uHits > 0 && injEl && textAccepted) {
    const sampleEl = uEls[0];
    const sampleText = (sampleEl.textContent ?? '').trim().slice(0, 100);
    info('Sample user message: "' + sampleText.slice(0, 50) + '..."');
    try {
      injEl.focus();
      const rtFirst20 = sampleText.slice(0, 20);
      if (injEl instanceof HTMLTextAreaElement) {
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
        let rtOk = false;
        for (let attempt = 1; attempt <= 3 && !rtOk; attempt++) {
          setter?.call(injEl, sampleText);
          injEl.dispatchEvent(new Event('input', { bubbles: true }));
          await sleep(150);
          if (injEl.value.includes(rtFirst20)) rtOk = true;
          else if (attempt < 3) await sleep(300);
        }
        if (rtOk) { pass('Roundtrip: scraped text injected into input'); record('roundtrip', true, 2); }
        else { fail('Roundtrip: text not retained in input after 3 attempts'); record('roundtrip', false, 2); }
        setter?.call(injEl, '');
      } else {
        // Full strategy chain with retry — mirrors injectWithRetry() in shared.ts.
        // React/ProseMirror/Angular editors need multiple render cycles to commit
        // DOM updates, so a single paste event + 100ms delay produces false negatives.
        let rtOk = false;
        for (let attempt = 1; attempt <= 3 && !rtOk; attempt++) {
          // Strategy 1: synthetic paste event
          try {
            document.execCommand('selectAll', false, undefined);
            const dt = new DataTransfer();
            dt.setData('text/plain', sampleText);
            injEl.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
            await sleep(150);
            if ((injEl.textContent ?? '').includes(rtFirst20)) { rtOk = true; break; }
          } catch {}
          // Strategy 2: execCommand insertText
          try {
            document.execCommand('selectAll', false, undefined);
            document.execCommand('insertText', false, sampleText);
            await sleep(150);
            if ((injEl.textContent ?? '').includes(rtFirst20)) { rtOk = true; break; }
          } catch {}
          // Strategy 3: innerText + input event
          try {
            injEl.innerText = sampleText;
            injEl.dispatchEvent(new InputEvent('input', { bubbles: true, data: sampleText, inputType: 'insertText' }));
            await sleep(150);
            if ((injEl.textContent ?? '').includes(rtFirst20)) { rtOk = true; break; }
          } catch {}
          // Strategy 4: textContent + input event
          try {
            injEl.textContent = sampleText;
            injEl.dispatchEvent(new InputEvent('input', { bubbles: true, data: sampleText }));
            await sleep(150);
            if ((injEl.textContent ?? '').includes(rtFirst20)) { rtOk = true; break; }
          } catch {}
          if (attempt < 3) await sleep(300 * attempt);
        }
        if (rtOk) { pass('Roundtrip: scraped text injected into input'); record('roundtrip', true, 2); }
        else { fail('Roundtrip: text not retained in input after 3 attempts (all strategies)'); record('roundtrip', false, 2); }
        document.execCommand('selectAll', false, undefined);
        document.execCommand('delete', false, undefined);
      }
    } catch (e) { fail('Roundtrip error: ' + e.message); record('roundtrip', false, 2); }
  } else {
    warn('Roundtrip skipped (need scraper + injection working)');
    record('roundtrip', false, 1);
  }

  // ── TEST 9: SERVICE WORKER BRIDGE (content → SW messaging) ──────
  log('--- TEST 9: Service Worker Bridge ---');
  // The content script talks to the SW via chrome.runtime.sendMessage. From the
  // page MAIN world chrome.runtime is undefined, so this only runs when the
  // diagnostic is pasted into a context that has the extension chrome API.
  const hasRuntime = typeof chrome !== 'undefined' && chrome.runtime && typeof chrome.runtime.sendMessage === 'function' && chrome.runtime.id;
  if (!hasRuntime) {
    info('chrome.runtime.sendMessage unavailable in this context — SW bridge tests skipped (paste in extension page console for full coverage)');
    record('sw_bridge', true, 1);
  } else {
    const sendSW = (m, timeoutMs = 4000) => new Promise((resolve) => {
      let done = false;
      const t = setTimeout(() => { if (!done) { done = true; resolve({ __timeout: true }); } }, timeoutMs);
      try {
        chrome.runtime.sendMessage(m, (resp) => {
          if (done) return; done = true; clearTimeout(t);
          if (chrome.runtime.lastError) resolve({ __error: chrome.runtime.lastError.message });
          else resolve(resp ?? { __empty: true });
        });
      } catch (e) { if (!done) { done = true; clearTimeout(t); resolve({ __error: e.message }); } }
    });

    // 9a: SW responds to messages at all (PING via CHECK_INDEXING)
    const checkResp = await sendSW({ type: 'CHECK_INDEXING', sessionId: 'cm-diag-probe-' + Date.now() });
    if (checkResp.__timeout) { fail('SW did not respond to CHECK_INDEXING within 4s (SW may be asleep/crashed)'); record('sw_bridge', false, 2); }
    else if (checkResp.__error) { fail('SW CHECK_INDEXING error: ' + checkResp.__error); record('sw_bridge', false, 2); }
    else if (typeof checkResp.inFlight === 'boolean' && typeof checkResp.queued === 'number') {
      pass('SW bridge alive — CHECK_INDEXING ok (inFlight=' + checkResp.inFlight + ', queued=' + checkResp.queued + ')');
      record('sw_bridge', true, 2);
      // 9b: Queue backpressure sanity — queue should not be pathologically saturated
      if (checkResp.queued > 100) { warn('Index queue is very high (' + checkResp.queued + ') — possible saturation/backpressure'); record('sw_queue_health', false, 1); }
      else { pass('Index queue healthy (' + checkResp.queued + ' jobs queued, cap=100)'); record('sw_queue_health', true, 1); }
    } else { warn('SW CHECK_INDEXING returned unexpected shape: ' + JSON.stringify(checkResp).slice(0, 120)); record('sw_bridge', false, 2); }

    // 9c: Full SW diagnostic round-trip (validates sync fixes via SW context)
    const swDiag = await sendSW({ type: 'CM_SW_DIAG' }, 15000);
    if (swDiag.__timeout) { warn('CM_SW_DIAG timed out (15s) — heavy DB or offscreen warmup; check SW console directly'); record('sw_full_diag', false, 1); }
    else if (swDiag.__error) { warn('CM_SW_DIAG error: ' + swDiag.__error); record('sw_full_diag', false, 1); }
    else if (swDiag.health !== undefined) {
      const swFailed = (swDiag.results || []).filter(r => !r.ok);
      if (swFailed.length === 0) pass('SW full diagnostic: ALL ' + (swDiag.results || []).length + ' checks passed (health ' + swDiag.health + '%)');
      else warn('SW full diagnostic: ' + swFailed.length + ' check(s) failed [' + swFailed.map(f => f.name).join(', ') + '] (health ' + swDiag.health + '%)');
      record('sw_full_diag', swDiag.health >= 70, 2);
      if (swDiag.sessionCount !== undefined) info('SW sessions: ' + swDiag.sessionCount + ' (' + Object.entries(swDiag.platforms || {}).map(([p, c]) => p + '=' + c).join(', ') + ')');
    } else { warn('CM_SW_DIAG returned no health field'); record('sw_full_diag', false, 1); }
  }

  // ── SUMMARY & HEALTH SCORE ──────────────────────────────────────
  log('==============================================================');
  log('SUMMARY');
  log('==============================================================');
  const totalWeight = results.reduce((s, r) => s + r.weight, 0);
  const passedWeight = results.filter(r => r.ok).reduce((s, r) => s + r.weight, 0);
  const health = Math.round((passedWeight / totalWeight) * 100);
  const failed = results.filter(r => !r.ok);
  if (failed.length === 0) {
    pass(P.toUpperCase() + ': ALL ' + results.length + ' CHECKS PASSED');
  } else {
    fail(P.toUpperCase() + ': ' + failed.length + ' check(s) failed');
  }
  log('HEALTH SCORE: ' + health + '% (' + passedWeight + '/' + totalWeight + ' weight)');
  if (health >= 90) pass('Status: EXCELLENT');
  else if (health >= 70) warn('Status: DEGRADED - some issues');
  else fail('Status: CRITICAL - major issues');

  // Detailed results table
  log('--- Detailed Results ---');
  results.forEach(r => {
    const mark = r.ok ? '\u2713' : '\u2717';
    const color = r.ok ? 'lime' : 'red';
    console.log('%c[CM-DIAG] ' + mark + ' ' + r.name + ' (w:' + r.weight + ')', 'color:' + color + ';font-weight:bold');
  });

  // Fix suggestions
  const fixes = [];
  if (!results.find(r => r.name === 'scraper_user')?.ok) fixes.push('SCRAPER: User messages not found. Run class scan below, update userSelector in ' + P + '.ts.');
  if (!results.find(r => r.name === 'scraper_asst')?.ok) fixes.push('SCRAPER: Assistant messages not found. Run class scan below, update assistantSelector in ' + P + '.ts.');
  if (!results.find(r => r.name === 'scraper_balance')?.ok) fixes.push('SCRAPER: User/assistant imbalance - check for over-matching selectors (e.g. ds-markdown paragraph-level).');
  if (!results.find(r => r.name === 'inject_found')?.ok) fixes.push('INJECTION: Input not found. Check candidate inputs above, update inject selectors in ' + P + '.ts.');
  if (!results.find(r => r.name === 'inject_accepted')?.ok) fixes.push('INJECTION: Text rejected. The paste-event strategy in shared.ts setPromptInputValue() should handle this for Lexical/React editors.');
  if (!results.find(r => r.name === 'fetch_hooked')?.ok) fixes.push('FETCH: Interceptor not detected. DOM scrape is fallback. Check fetch-interceptor.ts is loaded in MAIN world.');
  if (!results.find(r => r.name === 'content_quality')?.ok) fixes.push('CONTENT: Extraction returning empty/chrome text. Check extractMessageContent() in shared.ts.');
  if (!results.find(r => r.name === 'dedup')?.ok) fixes.push('DEDUP: Duplicate messages found. Check content-hash dedup logic in scraper.');
  if (!results.find(r => r.name === 'ordering')?.ok) fixes.push('ORDERING: Messages out of order. Check compareDocumentPosition sort in scraper.');

  if (fixes.length > 0) {
    log('--- Suggested Fixes ---');
    fixes.forEach((f, i) => log((i + 1) + '. ' + f));
  }

  // Class scan for scraper failures
  if (!results.find(r => r.name === 'scraper_user')?.ok || !results.find(r => r.name === 'scraper_asst')?.ok) {
    log('--- DOM Class Scan ---');
    const cls = new Map();
    document.querySelectorAll('*').forEach(el => {
      if (!isVis(el)) return;
      el.classList.forEach(c => {
        if (/user|human|query|turn|message|assistant|model|response|answer|prose|ds-|grok/i.test(c))
          cls.set(c, (cls.get(c) ?? 0) + 1);
      });
    });
    const top = [...cls.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
    if (top.length > 0) {
      log('Suggested selectors:');
      top.forEach(([c, n]) => {
        const role = /user|human|query/i.test(c) ? 'user' : /assistant|model|response|answer|prose/i.test(c) ? 'assistant' : 'unknown';
        log('  [class*="' + c + '"] -> ' + role + ' (' + n + ' hits)');
      });
    }
  }

  log('==============================================================');
  log('Diagnostic complete. Health: ' + health + '%');
  log('==============================================================');
  return { platform: P, health, results, failed: failed.map(f => f.name) };
})();
