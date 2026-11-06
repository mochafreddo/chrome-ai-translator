// One Inline Translation Operation's viewport: discovery, scan continuation and watchers.
// Session owns the admitted Semantic Blocks; the caller owns requests and diagnostics.
(function exposeInlineViewport(globalScope) {
  'use strict';

  const inlineBlockCodec = globalScope.ChromeAiTranslatorInlineBlock ||
    (typeof module !== 'undefined' && module.exports ? require('./inline-block.js') : null);
  const INLINE_EXCLUDED_TAGS = new Set([
    'SCRIPT',
    'STYLE',
    'NOSCRIPT',
    'SVG',
    'CANVAS',
    'IFRAME',
    'NAV',
    'FOOTER',
    'FORM',
    'BUTTON',
    'INPUT',
    'TEXTAREA',
    'SELECT',
    'OPTION',
    'PRE',
    'CODE',
    'KBD',
    'SAMP',
  ]);
  const INLINE_EXCLUDED_ROLES = new Set([
    'navigation',
    'banner',
    'contentinfo',
    'complementary',
    'search',
    'form',
    'button',
    'menu',
    'menubar',
    'tablist',
    'toolbar',
  ]);

  function createInlineViewport({ session, platform = globalThis, onScan = () => {} }) {
    const operationId = session.operationId;
    let root = null;
    let stopped = false;
    let scanStack = null;
    let mutationSweep = false;
    let freshPassPending = false;
    let timer = null;
    let observer = null;
    let scrollTargets = [];
    const rootAncestors = new Set();
    let rootPaused = false;

    function isCurrent() {
      return !stopped && !rootPaused && session.status === 'active' && session.isCurrent(operationId) &&
        (!session.canSubmit || session.canSubmit());
    }

    function isInlineTranslationExcludedTag(tagName) {
      return INLINE_EXCLUDED_TAGS.has(String(tagName || '').toUpperCase());
    }

    function isInlineTranslationExcludedElement(el) {
      if (!el) return false;
      if (isInlineTranslationExcludedTag(el.tagName)) return true;
      const role = String(el.getAttribute?.('role') || '').toLowerCase();
      return INLINE_EXCLUDED_ROLES.has(role);
    }

    function isInlineEffectivelyEditable(element) {
      if (element?.isContentEditable === true) return true;
      for (let current = element; current; current = current.parentElement) {
        if (!current.hasAttribute?.('contenteditable')) continue;
        return (
          String(current.getAttribute?.('contenteditable') || '').toLowerCase() !==
          'false'
        );
      }
      return false;
    }

    function isInlineRectInViewport(
      rect,
      viewport
    ) {
      if (!rect || !viewport) return false;
      const width = Number(viewport.width) || 0;
      const height = Number(viewport.height) || 0;
      if (width <= 0 || height <= 0) return false;

      const margin = height * 0.5;
      const top = Number(rect.top);
      const bottom = Number(rect.bottom);
      const left = Number(rect.left);
      const right = Number(rect.right);

      if (![top, bottom, left, right].every(Number.isFinite)) return false;
      if (bottom < -margin) return false;
      if (top > height + margin) return false;
      if (right < 0) return false;
      if (left > width) return false;
      return true;
    }

    function findInlineSemanticBlock(textNode, root) {
      for (
        let element = textNode?.parentElement;
        element;
        element = element.parentElement
      ) {
        if (inlineBlockCodec?.isSemanticBlockElement(element)) {
          return element;
        }
        if (inlineBlockCodec?.isBlockChildContainerElement(element)) break;
        if (element === root) break;
      }
      return null;
    }

    function getInlineStyle(el, reads) {
      if (!reads.styles.has(el)) reads.styles.set(el, platform.window.getComputedStyle(el));
      return reads.styles.get(el);
    }

    function getInlineElementRect(el, reads) {
      if (!reads.rects.has(el)) reads.rects.set(el, el.getBoundingClientRect?.());
      return reads.rects.get(el);
    }

    function hasUnclippedPositionedDescendant(el, candidate, reads) {
      const stack = candidate ? [candidate] : getInlineChildNodes(el);
      while (stack.length) {
        const node = stack.pop();
        if (!node || node === el || !(node instanceof platform.HTMLElement)) continue;
        const position = getInlineStyle(node, reads).position;
        if (position === 'fixed' || position === 'absolute') {
          let container = node.offsetParent;
          while (container && container !== el) container = container.parentElement;
          if (!container) return true;
        }
        if (candidate) stack.push(node.parentElement);
        else stack.push(...getInlineChildNodes(node));
      }
      return false;
    }

    function isElementHidden(el, candidate, reads) {
      if (!el || !(el instanceof platform.HTMLElement)) return false;
      const style = getInlineStyle(el, reads);
      const rect = getInlineElementRect(el, reads);
      // A boxless ancestor can still have visible descendants. Only prune a
      // tiny box when overflow actually clips its contents in both directions.
      const tinyClippedBox = style.display !== 'contents' &&
        rect.width <= 1 && rect.height <= 1 &&
        /^(hidden|clip)$/.test(style.overflowX || style.overflow) &&
        /^(hidden|clip)$/.test(style.overflowY || style.overflow);
      return (
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        style.opacity === '0' ||
        (tinyClippedBox && !hasUnclippedPositionedDescendant(el, candidate, reads)) ||
        el.hidden ||
        el.getAttribute('aria-hidden') === 'true'
      );
    }

    function getInlineViewportInfo() {
      return {
        width: platform.window.innerWidth || platform.document.documentElement.clientWidth || 0,
        height: platform.window.innerHeight || platform.document.documentElement.clientHeight || 0,
      };
    }

    function getInlineTextNodeRect(textNode, reads) {
      try {
        const range = platform.document.createRange();
        range.selectNodeContents(textNode);
        const rect = range.getBoundingClientRect();
        range.detach?.();
        if (rect && (rect.width || rect.height)) return rect;
      } catch {}
      return textNode.parentElement ? getInlineElementRect(textNode.parentElement, reads) : null;
    }

    function isInlineTextNodeInViewport(textNode, viewport, reads) {
      return isInlineRectInViewport(
        getInlineTextNodeRect(textNode, reads),
        viewport
      );
    }

    function shouldSkipInlineBlockCandidateTextNode(textNode, reads) {
      const parent = textNode?.parentElement;
      if (!parent) return true;
      if (isInlineEffectivelyEditable(parent)) return true;
      for (let element = parent; element; element = element.parentElement) {
        if (isInlineTranslationExcludedElement(element)) return true;
        if (isElementHidden(element, parent, reads)) return true;
      }
      const value = String(textNode.nodeValue || '').replace(/\s+/g, ' ').trim();
      if (!/\p{L}/u.test(value)) return true;
      return inlineBlockCodec.isCodeLikeInlineText(value);
    }

    function isInlineTextNode(node) {
      return Boolean(node && node.nodeType === 3);
    }

    function shouldSkipInlineElementSubtree(node, viewport, reads) {
      if (!node || !(node instanceof platform.HTMLElement)) return false;
      if (
        isInlineTranslationExcludedElement(node) ||
        isInlineEffectivelyEditable(node) ||
        isElementHidden(node, null, reads)
      ) {
        return true;
      }
      const rect = getInlineElementRect(node, reads);
      return rect ? !isInlineRectInViewport(rect, viewport) : false;
    }

    function getInlineChildNodes(node) {
      return Array.from(node?.childNodes || []);
    }

    function isWithinRoot(node) {
      if (!node?.isConnected) return false;
      for (let current = node; current; current = current.parentNode) {
        if (current === root) return true;
      }
      return false;
    }

    function collectVisibleBlocks() {
      const limit = 1200;
      const viewport = getInlineViewportInfo();
      const reads = { styles: new Map(), rects: new Map() };
      const queuedBlocks = new Set();
      const stack = scanStack || [root];
      let inspected = 0;

      while (stack.length) {
        const node = stack.pop();
        if (!isWithinRoot(node)) continue;
        if (isInlineTextNode(node)) {
          if (inspected >= limit) {
            stack.push(node);
            break;
          }
          inspected += 1;
          if (
            !shouldSkipInlineBlockCandidateTextNode(node, reads) &&
            isInlineTextNodeInViewport(node, viewport, reads)
          ) {
            const block = findInlineSemanticBlock(node, root);
            if (block && !queuedBlocks.has(block)) {
              queuedBlocks.add(block);
            }
          }
          continue;
        }

        if (shouldSkipInlineElementSubtree(node, viewport, reads)) continue;
        const children = getInlineChildNodes(node);
        for (let index = children.length - 1; index >= 0; index -= 1) {
          stack.push(children[index]);
        }
      }

      scanStack = stack.length ? stack : null;
      return queuedBlocks;
    }

    function isInlineScrollableElement(el) {
      if (!el || !(el instanceof platform.HTMLElement)) return false;
      const style = platform.window.getComputedStyle(el);
      const overflowY = style.overflowY || style.overflow || '';
      if (!/(auto|scroll|overlay)/.test(overflowY)) return false;
      return Number(el.scrollHeight) > Number(el.clientHeight) + 1;
    }

    function getInlineViewportScrollTargets(root) {
      const targets = [];
      const seen = new Set();
      const addTarget = (target) => {
        if (!target || seen.has(target) || !target.addEventListener) return;
        targets.push(target);
        seen.add(target);
      };

      addTarget(platform.window);
      addTarget(platform.document);
      addTarget(platform.document.scrollingElement);
      addTarget(platform.document.documentElement);
      addTarget(platform.document.body);

      for (let el = root; el; el = el.parentElement) {
        if (isInlineScrollableElement(el)) {
          addTarget(el);
        }
      }

      return targets;
    }

    function scan() {
      if (!root?.isConnected || !isCurrent()) return;
      const blocks = collectVisibleBlocks();
      for (const block of blocks) {
        if (!isCurrent()) break;
        if (isWithinRoot(block)) session.admit(block);
      }
      if (!isCurrent()) return;
      const mutations = observer?.takeRecords?.();
      if (mutations?.length) onMutation(mutations);
      if (!isCurrent()) return;
      if (scanStack) rescan();
      else {
        mutationSweep = false;
        if (freshPassPending) {
          freshPassPending = false;
          mutationSweep = true;
          rescan();
        }
      }
      onScan();
    }

    function rescan() {
      if (!root || !isCurrent()) return;
      if (timer !== null) return;
      const scheduledTimer = platform.setTimeout(() => {
        if (timer !== scheduledTimer) return;
        timer = null;
        if (!isCurrent()) return;
        scan();
      }, 250);
      timer = scheduledTimer;
    }

    function onViewportChange() {
      if (!isCurrent()) return;
      scanStack = null;
      mutationSweep = true;
      freshPassPending = false;
      session.resetQueue();
      rescan();
    }

    function onMutation(records) {
      if (!isCurrent()) return;
      if (records?.some(record => Array.from(record.removedNodes || [])
        .some(node => rootAncestors.has(node)))) {
        rootPaused = true;
        session.pauseRoot?.();
        scanStack = null;
        session.resetQueue();
        if (timer !== null) platform.clearTimeout(timer);
        timer = null;
        return;
      }
      if (!records?.length || records.some(record => {
        for (let node = record.target; node; node = node.parentNode) {
          if (node === root) return true;
        }
        return false;
      })) {
        if (!mutationSweep) {
          onViewportChange();
          return;
        }
        // Finish a restarted sweep before revisiting changes behind its cursor.
        if (scanStack) freshPassPending = true;
        session.resetQueue();
        rescan();
      }
    }

    function start(articleRoot) {
      if (root || !isCurrent()) return;
      root = articleRoot;
      scrollTargets = getInlineViewportScrollTargets(root);
      for (const target of scrollTargets) {
        target.addEventListener('scroll', onViewportChange, { passive: true, capture: true });
      }
      platform.window.addEventListener('resize', onViewportChange);
      observer = new platform.MutationObserver(onMutation);
      observer.observe(root, { childList: true, subtree: true, characterData: true, attributes: true });
      rootAncestors.add(root);
      for (let ancestor = root.parentNode; ancestor; ancestor = ancestor.parentNode) {
        rootAncestors.add(ancestor);
        observer.observe(ancestor, { childList: true });
      }
      scan();
    }

    function stopWatching() {
      scanStack = null;
      mutationSweep = false;
      freshPassPending = false;
      if (timer !== null) {
        platform.clearTimeout(timer);
        timer = null;
      }
      for (const target of scrollTargets) {
        target.removeEventListener('scroll', onViewportChange, { capture: true });
      }
      if (root) platform.window.removeEventListener('resize', onViewportChange);
      observer?.disconnect();
      observer = null;
      scrollTargets = [];
      rootAncestors.clear();
    }

    function selectRoot(articleRoot) {
      if (stopped || !session.isCurrent(operationId)) return;
      stopWatching();
      rootPaused = false;
      root = null;
      start(articleRoot);
    }

    function stop() {
      if (stopped) return;
      stopped = true;
      stopWatching();
    }

    return { start, selectRoot, rescan, stop };
  }

  const api = { createInlineViewport };
  globalScope.ChromeAiTranslatorInlineViewport = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
