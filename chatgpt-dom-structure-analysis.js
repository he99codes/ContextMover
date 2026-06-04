/**
 * ChatGPT DOM Structure Analysis 2026
 * 
 * Deep analysis to find message container selectors
 */

console.clear();
console.log("========== CHATGPT DOM STRUCTURE ANALYSIS ==========\n");

// 1. Check if old selector exists
console.log("1. OLD SELECTOR CHECK:");
const oldSel = document.querySelectorAll('[data-message-author-role]');
console.log(`   [data-message-author-role]: ${oldSel.length} elements\n`);

// 2. Find all elements with data-* attributes
console.log("2. DATA ATTRIBUTES SCAN:");
const allWithData = document.querySelectorAll('[data-*]');
const dataAttrs = new Set();
allWithData.forEach(el => {
  Array.from(el.attributes).forEach(attr => {
    if (attr.name.startsWith('data-')) {
      dataAttrs.add(attr.name);
    }
  });
});
console.log(`   Found ${dataAttrs.size} unique data-* attributes:`);
Array.from(dataAttrs).slice(0, 20).forEach(attr => console.log(`     - ${attr}`));
console.log();

// 3. Look for message-like containers
console.log("3. MESSAGE CONTAINER CANDIDATES:");
const candidates = [
  { sel: '[role="article"]', desc: 'article role' },
  { sel: '[role="region"]', desc: 'region role' },
  { sel: '[data-testid*="message"]', desc: 'message testid' },
  { sel: '[data-testid*="turn"]', desc: 'turn testid' },
  { sel: '[class*="message"]', desc: 'message class' },
  { sel: '[class*="turn"]', desc: 'turn class' },
  { sel: 'article', desc: 'article tag' },
  { sel: '[data-message-id]', desc: 'message-id attr' },
  { sel: '[data-turn-id]', desc: 'turn-id attr' },
  { sel: '[class*="conversation"]', desc: 'conversation class' },
];

candidates.forEach(({ sel, desc }) => {
  const els = document.querySelectorAll(sel);
  if (els.length > 0) {
    const sample = els[0];
    const text = sample.textContent?.trim().slice(0, 50) || '';
    console.log(`   ✅ "${sel}" (${desc})`);
    console.log(`      Count: ${els.length}`);
    console.log(`      Sample: "${text}..."`);
    console.log(`      Classes: ${sample.className.slice(0, 80)}`);
    console.log();
  }
});

// 4. Inspect main element structure
console.log("4. MAIN ELEMENT STRUCTURE:");
const main = document.querySelector('main');
if (main) {
  console.log(`   Main found: ${main.className}`);
  console.log(`   Direct children: ${main.children.length}`);
  
  // Look at first few children
  Array.from(main.children).slice(0, 5).forEach((child, i) => {
    console.log(`     [${i}] ${child.tagName} class="${child.className.slice(0, 60)}"`);
    console.log(`         children: ${child.children.length}`);
  });
} else {
  console.log("   Main element NOT found");
}
console.log();

// 5. Look for conversation container
console.log("5. CONVERSATION CONTAINER:");
const conversationContainers = [
  document.querySelector('[class*="conversation"]'),
  document.querySelector('[class*="thread"]'),
  document.querySelector('[class*="messages"]'),
  document.querySelector('[role="main"]'),
];

conversationContainers.forEach((el, i) => {
  if (el) {
    console.log(`   Container ${i}: ${el.tagName} class="${el.className.slice(0, 60)}"`);
    console.log(`      Children: ${el.children.length}`);
  }
});

console.log("\n========== END ANALYSIS ==========");
