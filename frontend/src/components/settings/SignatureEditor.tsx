"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useEditor, EditorContent, useEditorState, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Image } from "@tiptap/extension-image";
import { TextAlign } from "@tiptap/extension-text-align";
import { TextStyle, Color, FontSize } from "@tiptap/extension-text-style";
import { Table, TableRow, TableCell, TableHeader } from "@tiptap/extension-table";
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Bold,
  Columns2,
  ImagePlus,
  Italic,
  Link as LinkIcon,
  Loader2,
  Palette,
  RemoveFormatting,
  Trash2,
  Underline as UnderlineIcon,
  Unlink,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";

const COLORS = [
  "#111827", "#4b5563", "#9ca3af", "#dc2626", "#ea580c", "#d97706",
  "#16a34a", "#0d9488", "#2563eb", "#4f46e5", "#9333ea", "#db2777",
];

const FONT_SIZES = [
  { value: "12px", key: "signature.sizeSmall" },
  { value: "default", key: "signature.sizeNormal" },
  { value: "16px", key: "signature.sizeLarge" },
  { value: "20px", key: "signature.sizeXLarge" },
];

const IMAGE_WIDTHS = [
  { value: 64, key: "signature.imageSmall" },
  { value: 120, key: "signature.imageMedium" },
  { value: 200, key: "signature.imageLarge" },
];

interface SignatureEditorProps {
  /** HTML initial (relu a chaque changement de `resetKey`). */
  content: string;
  resetKey: string;
  onChange: (html: string) => void;
  /** Enregistre une image et rend son URL publique (null si echec). */
  onUploadImage: (file: File) => Promise<string | null>;
  editorRef?: { current: Editor | null };
}

function ToolButton({
  active,
  disabled,
  onClick,
  title,
  children,
  dataRef,
}: {
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  title: string;
  children: ReactNode;
  dataRef?: string;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className={cn("size-8 shrink-0", active && "bg-accent text-accent-foreground")}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      aria-pressed={active}
      data-ref={dataRef}
    >
      {children}
    </Button>
  );
}

/**
 * Editeur riche d'une signature : gras/italique/souligne, couleur, taille,
 * lien, alignement, image (logo/photo) et grille 2 colonnes (table sans
 * bordure, ex. logo a gauche + coordonnees a droite). Le HTML sorti est
 * converti au format messageries a l'enregistrement (toEmailSignatureHtml).
 */
