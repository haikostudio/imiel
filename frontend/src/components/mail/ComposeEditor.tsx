"use client";

import { createPortal } from "react-dom";
import { useCallback, useEffect, useRef, useState, type ChangeEvent, type ClipboardEvent as ReactClipboardEvent, type DragEvent as ReactDragEvent, type MutableRefObject, type ReactNode } from "react";
import { useEditor, EditorContent, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import Placeholder from "@tiptap/extension-placeholder";
import { BubbleMenu } from "@tiptap/react/menus";
import type { EditorView } from "@tiptap/pm/view";
import { toast } from "sonner";
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Bold,
  ImagePlus,
  Italic,
  Paperclip,
  Underline as UnderlineIcon,
  Languages,
  Trash2,
  Link as LinkIcon,
  List,
  ListOrdered,
  Loader2,
  Sparkles,
  SpellCheck,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";
import { Toggle } from "@/components/ui/toggle";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { DOMSerializer } from "@tiptap/pm/model";
import { InlineImage } from "./inline-image-extension";
import { compressImage, formatBytes, isHeavyImage } from "@/lib/image-compress";
import type { InlineImageAlign, InlineImageSize } from "@/lib/inline-images";

export type { Editor };

interface ComposeEditorProps {
  content?: string;
  placeholder?: string;
  onChange?: (html: string) => void;
  onFileDrop?: (files: File[]) => void;
  /**
   * Enregistre une image placee dans le texte (piece jointe "integree") et
   * rend son adresse definitive, ou null en cas d'echec. Sans ce rappel, les
   * images restent des pieces jointes classiques.
   */
  onUploadImage?: (file: File) => Promise<string | null>;
  className?: string;
  editorRef?: MutableRefObject<Editor | null>;
  correctionContent?: ReactNode;
  correctionBar?: ReactNode;
  onCorrect?: () => void;
  correcting?: boolean;
  correctDisabled?: boolean;
  correctLabel?: string;
  onAiCorrect?: () => void;
  aiCorrecting?: boolean;
  aiCorrectDisabled?: boolean;
  aiCorrectLabel?: string;
  /**
   * Traduit un fragment HTML vers la langue cible et rend le HTML traduit
   * (leve en cas d'echec). Present = bouton "Traduire" affiche.
   */
  onTranslate?: (html: string, target: TranslateTarget) => Promise<string>;
  translateDisabled?: boolean;
  /**
   * Noeud ou rendre la barre de mise en forme (portail React) : la bande
   * d'en-tete repliable de la fenetre de redaction la sort ainsi de la zone qui
   * defile. Absent = barre rendue en haut du cadre de l'editeur (historique).
   * L'etat, les menus et les rappels restent ceux de cet editeur.
   */
  toolbarHost?: HTMLElement | null;
  /** Appele quand le texte prend le focus (repli de la bande d'en-tete). */
  onEditorFocus?: () => void;
  /**
   * Reponse redigee par l'agent : present = petit bouton en bas a droite du
   * champ (reponses seulement). Pendant `aiReplyBusy`, le texte est fige.
   */
  onAiReply?: () => void;
  aiReplyBusy?: boolean;
  aiReplyDisabled?: boolean;
  aiReplyLabel?: string;
  /**
   * Fenetre de redaction en "carte" : pas de cadre ni de barre en haut ; une
   * rangee en bas (rendue dans `toolbarHost`) porte "B" (mise en forme dans
   * une petite barre flottante), le trombone (fichier joint ou image dans le
   * texte) et, a droite, `toolbarEnd` (menu IA de la fenetre).
   */
  compactToolbar?: boolean;
  /** Trombone > "Joindre un fichier" (rangee compacte). */
  onAttachFiles?: () => void;
  toolbarEnd?: ReactNode;
}

export type TranslateTarget = "en" | "de" | "es";
const TRANSLATE_TARGETS: TranslateTarget[] = ["en", "de", "es"];

export function ComposeEditor({
  content = "",
  placeholder,
  onChange,
  onFileDrop,
  onUploadImage,
  className,
  editorRef,
  correctionContent,
  correctionBar,
  onCorrect,
  correcting,
  correctDisabled,
  correctLabel,
  onAiCorrect,
  aiCorrecting,
  aiCorrectDisabled,
  aiCorrectLabel,
  onTranslate,
  translateDisabled,
  toolbarHost,
  onEditorFocus,
  onAiReply,
  aiReplyBusy,
  aiReplyDisabled,
  aiReplyLabel,
  compactToolbar,
  onAttachFiles,
  toolbarEnd,
}: ComposeEditorProps) {
  const t = useT();
  const resolvedPlaceholder = placeholder ?? t("compose.writePlaceholder");
  const [isDragOver, setIsDragOver] = useState(false);
  const dragCounterRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Proposition d'allegement en attente (une image lourde a la fois).
  const [compressAsk, setCompressAsk] = useState<{ file: File; resolve: (lighten: boolean) => void } | null>(null);
  // Les gestionnaires ProseMirror sont figes a la creation de l'editeur : ils
  // passent par des refs pour voir les rappels a jour.
  const insertImagesRef = useRef<(files: File[], pos?: number) => void>(() => {});
  const onFileDropRef = useRef(onFileDrop);
  onFileDropRef.current = onFileDrop;
  const imagesEnabled = !!onUploadImage;
  const imagesEnabledRef = useRef(imagesEnabled);
  imagesEnabledRef.current = imagesEnabled;
  const droppedByEditorRef = useRef(false);
  const [translating, setTranslating] = useState(false);
  // Selection figee a l'ouverture du menu : le menu vole le focus.
  const translateRangeRef = useRef<{ from: number; to: number } | null>(null);
  const onEditorFocusRef = useRef(onEditorFocus);
  onEditorFocusRef.current = onEditorFocus;
  const [formatOpen, setFormatOpen] = useState(false);
  const [attachOpen, setAttachOpen] = useState(false);

  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({
        link: false,
        bulletList: { keepMarks: true },
        orderedList: { keepMarks: true },
      }),
      Link.configure({
        openOnClick: false,
        HTMLAttributes: { class: "text-primary underline" },
      }),
      Placeholder.configure({ placeholder: resolvedPlaceholder }),
      InlineImage,
    ],
    // La signature vit hors de l'editeur (ComposeSignature, lib/signature.ts).
    content,
    onFocus: () => onEditorFocusRef.current?.(),
    editorProps: {
      attributes: {
        class:
          "prose prose-sm dark:prose-invert max-w-none px-3 py-2 text-base leading-relaxed outline-none focus:outline-none [&_img]:my-2 [&_img]:cursor-pointer [&_img]:rounded-sm [&_img.ProseMirror-selectednode]:outline-2 [&_img.ProseMirror-selectednode]:outline-primary",
      },
      // Coller une image : elle se place dans le texte (jamais le mot
      // "[image]" ni une piece jointe seule). Les autres fichiers gardent le
      // comportement historique (piece jointe).
      handlePaste: (_view: EditorView, event: ClipboardEvent) => {
        const files = Array.from(event.clipboardData?.files ?? []);
        if (!files.length) return false;
        event.preventDefault();
        const images = imagesEnabledRef.current ? files.filter((f) => f.type.startsWith("image/")) : [];
        const others = files.filter((f) => !images.includes(f));
        if (images.length) insertImagesRef.current(images);
        if (others.length) onFileDropRef.current?.(others);
        return true;
      },
      handleDrop: (view: EditorView, event: DragEvent, _slice: unknown, moved: boolean) => {
        if (moved) return false;
        const files = Array.from(event.dataTransfer?.files ?? []);
        if (!files.length) return false;
        event.preventDefault();
        droppedByEditorRef.current = true;
        const images = imagesEnabledRef.current ? files.filter((f) => f.type.startsWith("image/")) : [];
        const others = files.filter((f) => !images.includes(f));
        const pos = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
        if (images.length) insertImagesRef.current(images, pos);
        if (others.length) onFileDropRef.current?.(others);
        return true;
      },
    },
    onUpdate: ({ editor: ed }) => {
      onChange?.(ed.getHTML());
    },
  });

  const hasFiles = (dt: DataTransfer | null) =>
    dt ? Array.from(dt.types).includes("Files") : false;

  const handleDragEnter = useCallback((e: ReactDragEvent) => {
    if (!hasFiles(e.dataTransfer)) return;
    e.preventDefault();
    dragCounterRef.current++;
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: ReactDragEvent) => {
    if (!hasFiles(e.dataTransfer)) return;
    e.preventDefault();
    dragCounterRef.current--;
    if (dragCounterRef.current <= 0) {
      dragCounterRef.current = 0;
      setIsDragOver(false);
    }
  }, []);

  const handleDragOver = useCallback((e: ReactDragEvent) => {
    if (!hasFiles(e.dataTransfer)) return;
    e.preventDefault();
    e.dataTransfer!.dropEffect = "copy";
  }, []);

  const handleDrop = useCallback((e: ReactDragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current = 0;
    setIsDragOver(false);
    // Deja traite par l'editeur (depot dans la zone de texte).
    if (droppedByEditorRef.current) {
      droppedByEditorRef.current = false;
      return;
    }
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (!files.length) return;
    const images = imagesEnabled ? files.filter((f) => f.type.startsWith("image/")) : [];
    const others = files.filter((f) => !images.includes(f));
    if (images.length) insertImagesRef.current(images);
    if (others.length) onFileDrop?.(others);
  }, [onFileDrop, imagesEnabled]);

  const handlePaste = useCallback((e: ReactClipboardEvent) => {
    // Le collage dans la zone de texte est traite par l'editeur (handlePaste).
    if (e.defaultPrevented) return;
    const files = e.clipboardData?.files;
    if (files?.length && onFileDrop) {
      e.preventDefault();
      onFileDrop(Array.from(files));
    }
  }, [onFileDrop]);

  const askCompress = useCallback(
    (file: File) => new Promise<boolean>((resolve) => setCompressAsk({ file, resolve })),
    [],
  );

  // Place les images dans le texte : apercu immediat (adresse locale), puis
  // adresse definitive une fois le fichier enregistre comme piece jointe.
  insertImagesRef.current = (files: File[], pos?: number) => {
    if (!editor || !onUploadImage) return;
    void (async () => {
      let at = pos;
      for (const original of files) {
        let file = original;
        if (isHeavyImage(original) && (await askCompress(original))) {
          file = await compressImage(original);
        }
        const uploadId = crypto.randomUUID();
        const localUrl = URL.createObjectURL(file);
        const node = {
          type: "image",
          attrs: { src: localUrl, alt: file.name, size: "medium", align: "left", uploadId },
        };
        const chain = editor.chain().focus();
        if (typeof at === "number") chain.insertContentAt(at, node);
        else chain.insertContent(node);
        chain.run();
        at = undefined;
        const finalUrl = await onUploadImage(file);
        let found = false;
        editor.state.doc.descendants((n, p) => {
          if (found || n.type.name !== "image" || n.attrs.uploadId !== uploadId) return !found;
          found = true;
          const tr = editor.state.tr;
          if (finalUrl) tr.setNodeMarkup(p, undefined, { ...n.attrs, src: finalUrl, uploadId: null });
          else tr.delete(p, p + n.nodeSize);
          editor.view.dispatch(tr);
          return false;
        });
        if (!finalUrl) toast.error(t("editor.imageUploadFailed"));
        // L'apercu local reste affiche le temps que l'image servie charge.
        setTimeout(() => URL.revokeObjectURL(localUrl), 60_000);
      }
    })();
  };

  const handlePickImages = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []).filter((f) => f.type.startsWith("image/"));
    e.target.value = "";
    if (files.length) insertImagesRef.current(files);
  }, []);

  const setImageAttrs = useCallback(
    (attrs: { size?: InlineImageSize; align?: InlineImageAlign }) => {
      editor?.chain().focus().updateAttributes("image", attrs).run();
    },
    [editor],
  );

  useEffect(() => {
    if (editorRef) editorRef.current = editor ?? null;
  }, [editor, editorRef]);

  const setLink = useCallback(() => {
    if (!editor) return;

    const previousUrl = editor.getAttributes("link").href;
    const url = window.prompt(t("editor.linkUrl"), previousUrl ?? "https://");

    if (url === null) return;

    if (url === "") {
      editor.chain().focus().extendMarkRange("link").unsetLink().run();
      return;
    }

    editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
  }, [editor, t]);

  const handleTranslate = async (target: TranslateTarget) => {
    if (!editor || !onTranslate || translating) return;
    const doc = editor.state.doc;
    const saved = translateRangeRef.current;
    // Sans selection : tout le corps (la citation et la signature vivent hors
    // de l'editeur dans ComposeDialog).
    const whole = !saved || saved.from === saved.to;
    const from = whole ? 0 : Math.max(0, Math.min(saved.from, doc.content.size));
    const to = whole ? doc.content.size : Math.max(from, Math.min(saved.to, doc.content.size));
    const slice = doc.slice(from, to);
    if (!slice.content.textBetween(0, slice.content.size, " ").trim()) return;
    const container = document.createElement("div");
    container.appendChild(DOMSerializer.fromSchema(editor.schema).serializeFragment(slice.content));
    const html = container.innerHTML;
    setTranslating(true);
    try {
      const translated = await onTranslate(html, target);
      if (editor.isDestroyed || !translated.trim()) return;
      // Un seul pas d'historique : Ctrl/Cmd+Z rend le texte d'origine.
      editor.chain().focus().insertContentAt({ from, to: Math.min(to, editor.state.doc.content.size) }, translated).run();
    } catch {
      toast.error(t("compose.translateError"));
    } finally {
      setTranslating(false);
      translateRangeRef.current = null;
    }
  };

  // Texte fige pendant que l'agent redige (rien ne se tape par-dessus).
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    editor.setEditable(!aiReplyBusy);
  }, [editor, aiReplyBusy]);

  if (!editor) {
    return (
      <div data-ref="compose-editor" className={cn(!compactToolbar && "border-input rounded-md border", className)}>
        {!toolbarHost && !compactToolbar && (
          <div className="flex items-center gap-0.5 border-b px-1 py-1">
            <div className="h-8" />
          </div>
        )}
        <div className="min-h-[120px] px-3 py-2">
          <span className="text-muted-foreground text-sm">{resolvedPlaceholder}</span>
        </div>
      </div>
    );
  }

  const isReviewing = !!correctionContent;

  // Rangee du bas de la carte (fenetre de redaction) : "B" ouvre la mise en
  // forme dans une barre flottante, le trombone propose fichier ou image, et
  // `toolbarEnd` (menu IA) se range a droite. Les boutons ne prennent pas le
  // focus (mousedown annule) : la selection du texte reste en place.
  const keepFocus = (e: { preventDefault: () => void }) => e.preventDefault();
  const formatButtons: { key: string; label: string; Icon: typeof Bold; active: boolean; run: () => void }[] = [
    { key: "bold", label: t("editor.bold"), Icon: Bold, active: editor.isActive("bold"), run: () => editor.chain().focus().toggleBold().run() },
    { key: "italic", label: t("editor.italic"), Icon: Italic, active: editor.isActive("italic"), run: () => editor.chain().focus().toggleItalic().run() },
    { key: "underline", label: t("editor.underline"), Icon: UnderlineIcon, active: editor.isActive("underline"), run: () => editor.chain().focus().toggleUnderline().run() },
    { key: "bullet-list", label: t("editor.bulletList"), Icon: List, active: editor.isActive("bulletList"), run: () => editor.chain().focus().toggleBulletList().run() },
    { key: "ordered-list", label: t("editor.numberedList"), Icon: ListOrdered, active: editor.isActive("orderedList"), run: () => editor.chain().focus().toggleOrderedList().run() },
    { key: "link", label: t("editor.link"), Icon: LinkIcon, active: editor.isActive("link"), run: () => { setFormatOpen(false); setLink(); } },
  ];
  const squareBtn =
    "inline-flex size-10 shrink-0 items-center justify-center rounded-xl border border-border bg-background text-foreground shadow-xs transition-colors hover:bg-accent disabled:pointer-events-none disabled:opacity-40 data-[state=open]:bg-muted";
  const compactRow = (
    <div
      data-ref="compose-editor-toolbar"
      className={cn("flex items-center gap-2", isReviewing && "opacity-50 pointer-events-none")}
    >
      <Popover open={formatOpen} onOpenChange={setFormatOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className={squareBtn}
            onMouseDown={keepFocus}
            aria-label={t("compose.formatting")}
            title={t("compose.formatting")}
            data-ref="compose-editor-format"
          >
            <Bold className="size-[1.15rem]" strokeWidth={2.2} />
          </button>
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="start"
          sideOffset={8}
          onOpenAutoFocus={(e) => e.preventDefault()}
          onCloseAutoFocus={(e) => e.preventDefault()}
          className="z-[100] flex w-auto items-center gap-0.5 rounded-2xl p-1.5"
          data-ref="compose-editor-format-bar"
        >
          {formatButtons.map(({ key, label, Icon, active, run }, i) => (
            <span key={key} className="flex items-center">
              {i > 0 && <span className="bg-border mx-0.5 h-5 w-px" aria-hidden />}
              <button
                type="button"
                onMouseDown={keepFocus}
                onClick={run}
                aria-label={label}
                title={label}
                aria-pressed={active}
                data-ref={`compose-editor-${key}`}
                className={cn(
                  "inline-flex size-9 items-center justify-center rounded-xl transition-colors hover:bg-accent",
                  active && "bg-muted text-foreground"
                )}
              >
                <Icon className="size-4" />
              </button>
            </span>
          ))}
        </PopoverContent>
      </Popover>

      <Popover open={attachOpen} onOpenChange={setAttachOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className={squareBtn}
            onMouseDown={keepFocus}
            aria-label={t("compose.attach")}
            title={t("compose.attach")}
            data-ref="compose-form-attach"
          >
            <Paperclip className="size-[1.15rem]" />
          </button>
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="start"
          sideOffset={8}
          onCloseAutoFocus={(e) => e.preventDefault()}
          className="z-[100] w-56 rounded-2xl p-1.5"
          data-ref="compose-attach-menu"
        >
          <button
            type="button"
            onClick={() => { setAttachOpen(false); onAttachFiles?.(); }}
            className="hover:bg-accent flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm"
            data-ref="compose-attach-file"
          >
            <Paperclip className="size-4 shrink-0" />
            {t("compose.attachFile")}
          </button>
          {imagesEnabled && (
            <button
              type="button"
              onClick={() => { setAttachOpen(false); fileInputRef.current?.click(); }}
              className="hover:bg-accent flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm"
              data-ref="compose-editor-insert-image"
            >
              <ImagePlus className="size-4 shrink-0" />
              {t("compose.attachInlineImage")}
            </button>
          )}
        </PopoverContent>
      </Popover>
      {imagesEnabled && (
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={handlePickImages}
          data-ref="compose-editor-image-input"
        />
      )}

      <div className="ml-auto flex items-center gap-2">{toolbarEnd}</div>
    </div>
  );

  // Barre de mise en forme : rendue dans le cadre, ou dans `toolbarHost`.
  const toolbar = (
    <div
      data-ref="compose-editor-toolbar"
      className={cn(
        "flex items-center gap-0.5 px-1 py-1",
        toolbarHost ? "border-input rounded-md border" : "border-b",
        isReviewing && "opacity-50 pointer-events-none",
      )}
    >
      <Toggle
        size="sm"
        pressed={editor.isActive("bold")}
        onPressedChange={() => editor.chain().focus().toggleBold().run()}
        aria-label={t("editor.bold")}
        data-ref="compose-editor-bold"
      >
        <Bold className="size-4" />
      </Toggle>
      <Toggle
        size="sm"
        pressed={editor.isActive("italic")}
        onPressedChange={() => editor.chain().focus().toggleItalic().run()}
        aria-label={t("editor.italic")}
        data-ref="compose-editor-italic"
      >
        <Italic className="size-4" />
      </Toggle>

      <Separator orientation="vertical" className="mx-1 h-6" />

      <Toggle
        size="sm"
        pressed={editor.isActive("link")}
        onPressedChange={setLink}
        aria-label={t("editor.link")}
        data-ref="compose-editor-link"
      >
        <LinkIcon className="size-4" />
      </Toggle>

      <Separator orientation="vertical" className="mx-1 h-6" />

      <Toggle
        size="sm"
        pressed={editor.isActive("bulletList")}
        onPressedChange={() =>
          editor.chain().focus().toggleBulletList().run()
        }
        aria-label={t("editor.bulletList")}
        data-ref="compose-editor-bullet-list"
      >
        <List className="size-4" />
      </Toggle>
      <Toggle
        size="sm"
        pressed={editor.isActive("orderedList")}
        onPressedChange={() =>
          editor.chain().focus().toggleOrderedList().run()
        }
        aria-label={t("editor.numberedList")}
        data-ref="compose-editor-ordered-list"
      >
        <ListOrdered className="size-4" />
      </Toggle>

      {imagesEnabled && (
        <>
          <Separator orientation="vertical" className="mx-1 h-6" />
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={() => fileInputRef.current?.click()}
                aria-label={t("editor.insertImage")}
                data-ref="compose-editor-insert-image"
              >
                <ImagePlus className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("editor.insertImage")}</TooltipContent>
          </Tooltip>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={handlePickImages}
            data-ref="compose-editor-image-input"
          />
        </>
      )}

      {onTranslate && (
        <DropdownMenu
          onOpenChange={(open) => {
            if (open) {
              const { from, to } = editor.state.selection;
              translateRangeRef.current = { from, to };
            }
          }}
        >
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="text-muted-foreground hover:text-foreground ml-auto shrink-0"
                  disabled={translateDisabled || translating}
                  data-ref="compose-editor-translate"
                  aria-label={t("compose.translate")}
                  onMouseDown={(e) => e.preventDefault()}
                >
                  {translating ? <Loader2 className="size-4 animate-spin" /> : <Languages className="size-4" />}
                </Button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent>{t("compose.translate")}</TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="end" className="z-[100]" data-ref="compose-editor-translate-menu">
            {TRANSLATE_TARGETS.map((lang) => (
              <DropdownMenuItem
                key={lang}
                data-ref={`compose-editor-translate-${lang}`}
                onSelect={() => { void handleTranslate(lang); }}
              >
                {t(`compose.translate.${lang}`)}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      {onAiCorrect && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className={cn("text-muted-foreground hover:text-foreground shrink-0", !onTranslate && "ml-auto")}
              onClick={onAiCorrect}
              disabled={aiCorrectDisabled}
              data-ref="compose-editor-ai-correct"
              aria-label={aiCorrectLabel}
            >
              {aiCorrecting ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
            </Button>
          </TooltipTrigger>
          {aiCorrectLabel && <TooltipContent>{aiCorrectLabel}</TooltipContent>}
        </Tooltip>
      )}

      {onCorrect && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className={cn("text-muted-foreground hover:text-foreground shrink-0", !onAiCorrect && !onTranslate && "ml-auto")}
              onClick={onCorrect}
              disabled={correctDisabled}
              data-ref="compose-editor-correct"
              aria-label={correctLabel}
            >
              {correcting ? <Loader2 className="size-4 animate-spin" /> : <SpellCheck className="size-4" />}
            </Button>
          </TooltipTrigger>
          {correctLabel && <TooltipContent>{correctLabel}</TooltipContent>}
        </Tooltip>
      )}
    </div>
  );

  return (
    <div
      data-ref="compose-editor"
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      onPaste={handlePaste}
      className={cn(
        "relative",
        !compactToolbar && "border-input rounded-md border",
        !isReviewing && !compactToolbar && "[&_.ProseMirror]:min-h-[120px] [&_.ProseMirror]:transition-[min-height] [&_.ProseMirror]:duration-200",
        !isReviewing && !compactToolbar && "[&:focus-within_.ProseMirror]:min-h-[200px]",
        !isReviewing && compactToolbar && "[&_.ProseMirror]:min-h-[6rem]",
        !isReviewing && onAiReply && "[&_.ProseMirror]:pb-10",
        aiReplyBusy && "[&_.ProseMirror]:opacity-60",
        isDragOver && "ring-2 ring-primary border-primary",
        className,
      )}>
      {isDragOver && (
        <div className="absolute inset-0 z-10 flex items-center justify-center rounded-md bg-primary/10 pointer-events-none">
          <span className="text-primary text-sm font-medium">{t("compose.dropFiles")}</span>
        </div>
      )}

      {compactToolbar
        ? toolbarHost && createPortal(compactRow, toolbarHost)
        : toolbarHost ? createPortal(toolbar, toolbarHost) : toolbar}

      {/* Barre de corrections (en haut du champ texte) */}
      {correctionBar}

      {/* Zone d'edition ou diff */}
      {correctionContent ? (
        <div className="prose prose-sm dark:prose-invert max-w-none min-h-[120px] px-3 py-2 text-base leading-relaxed whitespace-pre-wrap">
          {correctionContent}
        </div>
      ) : (
        <EditorContent editor={editor} />
      )}

      {onAiReply && !isReviewing && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="secondary"
              size="icon-sm"
              data-ref="compose-editor-ai-reply"
              aria-label={aiReplyLabel}
              disabled={aiReplyDisabled || aiReplyBusy}
              onMouseDown={(e) => e.preventDefault()}
              onClick={onAiReply}
              className="absolute right-2 bottom-2 z-[5] rounded-full shadow-sm"
            >
              {aiReplyBusy ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
            </Button>
          </TooltipTrigger>
          {aiReplyLabel && <TooltipContent>{aiReplyLabel}</TooltipContent>}
        </Tooltip>
      )}

      {imagesEnabled && !isReviewing && (
        <BubbleMenu
          editor={editor}
          pluginKey="inlineImageMenu"
          shouldShow={({ editor: ed }) => ed.isActive("image")}
          options={{ placement: "top" }}
        >
          <ImageMenu
            size={(editor.getAttributes("image").size as InlineImageSize) || "original"}
            align={(editor.getAttributes("image").align as InlineImageAlign) || "left"}
            onChange={setImageAttrs}
            onRemove={() => editor.chain().focus().deleteSelection().run()}
          />
        </BubbleMenu>
      )}

      <AlertDialog
        open={!!compressAsk}
        onOpenChange={(open) => {
          if (!open && compressAsk) {
            compressAsk.resolve(false);
            setCompressAsk(null);
          }
        }}
      >
        <AlertDialogContent data-ref="compose-image-compress-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>{t("compress.title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {compressAsk ? t("compress.description", { size: formatBytes(compressAsk.file.size) }) : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              data-ref="compose-image-compress-keep"
              onClick={() => { compressAsk?.resolve(false); setCompressAsk(null); }}
            >
              {t("compress.keep")}
            </AlertDialogCancel>
            <AlertDialogAction
              data-ref="compose-image-compress-lighten"
              onClick={() => { compressAsk?.resolve(true); setCompressAsk(null); }}
            >
              {t("compress.lighten")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function ImageMenu({
  size,
  align,
  onChange,
  onRemove,
}: {
  size: InlineImageSize;
  align: InlineImageAlign;
  onChange: (attrs: { size?: InlineImageSize; align?: InlineImageAlign }) => void;
  onRemove: () => void;
}) {
  const t = useT();
  const sizes: { v: InlineImageSize; label: string }[] = [
    { v: "small", label: t("editor.imageSmall") },
    { v: "medium", label: t("editor.imageMedium") },
    { v: "original", label: t("editor.imageOriginal") },
  ];
  const aligns: { v: InlineImageAlign; label: string; Icon: typeof AlignLeft }[] = [
    { v: "left", label: t("editor.alignLeft"), Icon: AlignLeft },
    { v: "center", label: t("editor.alignCenter"), Icon: AlignCenter },
    { v: "right", label: t("editor.alignRight"), Icon: AlignRight },
  ];
  return (
    <div
      data-ref="compose-image-menu"
      className="bg-popover text-popover-foreground border-border flex items-center gap-0.5 rounded-md border p-1 shadow-md"
    >
      {sizes.map((s) => (
        <Toggle
          key={s.v}
          size="sm"
          pressed={size === s.v}
          onPressedChange={() => onChange({ size: s.v })}
          className="px-2 text-xs"
          data-ref={`compose-image-size-${s.v}`}
        >
          {s.label}
        </Toggle>
      ))}
      <Separator orientation="vertical" className="mx-1 h-6" />
      {aligns.map(({ v, label, Icon }) => (
        <Toggle
          key={v}
          size="sm"
          pressed={align === v}
          onPressedChange={() => onChange({ align: v })}
          aria-label={label}
          title={label}
          data-ref={`compose-image-align-${v}`}
        >
          <Icon className="size-4" />
        </Toggle>
      ))}
      <Separator orientation="vertical" className="mx-1 h-6" />
      <Toggle
        size="sm"
        pressed={false}
        onPressedChange={onRemove}
        aria-label={t("editor.removeImage")}
        title={t("editor.removeImage")}
        data-ref="compose-image-remove"
      >
        <Trash2 className="size-4" />
      </Toggle>
    </div>
  );
}
