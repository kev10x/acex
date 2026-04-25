import React, { useEffect, useMemo } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Underline from '@tiptap/extension-underline';
import Link from '@tiptap/extension-link';
import Placeholder from '@tiptap/extension-placeholder';
import { sanitizeRichTextHtml } from '../utils/richText';

interface RichTextEditorProps {
  value: string;
  placeholder?: string;
  onChange: (html: string) => void;
}

const btnBase = 'rounded px-2 py-1 text-xs border border-gray-200 bg-white hover:bg-gray-100';
const btnActive = 'bg-teal-50 border-teal-300 text-teal-800';

const RichTextEditor: React.FC<RichTextEditorProps> = ({ value, onChange, placeholder }) => {
  const placeholderText = useMemo(() => placeholder || 'Start typing...', [placeholder]);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [2, 3, 4] },
      }),
      Underline,
      Link.configure({
        openOnClick: false,
        autolink: true,
        protocols: ['http', 'https', 'mailto'],
      }),
      Placeholder.configure({
        placeholder: placeholderText,
      }),
    ],
    content: sanitizeRichTextHtml(value),
    editorProps: {
      attributes: {
        class: 'min-h-[160px] px-3 py-2 text-sm leading-relaxed focus:outline-none',
      },
    },
    onUpdate: ({ editor: ed }) => {
      onChange(sanitizeRichTextHtml(ed.getHTML()));
    },
  });

  useEffect(() => {
    if (!editor) return;
    const safe = sanitizeRichTextHtml(value);
    if (editor.getHTML() !== safe) {
      editor.commands.setContent(safe || '<p></p>', false);
    }
  }, [editor, value]);

  const setLink = () => {
    if (!editor) return;
    const previousUrl = editor.getAttributes('link').href || '';
    const url = window.prompt('Enter URL (https://...)', previousUrl);
    if (url === null) return;
    const trimmed = url.trim();
    if (!trimmed) {
      editor.chain().focus().unsetLink().run();
      return;
    }
    editor.chain().focus().setLink({ href: trimmed }).run();
  };

  if (!editor) {
    return <div className="rounded border border-gray-300 bg-white p-3 text-sm text-gray-500">Loading editor...</div>;
  }

  return (
    <div className="rounded border border-gray-300 bg-white">
      <div className="flex flex-wrap items-center gap-1 border-b border-gray-200 bg-gray-50 p-1">
        <button type="button" onClick={() => editor.chain().focus().undo().run()} className={btnBase}>Undo</button>
        <button type="button" onClick={() => editor.chain().focus().redo().run()} className={btnBase}>Redo</button>
        <button type="button" onClick={() => editor.chain().focus().toggleBold().run()} className={`${btnBase} ${editor.isActive('bold') ? btnActive : ''}`}>Bold</button>
        <button type="button" onClick={() => editor.chain().focus().toggleItalic().run()} className={`${btnBase} ${editor.isActive('italic') ? btnActive : ''}`}>Italic</button>
        <button type="button" onClick={() => editor.chain().focus().toggleUnderline().run()} className={`${btnBase} ${editor.isActive('underline') ? btnActive : ''}`}>Underline</button>
        <button type="button" onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()} className={`${btnBase} ${editor.isActive('heading', { level: 3 }) ? btnActive : ''}`}>H3</button>
        <button type="button" onClick={() => editor.chain().focus().setParagraph().run()} className={`${btnBase} ${editor.isActive('paragraph') ? btnActive : ''}`}>Paragraph</button>
        <button type="button" onClick={() => editor.chain().focus().toggleBulletList().run()} className={`${btnBase} ${editor.isActive('bulletList') ? btnActive : ''}`}>Bullets</button>
        <button type="button" onClick={() => editor.chain().focus().toggleOrderedList().run()} className={`${btnBase} ${editor.isActive('orderedList') ? btnActive : ''}`}>Numbers</button>
        <button type="button" onClick={() => editor.chain().focus().toggleBlockquote().run()} className={`${btnBase} ${editor.isActive('blockquote') ? btnActive : ''}`}>Quote</button>
        <button type="button" onClick={() => editor.chain().focus().toggleCodeBlock().run()} className={`${btnBase} ${editor.isActive('codeBlock') ? btnActive : ''}`}>Code</button>
        <button type="button" onClick={setLink} className={`${btnBase} ${editor.isActive('link') ? btnActive : ''}`}>Link</button>
      </div>
      <EditorContent editor={editor} />
    </div>
  );
};

export default RichTextEditor;
