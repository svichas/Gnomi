// Report export formats, shared by main and the page. PDF is printed by main from the HTML (tech.md §4.12).
export const REPORT_FORMATS = { html: 'HTML', pdf: 'PDF', md: 'Markdown', json: 'JSON' } as const;

export type ReportFormat = keyof typeof REPORT_FORMATS;
