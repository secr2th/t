(function () {
    'use strict';

    const EXTENSION_NAME = 'CodeBlock-Render-Fixer-v3';
    const DEBUG = true; 

    function log(...args) {
        if (DEBUG) console.log('[' + EXTENSION_NAME + ']', ...args);
    }

    // 프론트엔드 코드인지 확인 (Iframe.vue의 로직과 일치시킴)
    function isFrontend(content) {
        return ['html>', '<head>', '<body'].some(tag => content.includes(tag));
    }

    // 1. 메시지 아이디를 가져오는 유틸리티
    function getMessageId(el) {
        const mesEl = el.closest('.mes');
        return mesEl ? mesEl.getAttribute('mesid') : null;
    }

    // 2. 핵심 함수: TavernHelper의 이벤트를 이용해 해당 메시지만 '부분 재렌더링'
    function triggerPartialRender(mesTextEl) {
        const messageId = getMessageId(mesTextEl);
        if (!messageId) return;

        log('Triggering partial render for message:', messageId);

        // [중요] refreshOneMessage(전체 새로고침) 대신 
        // SillyTavern의 MESSAGE_UPDATED 이벤트를 발생시켜 
        // 현재 DOM에 있는 텍스트(번역본)를 기반으로 확장 기능이 다시 붙게 만듭니다.
        if (typeof eventSource !== 'undefined' && typeof event_types !== 'undefined') {
            // 서버에 요청하지 않고, 이미 로드된 데이터 안에서 렌더링만 다시 수행하도록 유도
            eventSource.emit(event_types.MESSAGE_UPDATED, Number(messageId));
        }
    }

    function setupObservers() {
        const chatEl = document.getElementById('chat');
        if (!chatEl) {
            setTimeout(setupObservers, 1000);
            return;
        }

        const observedElements = new WeakSet();
        const debounceTimers = {};

        function observeMesText(mesTextEl) {
            if (observedElements.has(mesTextEl)) return;
            observedElements.has(mesTextEl);

            const observer = new MutationObserver((mutations) => {
                // 번역기 등에 의해 내용이 변했는지 확인
                let shouldRender = false;
                
                for (const mutation of mutations) {
                    // 1. TH-render(iframe 감싸는거)가 사라졌거나
                    // 2. 내부 텍스트가 대량으로 바뀌었을 때
                    if (mutation.removedNodes.length > 0) {
                        mutation.removedNodes.forEach(node => {
                            if (node.nodeType === Node.ELEMENT_NODE && 
                                (node.classList?.contains('TH-render') || node.querySelector?.('.TH-render'))) {
                                shouldRender = true;
                            }
                        });
                    }
                }

                if (!shouldRender) return;

                const messageId = getMessageId(mesTextEl);
                if (!messageId) return;

                // 디바운스로 번역이 완전히 끝날 때까지 대기 (600ms)
                if (debounceTimers[messageId]) clearTimeout(debounceTimers[messageId]);
                debounceTimers[messageId] = setTimeout(() => {
                    // 이미 iframe이 잘 있으면 패스
                    if (mesTextEl.querySelector('iframe')) return;

                    // 프론트엔드 코드가 포함되어 있는지 최종 확인
                    const code = mesTextEl.querySelector('pre')?.textContent || '';
                    if (isFrontend(code)) {
                        log('Inconsistency detected. Re-applying Vue component...');
                        triggerPartialRender(mesTextEl);
                    }
                }, 600);
            });

            observer.observe(mesTextEl, { childList: true, subtree: true });
        }

        // 초기 로드된 메시지들 감시
        chatEl.querySelectorAll('.mes .mes_text').forEach(observeMesText);

        // 새로 추가되는 메시지들 감시
        const chatObserver = new MutationObserver((mutations) => {
            mutations.forEach(mutation => {
                mutation.addedNodes.forEach(node => {
                    if (node.nodeType === Node.ELEMENT_NODE && node.classList?.contains('mes')) {
                        const mesText = node.querySelector('.mes_text');
                        if (mesText) observeMesText(mesText);
                    }
                });
            });
        });

        chatObserver.observe(chatEl, { childList: true });
    }

    // 초기화 실행
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', setupObservers);
    } else {
        setupObservers();
    }
})();
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
