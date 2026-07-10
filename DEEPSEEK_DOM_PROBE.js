(function deepseekDOMProbe() {
  const msgCount = document.querySelectorAll('[class*="message"],[class*="Message"]').length;
  const sessionType = msgCount > 2 ? 'EXISTING' : 'NEW-EMPTY';
  console.log(`\n========== CONTEXTMOVER: DEEPSEEK DOM PROBE [${sessionType}] ==========\n`);
  console.log('URL:', window.location.href);
  console.log('Rough message count estimate:', msgCount);

  // ── SECTION 1: data-* attributes ───────────────────────────────────────────
  const allTestIds = [...new Set(
    [...document.querySelectorAll('[data-testid]')].map(el => el.dataset.testid)
      .concat([...document.querySelectorAll('[data-v]')].map(el => 
        [...el.attributes].find(a=>a.name.startsWith('data-v'))?.name
      ))
  )].filter(Boolean).sort();
  console.log('data-testid values:', allTestIds.join(', ') || '(none)');

  const roleAttrs = {};
  document.querySelectorAll('*').forEach(el => {
    [...el.attributes].forEach(attr => {
      if (/role|author|turn|human|assistant|user|message|ds-/i.test(attr.name + attr.value)) {
        const key = `${attr.name}="${attr.value.slice(0,30)}"`;
        roleAttrs[key] = (roleAttrs[key]||0)+1;
      }
    });
  });
  console.log('\nROLE-RELATED ATTRS:');
  Object.entries(roleAttrs).sort((a,b)=>b[1]-a[1]).slice(0,15)
    .forEach(([k,n]) => console.log(`  ${n}x  ${k}`));

  // ── SECTION 2: selector tests ──────────────────────────────────────────────
  const candidates = [
    '[class*="message"]', '[class*="Message"]',
    '[class*="human"]', '[class*="Human"]',
    '[class*="assistant"]', '[class*="Assistant"]',
    '[class*="user-message"]', '[class*="bot-message"]',
    '[class*="UserMessage"]', '[class*="BotMessage"]',
    '[class*="chat-message"]', '[class*="ChatMessage"]',
    '[class*="ds-message"]', '[class*="md-content"]',
    '[class*="question"]', '[class*="answer"]',
    '[class*="bubble"]', '[class*="Bubble"]',
    'article', '[role="article"]',
    '[data-message-author-role]',
    'main', '[role="main"]',
  ];

  console.log('\nSELECTOR TEST RESULTS:');
  candidates.forEach(sel => {
    try {
      const els = [...document.querySelectorAll(sel)];
      if (els.length > 0) {
        const withText = els.filter(el => el.textContent.trim().length > 30);
        if (withText.length > 0) {
          console.log(`\n  ✅ "${sel}" → ${els.length} total, ${withText.length} with text`);
          withText.slice(0,2).forEach((el,i) => {
            const text = el.textContent.trim().replace(/\s+/g,' ').slice(0,100);
            const dataAttrs = [...el.attributes].filter(a=>/^data-/.test(a.name)).map(a=>`${a.name}="${a.value.slice(0,30)}"`).join(' ');
            console.log(`     [${i}] <${el.tagName.toLowerCase()}> | data: {${dataAttrs}} | class: "${el.className?.toString().slice(0,80)}"`);
            console.log(`     [${i}] text: "${text}"`);
          });
        }
      }
    } catch(e) {}
  });

  // ── SECTION 3: Root container ──────────────────────────────────────────────
  console.log('\nROOT CONTAINER:');
  ['main', '[role="main"]', '[class*="chat"]', '[class*="Chat"]',
   '[class*="conversation"]', '[class*="messages"]',
   '[class*="scrollable"]', '[class*="Scrollable"]'].forEach(sel => {
    const el = document.querySelector(sel);
    if (el) console.log(`  "${sel}" → <${el.tagName.toLowerCase()}> class="${el.className?.toString().slice(0,80)}" h=${el.scrollHeight}px children=${el.children.length}`);
  });

  // ── SECTION 4: New conversation DOM (what renders when chat is empty) ──────
  console.log('\nEMPTY STATE ELEMENTS (present in new conversation):');
  ['[class*="empty"]', '[class*="Empty"]', '[class*="welcome"]', '[class*="Welcome"]',
   '[class*="placeholder"]', '[class*="start"]', '[class*="Start"]',
   '[class*="intro"]', '[class*="hero"]'].forEach(sel => {
    const el = document.querySelector(sel);
    if (el) console.log(`  "${sel}" → "${el.textContent.trim().slice(0,60)}"`);
  });

  console.log(`\n========== END DEEPSEEK DOM PROBE [${sessionType}] ==========\n`);
})();
