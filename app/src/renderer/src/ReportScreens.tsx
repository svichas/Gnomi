import type { CSSProperties } from 'react';
import type { Report, ReportBox, ReportPicture, ReportTheme } from '@gnomi/simulation/types.ts';
import { themePoi } from '@gnomi/simulation/report/markdown.ts';
import { screenName } from '@gnomi/simulation/report/screens.ts';
import type { Screen } from '@gnomi/simulation/report/screens.ts';
import type { RenderScreenshot } from './Report.tsx';
import { count, SectionHeading } from './reportParts.tsx';

export const ACROSS_TEXT = 'Across many screens';
export const NONE_TEXT = 'Not tied to one screen';

/** What a screen is called: its page, or for the two groups a theme is not tied to a single page by. */
export const screenTitle = ({ kind, page }: Screen) => (page !== null ? screenName(page) : kind === 'across' ? ACROSS_TEXT : NONE_TEXT);

/** The anchor of a finding's card in a file; the ids of a theme are the engine's, so they are cut down to what an id may hold. */
export const findingId = ({ poi_id, id }: ReportTheme) => `finding-${poi_id}-${id}`.replace(/[^A-Za-z0-9_-]/g, '-');

const list = (numbers: number[]) => (numbers.length < 2 ? numbers.join('') : `${numbers.slice(0, -1).join(', ')} and ${numbers.at(-1)}`);

/** A frame over the element, in percent of the screenshot, so it scales with the image with no script. It shows only beside a loaded image (report.css). */
export function Marked({ box: { left, top, width, height, element }, numbers }: { box: ReportBox; numbers?: number[] }) {
  const label = `Marked${numbers ? ` ${list(numbers)}` : ''} on the screenshot: ${element}`;
  return (
    <span role="img" aria-label={label} title={label} className="report-shot-box" style={{ left: `${left}%`, top: `${top}%`, width: `${width}%`, height: `${height}%` }}>
      {numbers && <b aria-hidden="true">{numbers.join(', ')}</b>}
    </span>
  );
}

/** A screen's lead picture with a numbered frame for each pin. */
export function ScreenPicture({ screen, renderScreenshot }: { screen: Screen; renderScreenshot: RenderScreenshot }) {
  if (!screen.picture) return null;
  const shot = renderScreenshot(screen.picture.screenshot, `The screen ${screenTitle(screen)}, as one persona saw it`);
  return <div className="report-shot">{shot}{screen.pins.map((pin, i) => <Marked key={i} box={pin.box} numbers={pin.numbers} />)}</div>;
}

/** A small picture of the element, or of the whole screenshot when it has no box: positioned and scaled from the percentages by CSS alone. */
export function Crop({ picture, renderScreenshot }: { picture: ReportPicture; renderScreenshot: RenderScreenshot }) {
  const { box } = picture;
  return <span className="report-crop" aria-hidden="true" data-box={box ? '' : undefined} style={box && cropAt(box)}>{renderScreenshot(picture.screenshot, '')}</span>;
}

function cropAt({ left, top, width, height }: ReportBox): CSSProperties {
  const scale = Math.min(8, Math.max(2, 100 / Math.max(width, height)));
  // The frame shows 100/scale % of the image's width, so a centre that far from both edges never shows past them. The height shown
  // depends on the image's shape, which is not known here, so the vertical centre is left as it is.
  const x = Math.min(100 - 50 / scale, Math.max(50 / scale, left + width / 2));
  return { '--s': scale, '--x': `${-x}%`, '--y': `${-(top + height / 2)}%` } as CSSProperties;
}

/** The exported file's view by screen: each lead picture once, and a line per finding that links to its card. */
export function FileScreens({ screens, pois, renderScreenshot }: { screens: Screen[]; pois: Report['pois']; renderScreenshot: RenderScreenshot }) {
  return (
    <section aria-labelledby="screens-title">
      <SectionHeading id="screens-title" title="Findings by screen" hint="The same findings, grouped by the screen they were met on. A number on a picture is the finding it marks." />
      <div className="report-screens">
        {screens.map((screen, i) => (
          <div key={i} className="report-screen">
            <header>
              <h4>{screenTitle(screen)}</h4>
              <p>
                {themePoi(screen.findings[0].theme, pois) && <span>{themePoi(screen.findings[0].theme, pois)}</span>}
                <span>{count(screen.findings.length, 'finding')}</span>
                {screen.reached !== null && <span>{count(screen.reached, 'persona')} reached it</span>}
              </p>
            </header>
            <div className="report-screen-body" data-lead={screen.picture ? '' : undefined}>
              <ScreenPicture screen={screen} renderScreenshot={renderScreenshot} />
              <ol>
                {screen.findings.map(({ theme, picture, pinned }) => (
                  <li key={theme.id}><a href={`#${findingId(theme)}`}>{theme.title}</a>{pinned && picture?.box && <span> (marked: {picture.box.element})</span>}</li>
                ))}
              </ol>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
