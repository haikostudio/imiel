import { NextRequest, NextResponse } from "next/server";
import { callOpenRouter, formatAiHtml, resolveModel } from "../openrouter";
import { fetchCerveauContext, fetchRelatedEmails } from "../context";

const LANG_NAMES: Record<string, string> = {
  fr: "francais",
  en: "English",
  de: "Deutsch",
  it: "italiano",
};

export async function POST(request: NextRequest) {
  try {
    const { subject, originalMessage, senderName, userName, threadContext, draftContent, language, apiKey, tone, mode, customPrompt, userId, originalDate, keepLanguage, model } =
      await request.json();

    const isCompose = mode === "compose";

    if (!isCompose && !originalMessage) {
      return NextResponse.json(
        { error: "originalMessage is required for reply mode" },
        { status: 400 }
      );
    }

    if (isCompose && !draftContent && !customPrompt) {
      return NextResponse.json(
        { error: "draftContent or customPrompt is required for compose mode" },
        { status: 400 }
      );
    }

    const lang = LANG_NAMES[language] || LANG_NAMES.fr;

    const toneInstruction = customPrompt
      ? `Instruction personnalisee de l'utilisateur : ${customPrompt}`
      : tone === "friendly"
        ? `Ton amical et decontracte. Tutoiement si la langue le permet. Formules legeres (ex: "Salut", "A bientot !").`
        : tone === "personal"
          ? `Ton personnel, chaleureux et sincere. Ecris a la premiere personne, comme un vrai message de l'utilisateur. Reste naturel et humain, adapte le tutoiement ou le vouvoiement a la relation. Evite le jargon corporate et les formules toutes faites.`
          : `Ton professionnel mais naturel. Vouvoiement si la langue le permet. Inclus une formule d'ouverture (ex: "Bonjour,") et une formule de cloture adaptee (ex: "Cordialement,", "Bien a vous,", "Best regards,").`;

    let systemPrompt: string;
    let userPrompt: string;

    if (isCompose) {
      // Mode compose : ameliorer le brouillon ou generer un email
      const hasDraft = !!draftContent;
      // keepLanguage (menu IA de la fenetre : reformuler, raccourcir) : le
      // brouillon garde SA langue, quelle que soit celle de l'interface.
      const langRule = keepLanguage && draftContent
        ? "Langue : la MEME langue que le brouillon de l'utilisateur. Ne le traduis jamais."
        : `Langue : ${lang}`;
      const baseRules = `- ${toneInstruction}
- ${langRule}
- NE mets PAS de signature avec un nom a la fin (la signature email sera ajoutee automatiquement)
- N'utilise JAMAIS de tirets longs (— ou –). Utilise uniquement des tirets courts (-) si necessaire.
- Formate ta reponse en HTML. Utilise UNIQUEMENT ces balises : <p>, <br>, <strong>, <em>, <ul>, <ol>, <li>. N'utilise PAS de syntaxe Markdown. Chaque paragraphe doit etre dans une balise <p>.
- Retourne UNIQUEMENT le HTML de l'email, sans aucun texte avant ou apres`;

      systemPrompt = hasDraft
        ? `Tu es un assistant de redaction d'email pour "${userName || "l'utilisateur"}". On te donne un brouillon d'email redige par l'utilisateur. Ta tache est de l'ameliorer : corriger la formulation, rendre le texte plus clair et fluide, tout en conservant le sens, l'intention et les informations du message original.

Regles :
- CONSERVE le sens et l'intention du message original. Ne change pas le contenu, ne supprime pas d'informations, n'en invente pas.
- Ameliore la formulation : clarte, fluidite, structure.
${baseRules}`
        : `Tu es un assistant de redaction d'email pour "${userName || "l'utilisateur"}". Ta tache est de rediger un email selon les instructions de l'utilisateur.

Regles :
${baseRules}`;

      const draft = draftContent ? draftContent.replace(/<[^>]*>/g, "").slice(0, 3000) : "";
      userPrompt = draft
        ? `Sujet: ${subject || "(sans sujet)"}

Brouillon de l'utilisateur a ameliorer :
${draft}`
        : `Sujet: ${subject || "(sans sujet)"}

Redige un email selon les instructions ci-dessus.`;
    } else {
      // Mode reply : deux comportements distincts selon que l'utilisateur a deja
      // ecrit quelque chose dans le champ de reponse ou non.
      const draftPlain = draftContent
        ? draftContent.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim()
        : "";
      const hasDraft = draftPlain.length > 0;

      if (hasDraft) {
        // L'utilisateur a deja redige sa reponse : on la REECRIT dans le ton
        // choisi (on NE genere PAS une nouvelle reponse au message d'origine).
        systemPrompt = `Tu es "${userName || "l'utilisateur"}". L'utilisateur a deja redige sa reponse a "${senderName || "inconnu"}". Ta tache est de REECRIRE ce brouillon dans le ton demande, en gardant exactement le sens, l'intention et toutes les informations.

Regles :
- CONSERVE le sens, l'intention et toutes les infos du brouillon. N'ajoute pas d'informations nouvelles, ne supprime rien, ne reponds pas a la place de l'utilisateur.
- Ameliore la formulation : clarte, fluidite, structure.
- ${toneInstruction}
- Langue : ${lang}
- NE mets PAS de signature avec un nom a la fin (la signature email sera ajoutee automatiquement)
- N'utilise JAMAIS de tirets longs (— ou –). Utilise uniquement des tirets courts (-) si necessaire.
- Formate ta reponse en HTML. Utilise UNIQUEMENT ces balises : <p>, <br>, <strong>, <em>, <ul>, <ol>, <li>. N'utilise PAS de syntaxe Markdown. Chaque paragraphe doit etre dans une balise <p>.
- Retourne UNIQUEMENT le HTML de la reponse reecrite, sans aucun texte avant ou apres`;

        const contextForRewrite = threadContext
          ? `Contexte de la conversation (pour comprendre le sujet, NE PAS y repondre) :\n${threadContext}\n\n---\n`
          : originalMessage
            ? `Message auquel l'utilisateur repond (pour le contexte, NE PAS y repondre) :\n${originalMessage.slice(0, 1500)}\n\n---\n`
            : "";

        userPrompt = `Sujet: ${subject || "(sans sujet)"}

${contextForRewrite}Brouillon de l'utilisateur a reecrire dans le ton demande :
${draftPlain.slice(0, 3000)}`;
      } else {
        // Pas de brouillon : on GENERE une reponse. Mais d'abord on ANALYSE le
        // dossier en recuperant les emails lies dans la boite (meme commande,
        // meme expediteur, meme sujet) via le RAG hybride du worker - comme le
        // fait l'assistant chat. Sinon le modele repond naivement au seul dernier
        // mail sans voir l'etat reel (ex: confirmer un retour / renvoyer des
        // photos alors que l'article n'est meme pas encore livre).
        // Le NUMERO de commande/reference est le signal le plus fort : il relie
        // toute la chronologie d'un dossier (commande -> expedition -> retour).
        // On requete par refs si presentes, sinon par expediteur + sujet ; on ne
        // met JAMAIS le corps entier (ca dilue la recherche vers du generique).
        const refMatches = `${subject || ""} ${originalMessage}`.match(
          /\b[A-Z]{0,4}\d{6,}[A-Z0-9]*\b/gi
        );
        const refs = refMatches
          ? Array.from(new Set(refMatches.map((r) => r.toUpperCase())))
              .slice(0, 6)
              .join(" ")
          : "";
        const analysisQuery =
          refs || [senderName, subject].filter(Boolean).join(" ");
        const relatedEmails = await fetchRelatedEmails(
          userId,
          analysisQuery,
          originalDate
        );

        systemPrompt = `Tu es "${userName || "l'utilisateur"}". Tu rediges une reponse d'email a "${senderName || "inconnu"}". Ecris exactement comme le ferait ${userName || "l'utilisateur"} : naturel, direct, humain.

Regles :
- ANALYSE D'ABORD la situation reelle du dossier avant de rediger. Reconstitue la chronologie a partir de TOUS les emails fournis (commande, paiement, expedition, livraison, retour, remboursement, rendez-vous...) et determine l'ETAT ACTUEL precis.
- Ne CONFIRME jamais une action qui n'a pas eu lieu et ne donne aucune information qui contredit les faits (ex: si l'article n'est pas encore livre, ne dis pas que tu renvoies des photos du produit recu, ne dis pas que tu l'as bien recu). Si le dernier message demande quelque chose qui ne colle pas a l'etat reel, reponds en tenant compte de la situation reelle et signale-le poliment.
- N'invente AUCUN fait : utilise UNIQUEMENT ce qui figure dans les emails fournis. Si une information manque, reste prudent ou demande-la, ne la fabrique pas.
- REPONDS au dernier message recu et fais avancer la conversation : confirme ce qui est confirmable, reponds aux questions, donne les infos demandees, propose une suite.
- Adapte la longueur au message recu.
- ${toneInstruction}
- Langue : ${lang}
- NE repete PAS ce que l'expediteur a deja dit
- NE mets PAS de signature avec un nom a la fin (la signature email sera ajoutee automatiquement)
- N'utilise JAMAIS de tirets longs (— ou –). Utilise uniquement des tirets courts (-) si necessaire.
- Formate ta reponse en HTML. Utilise UNIQUEMENT ces balises : <p>, <br>, <strong>, <em>, <ul>, <ol>, <li>. N'utilise PAS de syntaxe Markdown. Chaque paragraphe doit etre dans une balise <p>.
- Retourne UNIQUEMENT le HTML de la reponse, sans aucun texte avant ou apres`;

        const relatedSection = relatedEmails
          ? `\nEmails de ta boite possiblement lies a ce dossier (du plus ancien au plus recent). Sers-t'en pour reconstituer la chronologie et l'etat reel ; CERTAINS peuvent etre hors-sujet, ignore ceux qui ne correspondent pas. Ne reponds PAS a ces emails :\n${relatedEmails}\n\n---\n`
          : "";

        const threadSection = threadContext
          ? `\nHistorique de cette conversation (du plus ancien au plus recent) :\n${threadContext}\n\n---\n`
          : "";

        userPrompt = `Sujet: ${subject || "(sans sujet)"}
${relatedSection}${threadSection}
Message de ${senderName || "inconnu"} auquel tu reponds (DERNIER message recu) :
${originalMessage.slice(0, 3000)}`;
      }
    }

    // Injection du contexte memoire (Cerveau) dans le prompt systeme.
    const recallQuery = [subject, customPrompt, originalMessage, draftContent]
      .filter(Boolean)
      .join(" ")
      .replace(/<[^>]*>/g, " ");
    const cerveauContext = await fetchCerveauContext(userId, recallQuery);
    const finalSystemPrompt = systemPrompt + cerveauContext;

    const reply = await callOpenRouter(finalSystemPrompt, userPrompt, { apiKey, model: resolveModel(model) });
    return NextResponse.json({ reply: formatAiHtml(reply) });
  } catch (err) {
    console.error("AI suggest error:", err);
    return NextResponse.json(
      { error: (err as Error).message || "AI generation failed" },
      { status: 500 }
    );
  }
}
