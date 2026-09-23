"use strict";
// Shared harness for the jsdom unit tests: loads a fixture page at a given URL and injects
// content.js into it the way Chrome would (a classic script evaluated in the page's window),
// then hands back the extension's test hook (window.__prks).
//
// jsdom has no layout engine, so geometry-based code sees all-zero rects unless a test gives
// elements a fake box with layout(). Scrolling APIs are stubbed and recorded for assertions.

const fs = require("node:fs");
const path = require("node:path");
const { JSDOM, VirtualConsole } = require("jsdom");

const ROOT = path.join(__dirname, "..", "..");
const FIXTURES = path.join(ROOT, "test", "fixtures");
const CONTENT_JS = fs.readFileSync(path.join(ROOT, "content.js"), "utf8");

function loadPage(fixture, url) {
  const html = fs.readFileSync(path.join(FIXTURES, fixture), "utf8");
  const warnings = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("warn", (...args) => warnings.push(args.join(" ")));
  virtualConsole.on("error", () => {}); // jsdom "not implemented: navigation" noise
  virtualConsole.on("jsdomError", () => {});
  const dom = new JSDOM(html, {
    url,
    runScripts: "dangerously", // fixtures carry tiny scripts that stand in for GitHub's handlers
    pretendToBeVisual: true, // requestAnimationFrame
    virtualConsole,
  });
  const { window } = dom;
  window.scrollCalls = [];
  window.scrollTo = (opts) => window.scrollCalls.push(opts);
  window.Element.prototype.scrollIntoView = function () {
    window.scrollCalls.push({ el: this });
  };
  window.eval(CONTENT_JS);
  return { dom, window, document: window.document, prks: window.__prks, warnings };
}

// Soft-navigate the loaded page to a new URL (the DOM stays put), like Turbo does.
function navigate(dom, url) {
  dom.reconfigure({ url });
}

// Give an element a fake layout box. `top` is viewport-relative like the real API.
function layout(el, { top, height = 20 }) {
  const rect = {
    top,
    bottom: top + height,
    height,
    left: 0,
    right: 800,
    width: 800,
    x: 0,
    y: top,
  };
  el.getBoundingClientRect = () => rect;
  el.getClientRects = () => [rect];
}

// Lay out a file so its header is the first thing below the sticky page header — i.e. it is
// the "current" file for getCurrentIndex and its header is on screen.
function layoutAsCurrent(prks, file, { headerHeight = 40, bodyHeight = 400 } = {}) {
  const top = prks.STICKY_OFFSET + 10;
  layout(file, { top, height: headerHeight + bodyHeight });
  layout(prks.fileHeader(file), { top, height: headerHeight });
}

// Lay out a file as fully scrolled past (above the sticky line).
function layoutAsScrolledPast(file, { height = 400 } = {}) {
  layout(file, { top: -height - 100, height });
}

function press(window, key, init = {}) {
  const e = new window.KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  window.document.dispatchEvent(e);
  return e;
}

function toastText(document) {
  const t = document.querySelector(".prks-toast");
  return t ? t.textContent : null;
}

// Resolve after two animation frames (goToFile re-positions on a double rAF).
function twoFrames(window) {
  return new Promise((resolve) =>
    window.requestAnimationFrame(() => window.requestAnimationFrame(resolve))
  );
}

const PR = "https://github.com/o/r/pull/7";

module.exports = {
  PR,
  loadPage,
  navigate,
  layout,
  layoutAsCurrent,
  layoutAsScrolledPast,
  press,
  toastText,
  twoFrames,
};
