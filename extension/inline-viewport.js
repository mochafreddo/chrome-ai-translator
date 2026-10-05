// One Inline Translation Operation's viewport: discovery, scan continuation and watchers.
// Session owns the admitted Semantic Blocks; the caller owns requests and diagnostics.
(function exposeInlineViewport(globalScope) {
  'use strict';

  const inlineBlockCodec = globalScope.ChromeAiTranslatorInlineBlock ||
    (typeof module !== 'undefined' && module.exports ? require('./inline-block.js') : null);
  const INLINE_TRANSLATOR_ID = 'chrome-ai-translator-inline';
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
    let scanStartIndex = 0;
    let timer = null;
    let observer = null;
    let scrollTargets = [];

    function isCurrent() {
      return !stopped && session.status === 'active' && session.isCurrent(operationId);
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
        if (element === root) break;
      }
      return null;
    }

    function isElementHidden(el) {
      if (!el || !(el instanceof platform.HTMLElement)) return false;
      const style = platform.window.getComputedStyle(el);
      return (
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        style.opacity === '0' ||
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

    function getInlineTextNodeRect(textNode) {
      try {
        const range = platform.document.createRange();
        range.selectNodeContents(textNode);
        const rect = range.getBoundingClientRect();
        range.detach?.();
        if (rect && (rect.width || rect.height)) return rect;
      } catch {}
      return textNode.parentElement?.getBoundingClientRect?.() || null;
    }

    function isInlineTextNodeInViewport(textNode, viewport = getInlineViewportInfo()) {
      return isInlineRectInViewport(
        getInlineTextNodeRect(textNode),
        viewport
      );
    }

    function shouldSkipInlineBlockCandidateTextNode(textNode) {
      const parent = textNode?.parentElement;
      if (!parent) return true;
      if (parent.closest(`#${INLINE_TRANSLATOR_ID}`)) return true;
      if (isInlineEffectivelyEditable(parent)) return true;
      for (let element = parent; element; element = element.parentElement) {
        if (isInlineTranslationExcludedElement(element)) return true;
        if (isElementHidden(element)) return true;
      }
      const value = String(textNode.nodeValue || '').replace(/\s+/g, ' ').trim();
      if (!/[A-Za-z]/.test(value)) return true;
      return inlineBlockCodec.isCodeLikeInlineText(value);
    }

    function isInlineTextNode(node) {
      return Boolean(node && node.nodeType === 3);
    }

    function shouldSkipInlineElementSubtree(node, viewport = getInlineViewportInfo()) {
      if (!node || !(node instanceof platform.HTMLElement)) return false;
      if (node.closest?.(`#${INLINE_TRANSLATOR_ID}`)) return true;
      if (
        isInlineTranslationExcludedElement(node) ||
        isInlineEffectivelyEditable(node) ||
        isElementHidden(node)
      ) {
        return true;
      }
      const rect = node.getBoundingClientRect?.();
      return rect ? !isInlineRectInViewport(rect, viewport) : false;
    }

    function getInlineChildNodes(node) {
      return Array.from(node?.childNodes || []);
    }

    function collectVisibleBlocks() {
      const startIndex = scanStartIndex;
      const limit = 1200;
      const viewport = getInlineViewportInfo();
      const queuedBlocks = new Set();
      const stack = [root];
      let textIndex = 0;
      let inspected = 0;
      let truncated = false;

      while (stack.length) {
        const node = stack.pop();
        if (isInlineTextNode(node)) {
          if (textIndex < startIndex) {
            textIndex += 1;
            continue;
          }
          if (inspected >= limit) {
            truncated = true;
            break;
          }
          textIndex += 1;
          inspected += 1;
          if (
            !shouldSkipInlineBlockCandidateTextNode(node) &&
            isInlineTextNodeInViewport(node, viewport)
          ) {
            const block = findInlineSemanticBlock(node, root);
            if (block && !queuedBlocks.has(block)) {
              queuedBlocks.add(block);
              session.admit(block);
            }
          }
          continue;
        }

        if (shouldSkipInlineElementSubtree(node, viewport)) continue;
        const children = getInlineChildNodes(node);
        for (let index = children.length - 1; index >= 0; index -= 1) {
          stack.push(children[index]);
        }
      }

      scanStartIndex = truncated ? textIndex : 0;
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
      if (!root || !isCurrent()) return;
      collectVisibleBlocks();
      if (scanStartIndex > 0) rescan();
      onScan();
    }

    function rescan() {
      if (!root || !isCurrent()) return;
      if (timer !== null) platform.clearTimeout(timer);
      timer = platform.setTimeout(() => {
        timer = null;
        scan();
      }, 250);
    }

    // Page changes invalidate the queued viewport, while Start and continuation retain it.
    function onViewportChange() {
      if (!isCurrent()) return;
      scanStartIndex = 0;
      session.resetQueue();
      rescan();
    }

    function start(articleRoot) {
      if (root || !isCurrent()) return;
      root = articleRoot;
      scrollTargets = getInlineViewportScrollTargets(root);
      for (const target of scrollTargets) {
        target.addEventListener('scroll', onViewportChange, { passive: true });
      }
      platform.window.addEventListener('resize', onViewportChange);
      observer = new platform.MutationObserver(onViewportChange);
      observer.observe(root, { childList: true, subtree: true, characterData: true });
      scan();
    }

    function stop() {
      if (stopped) return;
      stopped = true;
      if (timer !== null) {
        platform.clearTimeout(timer);
        timer = null;
      }
      for (const target of scrollTargets) {
        target.removeEventListener('scroll', onViewportChange);
      }
      if (root) platform.window.removeEventListener('resize', onViewportChange);
      observer?.disconnect();
      observer = null;
      scrollTargets = [];
    }

    return { start, rescan, stop };
  }

  const api = { createInlineViewport };
  globalScope.ChromeAiTranslatorInlineViewport = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
