import { useEffect, useId, useRef, useState } from 'react';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { TableKit } from '@tiptap/extension-table';
import { Placeholder } from '@tiptap/extensions';
import { Markdown } from '@tiptap/markdown';
import type { TextPoi } from '@gnomi/simulation/types.ts';
import { call, errorText } from '../engine.ts';
import { Button, inputClass, Note } from '../ui.tsx';
import type { PoiFormProps } from './index.ts';

const MAX_BYTES = 2 * 1024 * 1024; // the engine's limit for a text asset (simulation/src/assets.ts), checked here before a big file is read

// Tables stay in: pricing and comparison copy leans on them.
const extensions = [
  StarterKit.configure({ link: { openOnClick: false } }),
  TableKit,
  Markdown,
  Placeholder.configure({ placeholder: 'Paste your email, pricing page, or onboarding copy here…' }),
];

const TOOLS: { label: string; glyph: string; run(editor: Editor): void; node: string; attrs?: object }[] = [
  { label: 'Heading', glyph: 'H', run: (e) => e.chain().focus().toggleHeading({ level: 2 }).run(), node: 'heading', attrs: { level: 2 } },
  { label: 'Bold', glyph: 'B', run: (e) => e.chain().focus().toggleBold().run(), node: 'bold' },
  { label: 'Italic', glyph: 'I', run: (e) => e.chain().focus().toggleItalic().run(), node: 'italic' },
  { label: 'Bulleted list', glyph: '•', run: (e) => e.chain().focus().toggleBulletList().run(), node: 'bulletList' },
  { label: 'Numbered list', glyph: '1.', run: (e) => e.chain().focus().toggleOrderedList().run(), node: 'orderedList' },
  { label: 'Quote', glyph: '“', run: (e) => e.chain().focus().toggleBlockquote().run(), node: 'blockquote' },
];

/** Plain text as paragraphs, its single line breaks kept, so a .txt file is not read as Markdown. */
const plainDoc = (text: string) => ({
  type: 'doc',
  content: text.split(/\r?\n\s*\r?\n/).map((para) => ({
    type: 'paragraph',
    content: para.split(/\r?\n/).flatMap((line, i) => [...(i ? [{ type: 'hardBreak' }] : []), ...(line ? [{ type: 'text', text: line }] : [])]),
  })),
});

/** The saved Markdown, formatted as personas' copy reads. */
function MarkdownView({ markdown }: { markdown: string }) {
  const editor = useEditor(
    { editable: false, injectCSS: false, extensions, content: markdown, contentType: 'markdown', editorProps: { attributes: { 'aria-label': 'Text preview', tabindex: '0', class: 'rich-text rich-text-preview' } } },
    [markdown],
  );
  return <EditorContent editor={editor} />;
}

/** Copy for personas to read: written in a rich text editor, pasted, or a .md or .txt file, stored in the project's assets as Markdown. */
export function TextPoiForm({ draft, onChange }: PoiFormProps<TextPoi>) {
  const [preview, setPreview] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [fileName, setFileName] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const id = useId();
  const editor = useEditor({
    extensions,
    injectCSS: false, // the CSP blocks inline styles; styles.css carries ProseMirror's base rules
    shouldRerenderOnTransaction: true, // the toolbar shows what is active at the cursor
    editorProps: { attributes: { role: 'textbox', 'aria-multiline': 'true', 'aria-labelledby': `${id}-label`, 'aria-describedby': `${id}-hint`, class: `${inputClass} rich-text` } },
  });

  useEffect(() => {
    setPreview(null);
    if (!draft.asset) return;
    let current = true;
    call('get_blob', { path: `assets/${draft.asset}` }).then(
      ({ base64 }) => current && setPreview(new TextDecoder().decode(Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)))),
      (err) => current && setError(errorText(err)),
    );
    return () => {
      current = false;
    };
  }, [draft.asset]);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const { id } = await call('import_asset', { text: editor.getMarkdown(), name: fileName });
      // A file names a POI that has no name yet.
      onChange((was) => ({ ...was, asset: id, name: was.name || (fileName?.replace(/\.md$/i, '') ?? '') }));
      editor.commands.clearContent();
      setFileName(undefined);
      setEditing(false);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const choose = async (chosen: File | undefined) => {
    if (file.current) file.current.value = ''; // choosing the same file again still counts
    if (!chosen) return;
    if (chosen.size > MAX_BYTES) return setError(`"${chosen.name}" is larger than 2 MB.`);
    let content: string;
    try {
      content = new TextDecoder('utf-8', { fatal: true }).decode(await chosen.arrayBuffer());
    } catch {
      return setError(`"${chosen.name}" is not UTF-8 text.`);
    }
    if (!content.trim()) return setError(`"${chosen.name}" is empty.`);
    setError(null);
    if (/\.md$/i.test(chosen.name)) editor.commands.setContent(content, { contentType: 'markdown' });
    else editor.commands.setContent(plainDoc(content));
    setFileName(chosen.name.replace(/\.txt$/i, '.md')); // saved as Markdown either way
  };

  if (draft.asset && !editing) {
    return (
      <div className="space-y-2">
        <p className="text-sm font-medium text-stone-700">The text personas read</p>
        {preview === null ? (
          error ? <Note tone="error">{error}</Note> : <p className="text-sm text-stone-500">Loading the text...</p>
        ) : (
          <MarkdownView markdown={preview} />
        )}
        <div className="flex flex-wrap items-center gap-3">
          {preview !== null && <span className="text-xs text-stone-500">{preview.length.toLocaleString()} characters</span>}
          <Button small onClick={() => { editor.commands.setContent(preview ?? '', { contentType: 'markdown' }); setError(null); setEditing(true); }}>Edit the text</Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="field-control">
        <p id={`${id}-label`} className="mb-1 block text-sm font-medium text-stone-700">Write or paste the text</p>
        <div role="toolbar" aria-label="Formatting" className="rich-text-toolbar">
          {TOOLS.map((tool) => (
            <button key={tool.label} type="button" aria-label={tool.label} title={tool.label} aria-pressed={editor.isActive(tool.node, tool.attrs)} onClick={() => tool.run(editor)}>
              {tool.glyph}
            </button>
          ))}
        </div>
        <EditorContent editor={editor} />
        <p id={`${id}-hint`} className="mt-1 text-xs text-stone-500">Add the words you want feedback on, just as your reader would see them. A .md file keeps its formatting.</p>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button small variant="primary" loading={busy} disabled={editor.isEmpty} onClick={() => void save()}>
          Use this text
        </Button>
        <Button small disabled={busy} onClick={() => file.current?.click()}>
          Choose a .md or .txt file
        </Button>
        <input ref={file} type="file" accept=".md,.txt,text/markdown,text/plain" aria-label="Text file" className="sr-only" tabIndex={-1} onChange={(e) => void choose(e.target.files?.[0])} />
        {editing && (
          <Button small variant="quiet" disabled={busy} onClick={() => { setEditing(false); setError(null); }}>
            Keep the current text
          </Button>
        )}
      </div>
      {error && <Note tone="error">{error}</Note>}
    </div>
  );
}
