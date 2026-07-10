// ContextMover Service Worker Diagnostic v3
// Paste into SW console: chrome://extensions → Service Worker → Console
// Uses chrome.runtime.sendMessage to CM_SW_DIAG handler (no import() needed)
// v3 adds sync-fix verification: drive periodic alarm, tombstone resurrection,
// index queue cap, in-flight/bulk-index state, pending backlog, CHECK_INDEXING.
(async () => {
  const log = s => console.log('%c[CM-SW-DIAG] ' + s, 'color:cyan;font-weight:bold');
  const pass = s => console.log('%c[CM-SW-DIAG] \u2713 ' + s, 'color:lime;font-weight:bold');
  const fail = s => console.error('%c[CM-SW-DIAG] \u2717 ' + s, 'color:red;font-weight:bold');
  const info = s => console.log('%c[CM-SW-DIAG] \u2139 ' + s, 'color:#88aaff');
  const warn = s => console.warn('%c[CM-SW-DIAG] ' + s, 'color:orange;font-weight:bold');

  // Sync-fix tests added in v3 — grouped separately in the output for clarity.
  const SYNC_FIX_TESTS = new Set([
    'drive_periodic_alarm', 'tombstone_cache', 'index_queue',
    'indexing_state', 'pending_index', 'check_indexing_handler',
  ]);

  log('==============================================================');
  log('ContextMover SW Diagnostic (v3 — sync-fix aware, no import())');
  log('==============================================================');

  try {
    const res = typeof self.cmSwDiag === 'function' ? await self.cmSwDiag() : null;
    if (!res || res.error) { fail('cmSwDiag ' + (res?.error ? 'error: ' + res.error : 'not exposed — rebuild extension')); return; }

    const { health, results, sessionCount, platforms } = res;
    const core = results.filter(r => !SYNC_FIX_TESTS.has(r.name));
    const sync = results.filter(r => SYNC_FIX_TESTS.has(r.name));

    log('--- Core Extension Tests ---');
    for (const r of core) {
      if (r.ok) pass(r.name + ' (w:' + r.weight + ')' + (r.detail ? ' — ' + r.detail : ''));
      else fail(r.name + ' (w:' + r.weight + ')' + (r.detail ? ' — ' + r.detail : ''));
    }

    if (sync.length > 0) {
      log('--- Sync-Fix Verification Tests ---');
      for (const r of sync) {
        if (r.ok) pass(r.name + ' (w:' + r.weight + ')' + (r.detail ? ' — ' + r.detail : ''));
        else fail(r.name + ' (w:' + r.weight + ')' + (r.detail ? ' — ' + r.detail : ''));
      }
    }

    log('==============================================================');
    log('SUMMARY');
    log('==============================================================');
    const failed = results.filter(r => !r.ok);
    if (failed.length === 0) pass('ALL ' + results.length + ' CHECKS PASSED');
    else fail(failed.length + ' check(s) failed');
    log('HEALTH SCORE: ' + health + '%');
    if (health >= 90) pass('Status: EXCELLENT');
    else if (health >= 70) warn('Status: DEGRADED');
    else fail('Status: CRITICAL');
    if (sessionCount > 0) info('Sessions: ' + sessionCount + ' (' + Object.entries(platforms).map(([p,c]) => p+'='+c).join(', ') + ')');
    if (failed.length > 0) { log('--- Failed Tests ---'); failed.forEach(f => log('  \u2717 ' + f.name)); }
    log('==============================================================');
    log('SW Diagnostic complete. Health: ' + health + '%');
    log('==============================================================');
    return { health, results, failed: failed.map(f => f.name), sessionCount, platforms };
  } catch (e) {
    fail('Fatal: ' + e.message);
    fail('Ensure the SW is built with the CM_SW_DIAG handler.');
  }
})();
