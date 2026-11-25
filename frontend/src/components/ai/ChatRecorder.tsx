"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Check, Mic, RotateCw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { ouvrirMicro, type PriseMicro } from "@/lib/micro";
import { useT } from "@/lib/i18n";
import pb from "@/lib/pocketbase";

/**
 * Dictee du chat IA, reprise de Beluga Build (recorder.tsx).
 *
 * - Le texte transcrit est DEPOSE dans le champ : rien n'est envoye seul.
 * - Envoi du son : 3 essais sur echec RESEAU uniquement (fetch qui rejette) ;
 *   une reponse d'erreur du serveur s'affiche avec sa vraie raison. Le son est
 *   garde (`blobEnAttenteRef`) tant qu'il n'est pas transcrit : "Reessayer" le
 *   renvoie sans redicter.
 * - Le micro se referme aux quatre issues : valider, jeter, demontage (quitter
 *   l'assistant), second clic pendant l'ouverture.
 */

const BARRES = 28;
const ESSAIS_MAX = 3;
const ATTENTES_MS = [1200, 3500];

export function useRecorder(onText: (text: string) => void, language: string) {
  const t = useT();
  const [recording, setRecording] = useState(false);
  const [working, setWorking] = useState(false);
  const [levels, setLevels] = useState<number[]>(() => new Array(BARRES).fill(0));
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const mimeRef = useRef("audio/webm");
  const rafRef = useRef<number | null>(null);
  const timerRef = useRef<number | null>(null);
  const priseRef = useRef<PriseMicro | null>(null);
  const ouvertureRef = useRef(false);
  const viveRef = useRef(true);
  const blobEnAttenteRef = useRef<Blob | null>(null);
  const onTextRef = useRef(onText);
  onTextRef.current = onText;

  const stopMeter = useCallback(() => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    if (timerRef.current !== null) window.clearInterval(timerRef.current);
    timerRef.current = null;
    setLevels(new Array(BARRES).fill(0));
    setSeconds(0);
  }, []);

  const relacherLeMicro = useCallback(() => {
    const recorder = recorderRef.current;
    recorderRef.current = null;
    if (recorder && recorder.state !== "inactive") {
      try {
        recorder.stop();
      } catch {
        // deja arrete
      }
    }
    priseRef.current?.fermer();
    priseRef.current = null;
    stopMeter();
    chunksRef.current = [];
    setRecording(false);
  }, [stopMeter]);

  const start = useCallback(async () => {
    if (ouvertureRef.current || priseRef.current) return;
    ouvertureRef.current = true;
    let prise: PriseMicro | null = null;
    try {
      prise = await ouvrirMicro();
      if (!viveRef.current) {
        prise.fermer();
        return;
      }
      const stream = prise.flux;
      const recorder = new MediaRecorder(stream);
      mimeRef.current = recorder.mimeType || "audio/webm";
      chunksRef.current = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size) chunksRef.current.push(event.data);
      };
      recorder.start();
      recorderRef.current = recorder;
      priseRef.current = prise;
      setError(null);
      setRecording(true);
      setSeconds(0);
      timerRef.current = window.setInterval(() => setSeconds((v) => v + 1), 1000);

      const context = new AudioContext();
      const source = context.createMediaStreamSource(stream);
      const analyser = context.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      prise.brancher(context, source);
      const data = new Uint8Array(analyser.frequencyBinCount);
      const loop = () => {
        analyser.getByteTimeDomainData(data);
        let peak = 0;
        for (const value of data) peak = Math.max(peak, Math.abs(value - 128) / 128);
        setLevels((current) => [...current.slice(1), Math.min(1, peak * 2.4)]);
        rafRef.current = requestAnimationFrame(loop);
      };
      rafRef.current = requestAnimationFrame(loop);
    } catch {
      prise?.fermer();
      priseRef.current = null;
      toast.error(t("aiChat.micUnavailable"));
    } finally {
      ouvertureRef.current = false;
    }
  }, [t]);

  const envoyer = useCallback(
    async (blob: Blob) => {
      setWorking(true);
      setError(null);
      for (let essai = 0; essai < ESSAIS_MAX; essai += 1) {
        let response: Response;
        try {
          response = await fetch(`/api/ai/transcribe?lang=${encodeURIComponent(language || "fr")}`, {
            method: "POST",
            headers: {
              "Content-Type": blob.type || "application/octet-stream",
              Authorization: `Bearer ${pb.authStore.token}`,
            },
            body: blob,
          });
        } catch {
          if (essai < ESSAIS_MAX - 1) {
            await new Promise((resolve) => window.setTimeout(resolve, ATTENTES_MS[essai] ?? 3500));
            continue;
          }
          blobEnAttenteRef.current = blob;
          setWorking(false);
          setError(t("aiChat.dictationNetwork"));
          return;
        }
        const data = (await response.json().catch(() => ({}))) as { text?: string; error?: string };
        if (!response.ok) {
          blobEnAttenteRef.current = blob;
          setWorking(false);
          setError(
            response.status === 401
              ? t("aiChat.dictationSession")
              : t("aiChat.dictationFailed", { error: data.error || `HTTP ${response.status}` })
          );
          return;
        }
        blobEnAttenteRef.current = null;
        setWorking(false);
        if (data.text && data.text.trim()) onTextRef.current(data.text.trim());
        else toast.warning(t("aiChat.dictationEmpty"));
        return;
      }
    },
    [language, t]
  );

  const finish = useCallback(
    async (keep: boolean) => {
      const recorder = recorderRef.current;
      if (!recorder) return;
      recorderRef.current = null;
      await new Promise<void>((resolve) => {
        recorder.onstop = () => resolve();
        try {
          recorder.stop();
        } catch {
          resolve();
        }
      });
      // Micro relache AVANT l'envoi : jamais ouvert pendant la transcription.
      priseRef.current?.fermer();
      priseRef.current = null;
      stopMeter();
      setRecording(false);
      if (!keep) {
        chunksRef.current = [];
        return;
      }
      const blob = new Blob(chunksRef.current, { type: mimeRef.current });
      chunksRef.current = [];
      await envoyer(blob);
    },
    [envoyer, stopMeter]
  );

  const retry = useCallback(() => {
    if (blobEnAttenteRef.current) void envoyer(blobEnAttenteRef.current);
  }, [envoyer]);

  const discardError = useCallback(() => {
    blobEnAttenteRef.current = null;
    setError(null);
  }, []);

  // Quitter l'assistant (demontage) relache le micro.
  useEffect(() => {
    viveRef.current = true;
    return () => {
      viveRef.current = false;
      relacherLeMicro();
    };
  }, [relacherLeMicro]);

  // `cancel` : relacher le micro sans rien transcrire (panneau ferme ou vue
  // changee alors que le composant reste monte).
  return { recording, working, levels, seconds, error, start, finish, retry, discardError, cancel: relacherLeMicro };
}

