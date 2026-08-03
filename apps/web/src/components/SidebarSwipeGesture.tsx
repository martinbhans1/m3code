import { useEffect, useRef } from "react";

import { useSidebar } from "./ui/sidebar";

/**
 * Swipe right anywhere in the app to open the thread sidebar, swipe left to
 * close it again. Mobile only.
 *
 * Deliberately NOT an edge swipe: iOS Safari owns the first ~20px of the left
 * edge for its back-navigation gesture, and that gesture cannot be reliably
 * suppressed from a web page. Starting detection past `EDGE_EXCLUSION_PX` means
 * the two never compete — an edge drag still navigates back, a drag that starts
 * slightly inboard opens the sidebar.
 */
const EDGE_EXCLUSION_PX = 30;
const MIN_HORIZONTAL_PX = 64;
const MAX_VERTICAL_PX = 45;
const HORIZONTAL_RATIO = 1.6;
const MAX_DURATION_MS = 700;

/** Controls that own horizontal drags themselves, wherever they appear. */
const IGNORED_SELECTOR = [
  "input",
  "textarea",
  "select",
  '[contenteditable="true"]',
  "[data-chat-composer-form]",
  '[role="slider"]',
  '[aria-roledescription="sortable"]',
  "[data-no-swipe]",
  ".xterm",
].join(",");

/**
 * On top of an open overlay a right-swipe already means something to that
 * overlay (dismiss a right-hand sheet, previous image), so it must not also
 * drag the thread sidebar open behind it. The sidebar's own sheet is exempt —
 * swiping it away is exactly the close gesture we want.
 */
const OVERLAY_SELECTOR = ['[role="dialog"]', '[role="alertdialog"]', '[role="menu"]'].join(",");
const SIDEBAR_SHEET_SELECTOR = '[data-sidebar="sidebar"]';

/**
 * The nearest ancestor that can actually scroll sideways.
 *
 * Note the deliberate absence of a computed-style check: when `overflow-y` is
 * set and `overflow-x` is left `visible`, CSS computes `overflow-x` to `auto`,
 * so *every* vertical scroller in the app reports `overflowX === "auto"`. Using
 * that as the test disabled the gesture over most of the screen. Instead we
 * find candidates by scroll extent and let the caller compare `scrollLeft`
 * before and after — the only thing that proves a pane really consumed the
 * drag.
 */
function findHorizontalScroller(target: Element | null): Element | null {
  let node: Element | null = target;
  while (node && node !== document.body) {
    if (node.scrollWidth > node.clientWidth + 1) {
      return node;
    }
    node = node.parentElement;
  }
  return null;
}

export function SidebarSwipeGesture() {
  const { isMobile, openMobile, setOpenMobile } = useSidebar();
  // Kept in a ref so opening/closing doesn't tear down and re-add listeners.
  const openMobileRef = useRef(openMobile);
  openMobileRef.current = openMobile;

  useEffect(() => {
    if (!isMobile) {
      return;
    }

    let startX = 0;
    let startY = 0;
    let startedAt = 0;
    let tracking = false;
    let scroller: Element | null = null;
    let scrollerStartLeft = 0;

    const onTouchStart = (event: TouchEvent) => {
      const touch = event.touches[0];
      if (event.touches.length !== 1 || !touch) {
        tracking = false;
        return;
      }

      const target = event.target instanceof Element ? event.target : null;
      const insideSidebarSheet = target?.closest(SIDEBAR_SHEET_SELECTOR) != null;
      if (
        target?.closest(IGNORED_SELECTOR) ||
        (!insideSidebarSheet && target?.closest(OVERLAY_SELECTOR)) ||
        touch.clientX < EDGE_EXCLUSION_PX
      ) {
        tracking = false;
        return;
      }

      scroller = findHorizontalScroller(target);
      scrollerStartLeft = scroller?.scrollLeft ?? 0;
      startX = touch.clientX;
      startY = touch.clientY;
      startedAt = event.timeStamp;
      tracking = true;
    };

    const onTouchEnd = (event: TouchEvent) => {
      if (!tracking) {
        return;
      }
      tracking = false;

      const touch = event.changedTouches[0];
      if (!touch || event.timeStamp - startedAt > MAX_DURATION_MS) {
        return;
      }

      // A pane under the finger actually scrolled sideways — that drag was its.
      if (scroller && scroller.scrollLeft !== scrollerStartLeft) {
        return;
      }

      const deltaX = touch.clientX - startX;
      const deltaY = touch.clientY - startY;
      if (
        Math.abs(deltaX) < MIN_HORIZONTAL_PX ||
        Math.abs(deltaY) > MAX_VERTICAL_PX ||
        Math.abs(deltaX) < Math.abs(deltaY) * HORIZONTAL_RATIO
      ) {
        return;
      }

      if (deltaX > 0 && !openMobileRef.current) {
        setOpenMobile(true);
      } else if (deltaX < 0 && openMobileRef.current) {
        setOpenMobile(false);
      }
    };

    const onTouchCancel = () => {
      tracking = false;
    };

    window.addEventListener("touchstart", onTouchStart, { passive: true });
    window.addEventListener("touchend", onTouchEnd, { passive: true });
    window.addEventListener("touchcancel", onTouchCancel, { passive: true });

    return () => {
      window.removeEventListener("touchstart", onTouchStart);
      window.removeEventListener("touchend", onTouchEnd);
      window.removeEventListener("touchcancel", onTouchCancel);
    };
  }, [isMobile, setOpenMobile]);

  return null;
}
