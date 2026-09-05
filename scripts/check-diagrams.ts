/**
 * Parse-check every Mermaid block in the docs, using the real library.
 *
 * A diagram that fails to render is worse than no diagram: GitHub shows the
 * reader a wall of raw source exactly where the architecture should be, and you
 * do not find out from your editor. So the blocks are extracted from the
 * markdown they actually ship in and rendered by mermaid itself in a real
 * browser -- the same thing GitHub does.
 *
 *   node scripts/check-diagrams.ts
 */

import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { isMain } from '../src/util/main.ts';

const DOCS = ['README.md', 'REPORT.md', 'evidence/README.md', 'evidence/public-site/README.md'];

type Block = { doc: string; index: number; source: string };

export function extractMermaid(markdown: string, doc: string): Block[] {
  const out: Block[] = [];
  const re = /```mermaid\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(markdown)) !== null) out.push({ doc, index: ++i, source: m[1]! });
  return out;
}

async function main(): Promise<void> {
  const blocks: Block[] = [];
  for (const doc of DOCS) {
    let text: string;
    try {
      text = readFileSync(doc, 'utf8');
    } catch {
      continue; // a doc that does not exist yet is not a failure
    }
    blocks.push(...extractMermaid(text, doc));
  }

  if (!blocks.length) {
    console.log('no mermaid blocks found');
    return;
  }

  const browser = await chromium.launch({ channel: 'chromium', headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<html><body></body></html>');
    await page.addScriptTag({ url: 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js' });
    await page.waitForFunction(() => 'mermaid' in window, { timeout: 30_000 });
    await page.evaluate(() => (window as unknown as { mermaid: { initialize: (o: unknown) => void } }).mermaid.initialize({ startOnLoad: false }));

    let failed = 0;
    for (const b of blocks) {
      const res = (await page.evaluate(async (text: string) => {
        const m = (window as unknown as { mermaid: { parse: (t: string) => Promise<unknown>; render: (id: string, t: string) => Promise<{ svg: string }> } }).mermaid;
        try {
          await m.parse(text);
          const { svg } = await m.render('probe' + Math.random().toString(36).slice(2), text);
          return { ok: true, bytes: svg.length };
        } catch (e) {
          return { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
      }, b.source)) as { ok: boolean; bytes?: number; error?: string };

      const label = `${b.doc} #${b.index}`;
      if (res.ok) console.log(`  ok    ${label.padEnd(34)} ${res.bytes} bytes of SVG`);
      else {
        failed++;
        console.log(`  FAIL  ${label}`);
        console.log(`        ${String(res.error).split('\n').slice(0, 4).join('\n        ')}`);
      }
    }

    console.log(failed ? `\n${failed} of ${blocks.length} would not render on GitHub` : `\nall ${blocks.length} diagrams render`);
    if (failed) process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

if (isMain(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
