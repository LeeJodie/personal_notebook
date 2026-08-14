import { readFile } from "node:fs/promises";
import { extractDocumentFromHtml } from "../worker/crawl";

const htmlPath = process.argv[2];
const sourceUrl = process.argv[3];
if (!htmlPath || !sourceUrl) {
  throw new Error("Usage: tsx scripts/verify-crawl.ts <html-path> <source-url>");
}

const document = extractDocumentFromHtml(await readFile(htmlPath, "utf8"), sourceUrl);
console.log(JSON.stringify({
  title: document.title,
  description: document.description,
  siteName: document.siteName,
  wordCount: document.wordCount,
  sections: document.sections.slice(0, 6),
}, null, 2));
