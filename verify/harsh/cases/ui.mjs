// Case: a UI change that has to be looked at (verify/harsh/fixtures/ui).
//
// The page is opened in headless Chrome and measured as a browser lays it out: the banner's effective background,
// the contrast of its text against it, and whether its box overlaps the Save button's. The measurement lives here,
// not in the page, so the page cannot describe itself as passing.
import fs from "node:fs";
import path from "node:path";
import { NoBrowser, openPage } from "../lib/chrome.mjs";
import { couldNotExercise, failed, passed, places } from "../../lib/verdict.mjs";

const { target } = places(process.argv);

const page = path.join(target, "page.html");
if (!fs.existsSync(page)) failed("page.html is gone, so there is nothing to look at");

const MEASURE = `(() => {
  const parse = (value) => {
    const match = String(value).match(/rgba?\\(([^)]+)\\)/);
    if (!match) return null;
    const [r, g, b, a = "1"] = match[1].split(",").map((part) => parseFloat(part));
    return { r, g, b, a: Number.isFinite(a) ? a : 1 };
  };
  const luminance = ({ r, g, b }) => {
    const channel = (value) => {
      const v = value / 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  };
  const banner = document.querySelector("[data-banner]");
  const button = document.querySelector("[data-save]");
  if (!banner || !button) return { found: false };

  const style = getComputedStyle(banner);
  const visible =
    style.display !== "none" &&
    style.visibility !== "hidden" &&
    parseFloat(style.opacity) > 0 &&
    banner.getBoundingClientRect().width > 0 &&
    banner.getBoundingClientRect().height > 0;

  let element = banner;
  let background = parse(getComputedStyle(element).backgroundColor);
  while (element && (!background || background.a === 0)) {
    element = element.parentElement;
    background = element ? parse(getComputedStyle(element).backgroundColor) : null;
  }
  if (!background) background = { r: 255, g: 255, b: 255, a: 1 };

  const foreground = parse(style.color);
  if (!foreground) return { found: true, measured: false };

  const first = luminance(foreground);
  const second = luminance(background);
  const contrast = (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);

  const bannerBox = banner.getBoundingClientRect();
  const buttonBox = button.getBoundingClientRect();
  const overlap = !(
    bannerBox.right <= buttonBox.left ||
    bannerBox.left >= buttonBox.right ||
    bannerBox.bottom <= buttonBox.top ||
    bannerBox.top >= buttonBox.bottom
  );
  return { found: true, measured: true, visible, contrast, overlap };
})()`;

let browser;
try {
  browser = await openPage(page);
} catch (error) {
  if (error instanceof NoBrowser) couldNotExercise(error.message);
  couldNotExercise(`the page could not be opened: ${error.message}`);
}

let measured;
let trouble = null;
try {
  measured = await browser.evaluate(MEASURE);
} catch (error) {
  trouble = error;
} finally {
  browser.close();
}
if (trouble) couldNotExercise(`the page could not be measured: ${trouble.message}`);

if (!measured?.found) failed("the page no longer has both the banner ([data-banner]) and the Save button ([data-save])");
if (!measured.measured) couldNotExercise("the banner's colours could not be read, so nothing was measured");
if (!measured.visible) failed("the banner is hidden: a warning nobody can see does not fix it");

const contrast = Math.round(measured.contrast * 100) / 100;
if (contrast < 4.5) failed(`the banner text is ${contrast}:1 against its background (it needs at least 4.5:1)`);
if (measured.overlap) failed(`the banner still overlaps the Save button (its text is ${contrast}:1)`);

passed(`the banner text is ${contrast}:1 against its background, it is visible, and it does not overlap the Save button`);