export function SignatureEditor({ content, resetKey, onChange, onUploadImage, editorRef }: SignatureEditorProps) {
  const t = useT();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkUrl, setLinkUrl] = useState("");
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({
        heading: false,
        code: false,
        codeBlock: false,
        blockquote: false,
        horizontalRule: false,
        link: { openOnClick: false, autolink: true, HTMLAttributes: { rel: "noopener noreferrer" } },
      }),
      TextStyle,
      Color,
      FontSize,
      TextAlign.configure({ types: ["paragraph"] }),
      Image.configure({ inline: false, allowBase64: false }),
      Table.configure({ resizable: false }),
      TableRow,
      TableCell,
      // Requis par le schema de TableRow (tableCell | tableHeader), meme sans
      // ligne d'en-tete : sans lui l'editeur plante au montage.
      TableHeader,
    ],
    content,
    editorProps: {
      attributes: {
        "data-ref": "signature-editor-content",
        class:
          "min-h-40 px-3 py-2 text-base leading-normal outline-none [&_p]:m-0 [&_a]:text-blue-600 [&_a]:underline [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_table]:border-collapse [&_td]:align-top [&_td]:border [&_td]:border-dashed [&_td]:border-muted-foreground/30 [&_td]:p-1.5 [&_img]:block [&_img]:h-auto [&_img]:max-w-full [&_img.ProseMirror-selectednode]:outline-2 [&_img.ProseMirror-selectednode]:outline-primary",
      },
    },
    onUpdate: ({ editor: ed }) => onChangeRef.current(ed.getHTML()),
  });

  // Changement de compte : recharge le contenu sans polluer l'historique.
  useEffect(() => {
    if (!editor) return;
    editor.commands.setContent(content || "", { emitUpdate: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, resetKey]);

  useEffect(() => {
    if (editorRef) editorRef.current = editor;
  }, [editor, editorRef]);

  const state = useEditorState({
    editor,
    selector: ({ editor: ed }) => {
      if (!ed) return null;
      const ts = ed.getAttributes("textStyle") as { color?: string; fontSize?: string };
      return {
        bold: ed.isActive("bold"),
        italic: ed.isActive("italic"),
        underline: ed.isActive("underline"),
        link: ed.isActive("link"),
        alignCenter: ed.isActive({ textAlign: "center" }),
        alignRight: ed.isActive({ textAlign: "right" }),
        inTable: ed.isActive("table"),
        imageSelected: ed.isActive("image"),
        imageWidth: Number(ed.getAttributes("image").width) || 0,
        color: ts.color || "",
        fontSize: ts.fontSize || "default",
      };
    },
  });

  if (!editor || !state) {
    return <div className="bg-muted/40 h-52 animate-pulse rounded-md border" />;
  }

  const chain = () => editor.chain().focus();

  async function handleImage(file: File | undefined) {
    if (!file || !editor) return;
    setUploading(true);
    try {
      const url = await onUploadImage(file);
      if (url) chain().setImage({ src: url, alt: "", width: 120 } as never).run();
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  function applyLink() {
    const url = linkUrl.trim();
    setLinkOpen(false);
    if (!url) {
      chain().extendMarkRange("link").unsetLink().run();
      return;
    }
    const href = /^(https?:|mailto:|tel:)/i.test(url)
      ? url
      : url.includes("@") && !url.includes("/")
        ? `mailto:${url}`
        : `https://${url}`;
    if (editor?.state.selection.empty && !state?.link) {
      chain().insertContent({ type: "text", text: url, marks: [{ type: "link", attrs: { href } }] }).run();
    } else {
      chain().extendMarkRange("link").setLink({ href }).run();
    }
  }

  return (
    <div data-ref="signature-editor" className="border-input overflow-hidden rounded-md border">
      <div className="bg-muted/40 flex flex-wrap items-center gap-0.5 border-b px-1 py-1">
        <ToolButton active={state.bold} onClick={() => chain().toggleBold().run()} title={t("signature.bold")}>
          <Bold className="size-4" />
        </ToolButton>
        <ToolButton active={state.italic} onClick={() => chain().toggleItalic().run()} title={t("signature.italic")}>
          <Italic className="size-4" />
        </ToolButton>
        <ToolButton active={state.underline} onClick={() => chain().toggleUnderline().run()} title={t("signature.underline")}>
          <UnderlineIcon className="size-4" />
        </ToolButton>

        <Popover>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-8 shrink-0"
              title={t("signature.color")}
              aria-label={t("signature.color")}
              onMouseDown={(e) => e.preventDefault()}
              data-ref="signature-color"
            >
              <span className="relative">
                <Palette className="size-4" />
                <span
                  className="absolute -bottom-1 left-0 h-0.5 w-4 rounded"
                  style={{ backgroundColor: state.color || "currentColor" }}
                />
              </span>
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-auto p-2" align="start" onOpenAutoFocus={(e) => e.preventDefault()}>
            <div className="grid grid-cols-6 gap-1.5">
              {COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  className={cn(
                    "size-6 rounded-full border transition-transform hover:scale-110",
                    state.color === c && "ring-primary ring-2 ring-offset-1"
                  )}
                  style={{ backgroundColor: c }}
                  onClick={() => chain().setColor(c).run()}
                  aria-label={c}
                />
              ))}
            </div>
            <div className="mt-2 flex items-center gap-2">
              <input
                type="color"
                value={state.color || "#111827"}
                onChange={(e) => chain().setColor(e.target.value).run()}
                className="size-7 cursor-pointer rounded border bg-transparent p-0"
                aria-label={t("signature.customColor")}
              />
              <Button type="button" variant="ghost" size="sm" className="h-7 text-xs" onClick={() => chain().unsetColor().run()}>
                {t("signature.defaultColor")}
              </Button>
            </div>
          </PopoverContent>
        </Popover>

        <Select
          value={state.fontSize}
          onValueChange={(v) => (v === "default" ? chain().unsetFontSize().run() : chain().setFontSize(v).run())}
        >
          <SelectTrigger size="sm" className="h-8 w-28 border-0 bg-transparent text-xs shadow-none" aria-label={t("signature.size")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {FONT_SIZES.map((s) => (
              <SelectItem key={s.value} value={s.value} className="text-xs">
                {t(s.key)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <span className="bg-border mx-0.5 h-5 w-px" />

        <Popover
          open={linkOpen}
          onOpenChange={(o) => {
            setLinkOpen(o);
            if (o) setLinkUrl((editor.getAttributes("link").href as string) || "");
          }}
        >
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className={cn("size-8 shrink-0", state.link && "bg-accent text-accent-foreground")}
              title={t("signature.link")}
              aria-label={t("signature.link")}
              onMouseDown={(e) => e.preventDefault()}
              data-ref="signature-link"
            >
              <LinkIcon className="size-4" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-72 p-2" align="start">
            <form
              className="flex items-center gap-1.5"
              onSubmit={(e) => {
                e.preventDefault();
                applyLink();
              }}
            >
              <Input
                autoFocus
                value={linkUrl}
                onChange={(e) => setLinkUrl(e.target.value)}
                placeholder={t("signature.linkPlaceholder")}
                className="h-8 text-sm"
              />
              <Button type="submit" size="sm" className="h-8">
                OK
              </Button>
            </form>
          </PopoverContent>
        </Popover>
        {state.link && (
          <ToolButton onClick={() => chain().extendMarkRange("link").unsetLink().run()} title={t("signature.unlink")}>
            <Unlink className="size-4" />
          </ToolButton>
        )}

        <span className="bg-border mx-0.5 h-5 w-px" />

        <ToolButton
          active={!state.alignCenter && !state.alignRight}
          onClick={() => chain().setTextAlign("left").run()}
          title={t("signature.alignLeft")}
        >
          <AlignLeft className="size-4" />
        </ToolButton>
        <ToolButton active={state.alignCenter} onClick={() => chain().setTextAlign("center").run()} title={t("signature.alignCenter")}>
          <AlignCenter className="size-4" />
        </ToolButton>
        <ToolButton active={state.alignRight} onClick={() => chain().setTextAlign("right").run()} title={t("signature.alignRight")}>
          <AlignRight className="size-4" />
        </ToolButton>

        <span className="bg-border mx-0.5 h-5 w-px" />

        <ToolButton
          disabled={uploading}
          onClick={() => fileInputRef.current?.click()}
          title={t("signature.image")}
          dataRef="signature-image"
        >
          {uploading ? <Loader2 className="size-4 animate-spin" /> : <ImagePlus className="size-4" />}
        </ToolButton>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          className="hidden"
          onChange={(e) => void handleImage(e.target.files?.[0])}
        />
        {state.inTable ? (
          <ToolButton onClick={() => chain().deleteTable().run()} title={t("signature.removeGrid")} dataRef="signature-grid-remove">
            <Trash2 className="size-4" />
          </ToolButton>
        ) : (
          <ToolButton
            onClick={() => chain().insertTable({ rows: 1, cols: 2, withHeaderRow: false }).run()}
            title={t("signature.grid")}
            dataRef="signature-grid"
          >
            <Columns2 className="size-4" />
          </ToolButton>
        )}
        <ToolButton onClick={() => chain().unsetAllMarks().unsetTextAlign().run()} title={t("signature.clearFormat")}>
          <RemoveFormatting className="size-4" />
        </ToolButton>
      </div>

      {state.imageSelected && (
        <div className="bg-muted/20 flex flex-wrap items-center gap-1 border-b px-2 py-1 text-xs">
          <span className="text-muted-foreground mr-1">{t("signature.imageSize")}</span>
          {IMAGE_WIDTHS.map((w) => (
            <Button
              key={w.value}
              type="button"
              variant={state.imageWidth === w.value ? "secondary" : "ghost"}
              size="sm"
              className="h-7 text-xs"
              onClick={() => chain().updateAttributes("image", { width: w.value }).run()}
            >
              {t(w.key)}
            </Button>
          ))}
        </div>
      )}

      <EditorContent editor={editor} />
    </div>
  );
}