/** Bandeau d'enregistrement : remplace le champ pendant la dictee. */
export function RecordingBar({
  levels,
  seconds,
  onValidate,
  onDiscard,
}: {
  levels: number[];
  seconds: number;
  onValidate: () => void;
  onDiscard: () => void;
}) {
  const t = useT();
  const minutes = Math.floor(seconds / 60);
  const reste = seconds % 60;
  return (
    <div
      className="flex min-h-11 w-full items-center gap-2 rounded-lg bg-orange-500 px-2.5 py-2 text-white"
      data-ref="ai-chat-recording"
    >
      <span className="relative flex size-5 shrink-0 items-center justify-center">
        <span className="absolute inset-0 animate-pulse rounded-full bg-white/25" />
        <Mic className="relative size-3" />
      </span>
      <span className="shrink-0 font-mono text-[0.8125rem] tabular-nums">
        {minutes}:{String(reste).padStart(2, "0")}
      </span>
      <div className="flex h-6 min-w-0 flex-1 items-center gap-[2px]" aria-hidden>
        {levels.map((level, index) => (
          <span
            key={index}
            className="flex-1 rounded-full bg-white/80 transition-[height] duration-75"
            style={{ height: `${Math.max(10, Math.round(level * 100))}%` }}
          />
        ))}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <button
          type="button"
          onClick={onValidate}
          title={t("aiChat.dictationValidate")}
          aria-label={t("aiChat.dictationValidate")}
          className="inline-flex size-8 items-center justify-center rounded-md bg-white/15 transition-colors hover:bg-white/30"
          data-ref="ai-chat-recording-validate"
        >
          <Check className="size-4" />
        </button>
        <button
          type="button"
          onClick={onDiscard}
          title={t("aiChat.dictationDiscard")}
          aria-label={t("aiChat.dictationDiscard")}
          className="inline-flex size-8 items-center justify-center rounded-md transition-colors hover:bg-white/20"
          data-ref="ai-chat-recording-discard"
        >
          <Trash2 className="size-4" />
        </button>
      </div>
    </div>
  );
}

/** Echec de l'envoi apres les essais : le son reste garde. */
export function RecorderErrorBar({
  message,
  onRetry,
  onDiscard,
}: {
  message: string;
  onRetry: () => void;
  onDiscard: () => void;
}) {
  const t = useT();
  return (
    <div className="mb-2 flex w-full items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-2.5 py-2 text-[0.8125rem] text-destructive">
      <AlertTriangle className="size-4 shrink-0" />
      <span className="min-w-0 flex-1">{message}</span>
      <button
        type="button"
        onClick={onRetry}
        className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-destructive/30 px-2 text-xs transition-colors hover:bg-destructive/10"
      >
        <RotateCw className="size-3.5" />
        {t("aiChat.dictationRetry")}
      </button>
      <button
        type="button"
        onClick={onDiscard}
        title={t("aiChat.dictationDiscard")}
        aria-label={t("aiChat.dictationDiscard")}
        className="inline-flex size-7 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-destructive/10"
      >
        <Trash2 className="size-3.5" />
      </button>
    </div>
  );
}
