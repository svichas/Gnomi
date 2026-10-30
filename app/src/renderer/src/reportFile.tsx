import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Report as ReportData } from '@gnomi/simulation/types.ts';
import { reportToMarkdown } from '@gnomi/simulation/report/markdown.ts';
import type { RepeatSet } from '@gnomi/simulation/report/repeats.ts';
import type { ReportFormat } from '../../reports.ts';
import { Report } from './Report.tsx';
import { InFile } from './reportParts.tsx';
import { when } from './ui.tsx';
import css from './styles.css?inline';
import resultsCss from './results.css?inline';
import font from '../../../../assets/brand/fonts/InterVariable.woff2?inline';
import logo from '../../../../assets/brand/gnomi-logo.svg?raw';

// Exports travel without the app's asset folder. Replace the bundled font URL with its embedded bytes.
const portableCss = css.replace(/@font-face\s*\{[^}]*\}/g, '') + resultsCss + `\n@font-face { font-family: 'Inter'; src: url('${font}') format('woff2'); font-style: normal; font-weight: 100 900; font-display: swap; }`;
const logoUrl = `data:image/svg+xml,${encodeURIComponent(logo)}`;

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
  .comparison-matrix { min-width: 0 !important; font-size: 10px; overflow-wrap: anywhere; }
  .comparison-matrix th:first-child { width: 20%; }
  .comparison-matrix th, .comparison-matrix td { padding: 6px; }
  .comparison-matrix .tone-chip { white-space: normal; padding: 2px 4px; font-size: 10px; }
}`;

const escapeHtml = (text: string) => text.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

function Page({ report, repeats, screenshot }: { report: ReportData; repeats?: RepeatSet; screenshot: (path: string, alt: string) => ReactNode }) {
  return (
    <main className="mx-auto max-w-5xl space-y-4 px-4 py-6">
      <header>
        <img src={logoUrl} width="130" height="40" alt="Gnomi" className="mb-4" />
        <h1 className="text-lg font-semibold text-stone-900">Gnomi report</h1>
        <p className="break-words text-sm text-stone-500">
          Run {report.run_id} on {report.pois.map((poi) => poi.start_url ?? poi.name).join(', ')}, started {when(report.started_at)}
        </p>
      </header>
      <Report report={report} repeats={repeats} onInspect={() => {}} renderScreenshot={screenshot} />
    </main>
  );
}

/** One HTML file drawn by the report component itself: styles inline, evidence screenshots as small data URLs, no scripts, nothing fetched. */
export async function reportHtml(report: ReportData, thumbnails: (paths: string[]) => Promise<Record<string, string>>, repeats?: RepeatSet): Promise<string> {
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
        <Page report={report} repeats={repeats} screenshot={screenshot} />
      </InFile>,
    );
  draw(); // the first pass only learns which screenshots the report shows, in order
  const paths = [...new Set(shown)];
  const made = await thumbnails(paths);
  let left = IMAGE_BYTES;
  for (const path of paths) {
    const image = made[path];
    // Only embed raster thumbnails. A malformed or external URL must not make an export fetch resources.
    if (!image || !/^data:image\/(?:jpeg|png|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(image)) continue;
    const bytes = image.length * shown.filter((candidate) => candidate === path).length;
    if (bytes > left) continue;
    images.set(path, image);
    left -= bytes;
  }
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:">
<title>${escapeHtml(`Gnomi report: ${report.goal}`)}</title>
<style>${portableCss}
${PRINT}</style>
</head>
<body class="bg-stone-50 text-stone-900 antialiased">${draw()}</body>
</html>
`;
}

/** What goes in the exported file; for PDF that is the HTML main prints. */
export async function reportFile(report: ReportData, format: ReportFormat, thumbnails: (paths: string[]) => Promise<Record<string, string>>, repeats?: RepeatSet): Promise<string> {
  if (format === 'json') return JSON.stringify(report, null, 2);
  if (format === 'md') return reportToMarkdown(report, repeats);
  return reportHtml(report, thumbnails, repeats);
}
