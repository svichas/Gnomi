import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Report as ReportData } from '@gnomi/engine/types.ts';
import { reportToMarkdown } from '@gnomi/engine/report/markdown.ts';
import type { ReportFormat } from '../../reports.ts';
import { InFile, Report } from './Report.tsx';
import { when } from './ui.tsx';
import css from './styles.css?inline';

// Screenshots past this are left out, so a 50-persona run stays under the roadmap's 25 MB (M3) with room for the markup.
export const IMAGE_BYTES = 20_000_000;

// Unlayered, so it wins over Tailwind's layers: print everything a scroll box hides, keep cards, rows and screenshots whole, two cards to a page.
const PRINT = `@media print {
  body { background: #fff; }
  .overflow-auto, .overflow-x-auto { overflow: visible; max-height: none; }
  .shadow-sm { box-shadow: none; }
  h1, h2, h3, h4 { break-after: avoid; }
  li, tr, img, blockquote, dl > div { break-inside: avoid; }
  img { max-height: 3in; }
}`;

const escapeHtml = (text: string) => text.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

function Page({ report, screenshot }: { report: ReportData; screenshot: (path: string, alt: string) => ReactNode }) {
  return (
    <main className="mx-auto max-w-5xl space-y-4 px-4 py-6">
      <header>
        <h1 className="text-lg font-semibold text-stone-900">Gnomi report</h1>
        <p className="break-words text-sm text-stone-500">
          Run {report.run_id} on {report.poi.start_url}, started {when(report.started_at)}
        </p>
      </header>
      <Report report={report} onInspect={() => {}} renderScreenshot={screenshot} />
    </main>
  );
}

/** One HTML file drawn by the report component itself: styles inline, evidence screenshots as small data URLs, no scripts, nothing fetched. */
export async function reportHtml(report: ReportData, thumbnails: (paths: string[]) => Promise<Record<string, string>>): Promise<string> {
  const images = new Map<string, string>();
  const shown: string[] = [];
  const screenshot = (path: string, alt: string) => {
    shown.push(path);
    const image = images.get(path);
    return image ? <img src={image} alt={alt} className="max-h-128 rounded-lg border border-stone-200" /> : <p className="text-sm text-stone-500">This screenshot is not included in the file.</p>;
  };
  const draw = () =>
    renderToStaticMarkup(
      <InFile value>
        <Page report={report} screenshot={screenshot} />
      </InFile>,
    );
  draw(); // the first pass only learns which screenshots the report shows, in order
  const made = await thumbnails([...new Set(shown)]);
  let left = IMAGE_BYTES;
  for (const path of shown) {
    const image = made[path];
    if (!image || image.length > left) continue;
    images.set(path, image);
    left -= image.length;
  }
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">
<title>${escapeHtml(`Gnomi report: ${report.goal}`)}</title>
<style>${css}
${PRINT}</style>
</head>
<body class="bg-stone-50 text-stone-900 antialiased">${draw()}</body>
</html>
`;
}

/** What goes in the exported file; for PDF that is the HTML main prints. */
export async function reportFile(report: ReportData, format: ReportFormat, thumbnails: (paths: string[]) => Promise<Record<string, string>>): Promise<string> {
  if (format === 'json') return JSON.stringify(report, null, 2);
  if (format === 'md') return reportToMarkdown(report);
  return reportHtml(report, thumbnails);
}
