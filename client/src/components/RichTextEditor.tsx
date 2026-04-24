import React, { useEffect, useMemo, useRef } from 'react';
import { sanitizeRichTextHtml } from '../utils/richText';

interface RichTextEditorProps {
  value: string;
  placeholder?: string;
  onChange: (html: string) => void;
}

type EditorCommand = 'bold' | 'italic' | 'underline' | 'insertUnorderedList' | 'insertOrderedList';

const RichTextEditor: React.FC<RichTextEditorProps> = ({ value, onChange, placeholder }) => {
  const editorRef = useRef<HTMLDivElement>(null);
  const placeholderText = useMemo(() => placeholder || 'Start typing...', [placeholder]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const safeValue = sanitizeRichTextHtml(value);
    if (editor.innerHTML !== safeValue) {
      editor.innerHTML = safeValue;
    }
  }, [value]);

  const emitChange = () => {
    const editor = editorRef.current;
    if (!editor) return;
    onChange(sanitizeRichTextHtml(editor.innerHTML));
  };

  const runCommand = (command: EditorCommand) => {
    editorRef.current?.focus();
    document.execCommand(command, false);
    emitChange();
  };

  const setBlock = (block: 'P' | 'H3' | 'H4') => {
    editorRef.current?.focus();
    document.execCommand('formatBlock', false, block);
    emitChange();
  };

  const addLink = () => {
    const url = window.prompt('Enter URL (https://...)');
    if (!url) return;
    editorRef.current?.focus();
    document.execCommand('createLink', false, url.trim());
    emitChange();
  };

  return (
    <div className="rounded border border-gray-300 bg-white">
      <div className="flex flex-wrap items-center gap-1 border-b border-gray-200 bg-gray-50 p-1">
        <button type="button" onClick={() => runCommand('bold')} className="rounded px-2 py-1 text-xs hover:bg-gray-200">
          Bold
        </button>
        <button type="button" onClick={() => runCommand('italic')} className="rounded px-2 py-1 text-xs hover:bg-gray-200">
          Italic
        </button>
        <button type="button" onClick={() => runCommand('underline')} className="rounded px-2 py-1 text-xs hover:bg-gray-200">
          Underline
        </button>
        <button type="button" onClick={() => setBlock('H3')} className="rounded px-2 py-1 text-xs hover:bg-gray-200">
          H3
        </button>
        <button type="button" onClick={() => setBlock('P')} className="rounded px-2 py-1 text-xs hover:bg-gray-200">
          Paragraph
        </button>
        <button type="button" onClick={() => runCommand('insertUnorderedList')} className="rounded px-2 py-1 text-xs hover:bg-gray-200">
          Bullets
        </button>
        <button type="button" onClick={() => runCommand('insertOrderedList')} className="rounded px-2 py-1 text-xs hover:bg-gray-200">
          Numbers
        </button>
        <button type="button" onClick={addLink} className="rounded px-2 py-1 text-xs hover:bg-gray-200">
          Link
        </button>
      </div>
      <div
        ref={editorRef}
        contentEditable
        suppressContentEditableWarning
        onInput={emitChange}
        className="min-h-[140px] w-full px-3 py-2 text-sm leading-relaxed focus:outline-none"
        data-placeholder={placeholderText}
      />
    </div>
  );
};

export default RichTextEditor;
