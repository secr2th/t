// ==UserScript==
// @name         CodeBlock Re-render Trigger (TavernHelper)
// @version      0.4
// @description  Detect DOM swaps that remove rendered front-end code iframes and trigger the renderer again (only uses JS, no Vue/TS edits). Drop into a userscript manager or run in console.
// @author       secr2th (adapted)
// @match        *://*/*
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  // CONFIG
  const DEBUG = false;
  const DEBOUNCE_MS = 120; // per-message debounce
  const CHAT_SELECTOR = '#chat'; // primary chat container selector (fallbacks applied)
  const MESSAGE_SELECTOR = '.mes';
  const MESSAGE_TEXT_SELECTOR = '.mes_text';
  const FRONTEND_MARKERS = ['html>', '<head>', '<body']; // used to detect frontend code

  function log(...args) {
    if (DEBUG) console.log('[CodeBlock Re-render]', ...args);
  }

  function isFrontend(content) {
    if (!content) return false;
    content = content.toLowerCase();
    return FRONTEND_MARKERS.some(tag => content.includes(tag));
  }

  // Helpers to detect whether a pre is already rendered into TH-render with an iframe
  function isPreRendered(preEl) {
    if (!preEl) return false;
    const parent = preEl.parentElement;
    if (!parent) return false;
    if (parent.classList.contains('TH-render')) {
      return !!parent.querySelector('iframe');
    }
    return false;
  }

  // Try multiple safe ways to ask the app to re-render a single message by id.
  // Returns true if any attempt was made.
  function tryTriggerRerender(messageId, mesTextEl) {
    log('Trigger rerender for', messageId);

    // Primary: TavernHelper.refreshOneMessage if available
    try {
      if (typeof window.TavernHelper !== 'undefined' && typeof window.TavernHelper.refreshOneMessage === 'function') {
        log('Calling TavernHelper.refreshOneMessage', messageId);
        window.TavernHelper.refreshOneMessage(Number(messageId));
        return true;
      }
    } catch (e) {
      log('TavernHelper call failed', e);
    }

    // Secondary: eventSource + known event types (best-effort)
    try {
      if (typeof window.eventSource !== 'undefined') {
        // Try known event type container
        if (typeof window.event_types !== 'undefined' && window.event_types && window.event_types.MESSAGE_UPDATED) {
          log('Emitting event_types.MESSAGE_UPDATED', messageId);
          window.eventSource.emit(window.event_types.MESSAGE_UPDATED, Number(messageId));
          return true;
        }
        // Try a few likely event names
        const candidates = [
          'MESSAGE_UPDATED',
          'message_updated',
          'messageUpdated',
          'MESSAGE:UPDATED',
          'render_message',
          'refresh_message',
        ];
        for (const name of candidates) {
          try {
            log('Attempting eventSource.emit(', name, ')');
            window.eventSource.emit(name, Number(messageId));
            // don't return immediately — sometimes emit is noop, but we'll assume it's okay
            return true;
          } catch (e) {
            // ignore and try next
          }
        }
      }
    } catch (e) {
      log('eventSource attempt failed', e);
    }

    // Third: dispatch a CustomEvent on the message node. Some systems listen for DOM events.
    try {
      if (mesTextEl) {
        const ev = new CustomEvent('tavernhelper:message-updated', {
          bubbles: true,
          detail: { mesid: Number(messageId) },
        });
        mesTextEl.dispatchEvent(ev);
        log('Dispatched tavernhelper:message-updated CustomEvent', messageId);
        return true;
      }
    } catch (e) {
      log('CustomEvent dispatch failed', e);
    }

    // Fourth: try to find known global functions by name heuristics
    try {
      for (const fnName of Object.getOwnPropertyNames(window)) {
        if (!fnName.toLowerCase().includes('message') && !fnName.toLowerCase().includes('refresh')) continue;
        const f = window[fnName];
        if (typeof f === 'function') {
          try {
            // call only if function accepts 1 numeric argument heuristically — we try, but catch exceptions
            f(Number(messageId));
            log('Called heuristic function', fnName, 'with', messageId);
            return true;
          } catch (e) {
            // ignore
          }
        }
      }
    } catch (e) {
      log('Heuristic global function attempts failed', e);
    }

    // Fifth: look for render buttons near the message and click them if present
    try {
      if (mesTextEl) {
        // common patterns/buttons text in some locales
        const possibleButtonTexts = [
          '渲染前端界面', 'Render frontend', 'Render', '显示前端代码块', '显示前端', 'render front', 'Render code'
        ];
        const buttons = mesTextEl.querySelectorAll('button, a, .btn, .TH-collapse-code-block-button');
        for (const btn of buttons) {
          const txt = (btn.textContent || '').trim();
          if (!txt) continue;
          for (const candidate of possibleButtonTexts) {
            if (txt.includes(candidate) || candidate.includes(txt)) {
              log('Clicking button to force render:', txt);
              btn.click();
              return true;
            }
          }
        }
      }
    } catch (e) {
      log('Button click fallback failed', e);
    }

    // Last resort: re-insert a tiny mutation so other systems watching subtree changes may re-evaluate
    try {
      if (mesTextEl) {
        const marker = document.createElement('span');
        marker.style.display = 'none';
        marker.className = '__cb_rerender_marker__';
        mesTextEl.appendChild(marker);
        setTimeout(() => {
          marker.remove();
        }, 300);
        log('Inserted marker to nudge mutation watchers');
        return true;
      }
    } catch (e) {
      log('Marker insertion failed', e);
    }

    log('No rerender method succeeded for', messageId);
    return false;
  }

  // Observe a single .mes_text element for significant changes and attempt re-render when necessary.
  function observeMesText(mesTextEl, state) {
    if (!mesTextEl || state.observed.has(mesTextEl)) return;
    state.observed.add(mesTextEl);

    const mesEl = mesTextEl.closest(MESSAGE_SELECTOR);
    if (!mesEl) return;
    const messageId = mesEl.getAttribute('mesid') || mesEl.getAttribute('data-mesid') || mesEl.getAttribute('data-id');

    // Per-message debounce timer storage
    let timer = null;

    const mo = new MutationObserver(function (mutations) {
      // Quick filter: if only attributes or minor text changes, ignore
      let significant = false;
      for (const m of mutations) {
        if (m.type === 'childList') {
          // added/removed nodes are significant
          if (m.addedNodes.length > 0 || m.removedNodes.length > 0) {
            significant = true;
            break;
          }
        } else if (m.type === 'characterData') {
          significant = true;
          break;
        } else if (m.type === 'attributes') {
          // attribute changes on relevant elements may be significant
          significant = true;
          break;
        }
      }
      if (!significant) return;

      // Debounce per message
      if (timer) clearTimeout(timer);
      timer = setTimeout(function () {
        timer = null;

        // Find <pre> blocks inside mesTextEl
        const pres = Array.from(mesTextEl.querySelectorAll('pre'));
        let foundFrontend = false;
        let needsRender = false;
        for (const pre of pres) {
          const content = (pre.textContent || '').trim();
          if (!isFrontend(content)) continue;
          foundFrontend = true;
          if (!isPreRendered(pre)) {
            needsRender = true;
            break;
          }
        }

        if (!foundFrontend) {
          // nothing to do for this message
          return;
        }

        if (!needsRender) {
          // already rendered
          return;
        }

        log('Detected unrendered frontend code in message', messageId);
        // Immediate attempt to restore/preserve may be done by other scripts - try triggering rerender
        if (!tryTriggerRerender(messageId, mesTextEl)) {
          log('Trigger attempts for', messageId, 'did not find a suitable handler; will retry after small delay');
          // try again once after short delay
          setTimeout(() => tryTriggerRerender(messageId, mesTextEl), 250);
        }
      }, DEBOUNCE_MS);
    });

    mo.observe(mesTextEl, { childList: true, subtree: true, characterData: true, attributes: false });

    // Keep reference so we can disconnect if needed
    state.observers.push(mo);
    log('Observing mes_text', messageId);
  }

  // Set up observers on existing messages and for new message additions
  function setup() {
    log('Setup started');

    // Determine chat container
    let chatEl = document.querySelector(CHAT_SELECTOR);
    if (!chatEl) {
      // fallback heuristics
      chatEl = document.getElementById('chat') || document.querySelector('.chat') || document.body;
    }

    const state = {
      observers: [],
      observed: new WeakSet()
    };

    // Observe existing messages
    const existing = chatEl.querySelectorAll(MESSAGE_SELECTOR + ' ' + MESSAGE_TEXT_SELECTOR);
    existing.forEach(el => observeMesText(el, state));

    // Observe for newly added .mes
    const chatObserver = new MutationObserver(function (mutations) {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          const el = node;
          if (el.matches && el.matches(MESSAGE_SELECTOR)) {
            const mesText = el.querySelector(MESSAGE_TEXT_SELECTOR) || el.querySelector('.mes_text');
            if (mesText) observeMesText(mesText, state);
          } else {
            // maybe a subtree insert
            const mesEls = el.querySelectorAll ? el.querySelectorAll(MESSAGE_SELECTOR) : [];
            for (const mes of mesEls) {
              const mesText = mes.querySelector(MESSAGE_TEXT_SELECTOR) || mes.querySelector('.mes_text');
              if (mesText) observeMesText(mesText, state);
            }
          }
        }
      }
    });

    chatObserver.observe(chatEl, { childList: true, subtree: true });
    state.observers.push(chatObserver);

    // Optional: listen for a global chatLoaded event (some scripts emit it)
    if (typeof window.eventSource !== 'undefined' && typeof window.eventSource.on === 'function') {
      try {
        window.eventSource.on('chatLoaded', () => {
          log('chatLoaded event: re-scan messages');
          // small delay for DOM settle
          setTimeout(() => {
            const all = chatEl.querySelectorAll(MESSAGE_SELECTOR + ' ' + MESSAGE_TEXT_SELECTOR);
            all.forEach(el => observeMesText(el, state));
          }, 400);
        });
      } catch (e) {
        // ignore
      }
    }

    log('Setup complete, observed existing messages:', existing.length);
  }

  // Start once DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setup);
  } else {
    setup();
  }

})();
