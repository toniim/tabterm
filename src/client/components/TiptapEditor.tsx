import { useEffect, useRef } from "react";
import { useEditor, EditorContent, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import { Markdown } from "tiptap-markdown";
import {
  Bold,
  Italic,
  Code,
  Heading1,
  Heading2,
  List,
  ListOrdered,
  Quote,
  SquareCode,
} from "lucide-react";

// Controlled markdown editor. `content` is the canonical markdown string; the
// editor parses it on mount and emits markdown back through `onChange`. While
// the user is typing we ignore inbound `content` changes so a remote broadcast
// can't clobber their caret (mirrors the focus-aware textarea pattern the old
// NotesPanel used).
//
// `editorRef` (optional) lets the parent grab the underlying editor — used by
// NotesPanel to force a blur when the user clicks a different note in the list
// (so the focused-guard below releases and the new content is loaded).
const getMarkdown = (e: Editor): string =>
  (e.storage as unknown as { markdown: { getMarkdown(): string } }).markdown.getMarkdown();

export function TiptapEditor({
  content,
  version,
  onChange,
  onContentLoaded,
  placeholder,
  editorRef,
}: {
  content: string;
  // Authoritative version of `content`, reported back via onContentLoaded when
  // the editor passively (re)loads it (i.e. the user isn't the one typing).
  version: number;
  onChange: (markdown: string) => void;
  // Fired when authoritative content is loaded into the editor while not typing,
  // so the panel can re-anchor its optimistic base version to the server's.
  onContentLoaded?: (version: number) => void;
  placeholder?: string;
  editorRef?: { current: Editor | null };
}) {
  const focused = useRef(false);

  const editor = useEditor({
    extensions: [
      StarterKit,
      Markdown.configure({ html: false, linkify: true, breaks: false }),
      Placeholder.configure({ placeholder: placeholder ?? "" }),
    ],
    content,
    onUpdate: ({ editor }) => {
      onChange(getMarkdown(editor));
    },
    onFocus: () => {
      focused.current = true;
    },
    onBlur: () => {
      focused.current = false;
    },
    immediatelyRender: false,
  });

  useEffect(() => {
    if (editorRef) editorRef.current = editor;
  }, [editor, editorRef]);

  // Reflect external content changes (session switch, remote edit) into the
  // editor, but only when the user isn't typing. When we passively adopt
  // authoritative content we report its version so the panel re-anchors its
  // base; while typing we leave both buffer and base alone.
  useEffect(() => {
    if (!editor) return;
    if (focused.current) return;
    if (getMarkdown(editor) !== content) {
      editor.commands.setContent(content, { emitUpdate: false });
    }
    onContentLoaded?.(version);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content, version, editor]);

  return (
    <div className="flex flex-col h-full min-h-0">
      <Toolbar editor={editor} />
      <EditorContent
        editor={editor}
        className="flex-1 overflow-y-auto px-3 py-2 text-sm text-[var(--text)] [&_.ProseMirror]:outline-none [&_.ProseMirror]:min-h-full [&_.ProseMirror_p.is-editor-empty:first-child::before]:content-[attr(data-placeholder)] [&_.ProseMirror_p.is-editor-empty:first-child::before]:text-[var(--faint)] [&_.ProseMirror_p.is-editor-empty:first-child::before]:float-left [&_.ProseMirror_p.is-editor-empty:first-child::before]:h-0 [&_.ProseMirror_p.is-editor-empty:first-child::before]:pointer-events-none [&_.ProseMirror_h1]:text-xl [&_.ProseMirror_h1]:font-semibold [&_.ProseMirror_h1]:mt-3 [&_.ProseMirror_h1]:mb-1 [&_.ProseMirror_h2]:text-base [&_.ProseMirror_h2]:font-semibold [&_.ProseMirror_h2]:mt-2 [&_.ProseMirror_h2]:mb-1 [&_.ProseMirror_ul]:list-disc [&_.ProseMirror_ul]:pl-5 [&_.ProseMirror_ol]:list-decimal [&_.ProseMirror_ol]:pl-5 [&_.ProseMirror_blockquote]:border-l-2 [&_.ProseMirror_blockquote]:border-[var(--border-2)] [&_.ProseMirror_blockquote]:pl-3 [&_.ProseMirror_blockquote]:text-[var(--muted)] [&_.ProseMirror_code]:bg-[var(--hover)] [&_.ProseMirror_code]:px-1 [&_.ProseMirror_code]:rounded [&_.ProseMirror_pre]:bg-[var(--bg)] [&_.ProseMirror_pre]:p-2 [&_.ProseMirror_pre]:rounded [&_.ProseMirror_pre]:text-xs"
      />
    </div>
  );
}

function Toolbar({ editor }: { editor: Editor | null }) {
  if (!editor) return <div className="h-9 border-b border-[var(--border)]" />;

  const btn = (active: boolean, onClick: () => void, title: string, icon: React.ReactNode) => (
    <button
      type="button"
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      title={title}
      className={`p-1.5 rounded hover:bg-[var(--hover)] ${
        active ? "text-[var(--text)] bg-[var(--hover)]" : "text-[var(--muted)]"
      }`}
    >
      {icon}
    </button>
  );

  return (
    <div className="flex items-center gap-0.5 px-2 h-9 border-b border-[var(--border)] shrink-0">
      {btn(
        editor.isActive("bold"),
        () => editor.chain().focus().toggleBold().run(),
        "Bold",
        <Bold size={14} />,
      )}
      {btn(
        editor.isActive("italic"),
        () => editor.chain().focus().toggleItalic().run(),
        "Italic",
        <Italic size={14} />,
      )}
      {btn(
        editor.isActive("code"),
        () => editor.chain().focus().toggleCode().run(),
        "Inline code",
        <Code size={14} />,
      )}
      <span className="w-px h-4 bg-[var(--border)] mx-1" />
      {btn(
        editor.isActive("heading", { level: 1 }),
        () => editor.chain().focus().toggleHeading({ level: 1 }).run(),
        "Heading 1",
        <Heading1 size={14} />,
      )}
      {btn(
        editor.isActive("heading", { level: 2 }),
        () => editor.chain().focus().toggleHeading({ level: 2 }).run(),
        "Heading 2",
        <Heading2 size={14} />,
      )}
      <span className="w-px h-4 bg-[var(--border)] mx-1" />
      {btn(
        editor.isActive("bulletList"),
        () => editor.chain().focus().toggleBulletList().run(),
        "Bullet list",
        <List size={14} />,
      )}
      {btn(
        editor.isActive("orderedList"),
        () => editor.chain().focus().toggleOrderedList().run(),
        "Numbered list",
        <ListOrdered size={14} />,
      )}
      <span className="w-px h-4 bg-[var(--border)] mx-1" />
      {btn(
        editor.isActive("blockquote"),
        () => editor.chain().focus().toggleBlockquote().run(),
        "Blockquote",
        <Quote size={14} />,
      )}
      {btn(
        editor.isActive("codeBlock"),
        () => editor.chain().focus().toggleCodeBlock().run(),
        "Code block",
        <SquareCode size={14} />,
      )}
    </div>
  );
}
