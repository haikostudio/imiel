import Image from "@tiptap/extension-image";
import { mergeAttributes } from "@tiptap/react";
import { inlineImageStyle, type InlineImageAlign, type InlineImageSize } from "@/lib/inline-images";

const SIZES: InlineImageSize[] = ["small", "medium", "original"];
const ALIGNS: InlineImageAlign[] = ["left", "center", "right"];

/**
 * Image placee dans le texte d'un mail : taille (petite/moyenne/originale) et
 * alignement ecrits en style inline (seule forme respectee par la plupart des
 * messageries) ET en data-* (relus a la reouverture du brouillon).
 * `uploadId` est un attribut d'etat (non rendu) : il repere l'image pendant
 * l'enregistrement de son fichier, avant que son adresse definitive soit connue.
 */
export const InlineImage = Image.extend({
  addAttributes() {
    return {
      src: { default: null },
      alt: { default: null },
      title: { default: null },
      size: {
        default: "original" as InlineImageSize,
        parseHTML: (el: HTMLElement) => {
          const v = el.getAttribute("data-size") as InlineImageSize | null;
          return v && SIZES.includes(v) ? v : "original";
        },
        renderHTML: () => ({}),
      },
      align: {
        default: "left" as InlineImageAlign,
        parseHTML: (el: HTMLElement) => {
          const v = el.getAttribute("data-align") as InlineImageAlign | null;
          return v && ALIGNS.includes(v) ? v : "left";
        },
        renderHTML: () => ({}),
      },
      uploadId: {
        default: null,
        parseHTML: () => null,
        renderHTML: () => ({}),
      },
    };
  },

  renderHTML({ node, HTMLAttributes }) {
    const size = node.attrs.size as InlineImageSize;
    const align = node.attrs.align as InlineImageAlign;
    return [
      "img",
      mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, {
        "data-size": size,
        "data-align": align,
        style: inlineImageStyle(size, align),
      }),
    ];
  },
}).configure({ inline: false, allowBase64: false });
