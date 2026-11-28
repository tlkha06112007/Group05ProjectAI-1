"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowLeft, CheckCircle2, LoaderCircle } from "lucide-react";
import { SceneLoader3D } from "@/components/three/SceneLoader3D";
import { decodeWordMarks, setChannelWords, type NarrationChannel } from "@/lib/karaoke";
import type { Lesson } from "@/lib/lesson/types";
import { fill, useCopy } from "@/i18n/provider";

const COPY = {
  en: {
    loadingTitle: "Preparing lesson",
    connecting: "Connecting to lesson library…",
    preparingSlides: "Preparing interactive slides & models…",
    loadingVoice: "Loading AI voice & karaoke subtitles…",
    loadingSceneVoice: "Loading voice for slide {current}/{total}…",
    ready: "Ready to learn!",
    cancelButton: "Cancel & back to library",
    progressLabel: "Loading progress",
  },
  vi: {
    loadingTitle: "Đang chuẩn bị bài học",
    connecting: "Đang nạp dữ liệu bài giảng…",
    preparingSlides: "Đang chuẩn bị slide và mô phỏng…",
    loadingVoice: "Đang tải giọng đọc AI và phụ đề karaoke…",
    loadingSceneVoice: "Đang tải giọng đọc slide {current}/{total}…",
    ready: "Sẵn sàng học!",
    cancelButton: "Hủy & quay lại thư viện",
    progressLabel: "Tiến trình nạp",
  },
};

interface LessonLoadingModalProps {
  lesson: Lesson;
  narration: NarrationChannel;
  isOpen: boolean;
  onFinish: () => void;
  onCancel: () => void;
}

export function LessonLoadingModal({
  lesson,
  narration,
  isOpen,
  onFinish,
  onCancel,
}: LessonLoadingModalProps) {
  const t = useCopy(COPY);
  const [progress, setProgress] = useState(15);
  const [statusMessage, setStatusMessage] = useState(t.connecting);
  const [isDone, setIsDone] = useState(false);
  const finishCalledRef = useRef(false);
  const onFinishRef = useRef(onFinish);
  onFinishRef.current = onFinish;
  const lessonRef = useRef(lesson);
  lessonRef.current = lesson;
  const narrationRef = useRef(narration);
  narrationRef.current = narration;

  useEffect(() => {
    if (!isOpen) return;

    finishCalledRef.current = false;
    setProgress(15);
    setStatusMessage(t.connecting);
    setIsDone(false);

    const controller = new AbortController();

    const loadAssets = async () => {
      try {
        // Step 1: Connecting & preparing slides
        await new Promise((r) => setTimeout(r, 200));
        if (controller.signal.aborted) return;
        setProgress(20);
        setStatusMessage(t.preparingSlides);

        // Step 2: Prewarm ALL scenes with narration
        const currentLesson = lessonRef.current;
        const scenesWithNarration = currentLesson.scenes
          .map((scene, index) => ({ scene, index }))
          .filter((item) => Boolean(item.scene.narration?.trim()));

        const totalScenes = scenesWithNarration.length;

        if (totalScenes > 0) {
          const voice = currentLesson.voice || "vi-VN-HoaiMyNeural";

          for (let i = 0; i < totalScenes; i++) {
            if (controller.signal.aborted) return;

            const { scene, index } = scenesWithNarration[i];
            const currentPct = Math.round(20 + (i / totalScenes) * 75);
            setProgress(currentPct);
            setStatusMessage(
              fill(t.loadingSceneVoice, { current: i + 1, total: totalScenes }),
            );

            // Per-scene timeout controller (max 7s per slide to prevent stalling)
            const sceneController = new AbortController();
            const sceneTimeout = setTimeout(() => sceneController.abort(), 7000);
            const onParentAbort = () => sceneController.abort();
            controller.signal.addEventListener("abort", onParentAbort);

            try {
              const response = await fetch("/api/tts", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ text: scene.narration, voice }),
                signal: sceneController.signal,
              });

              clearTimeout(sceneTimeout);
              controller.signal.removeEventListener("abort", onParentAbort);

              if (response.ok && !controller.signal.aborted) {
                const wordsHeader = response.headers.get("x-tts-words");
                const words = await decodeWordMarks(wordsHeader);
                if (words.length > 0) {
                  setChannelWords(narrationRef.current, index, words);
                }
              }
            } catch {
              clearTimeout(sceneTimeout);
              controller.signal.removeEventListener("abort", onParentAbort);
              // Per-scene error or timeout: continue to next scene gracefully
            }
          }
        }

        if (controller.signal.aborted) return;

        // Step 3: Complete
        setProgress(100);
        setStatusMessage(t.ready);
        setIsDone(true);

        // Allow user to see 100% completion with the happy robot, then dismiss
        await new Promise((r) => setTimeout(r, 450));
        if (!controller.signal.aborted && !finishCalledRef.current) {
          finishCalledRef.current = true;
          onFinishRef.current();
        }
      } catch {
        if (!controller.signal.aborted && !finishCalledRef.current) {
          finishCalledRef.current = true;
          onFinishRef.current();
        }
      }
    };

    void loadAssets();

    return () => {
      controller.abort();
    };
  }, [isOpen, lesson.id]);

  if (!isOpen) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t.loadingTitle}
      className="absolute inset-0 z-[60] flex items-start justify-center pt-10 sm:items-center sm:pt-4 p-4 bg-ink-950/95 backdrop-blur-xl rounded-2xl animate-in fade-in duration-200 select-none"
    >
      {/* Background ambient radial glow */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 flex items-center justify-center overflow-hidden"
      >
        <div className="h-[380px] w-[380px] rounded-full bg-[radial-gradient(circle,rgba(56,189,248,0.15)_0%,rgba(14,165,233,0.06)_40%,transparent_70%)] blur-2xl" />
      </div>

      {/* Center Glass Card (Matching Classroom Creation Glassmorphism) */}
      <div className="relative z-10 w-full max-w-md rounded-3xl border border-ink-700/80 bg-ink-900/95 p-6 sm:p-8 shadow-2xl backdrop-blur-2xl text-center">
        {/* Top 3 dots/pills indicator */}
        <div className="mb-4 flex items-center justify-center gap-1.5">
          <span className="h-1.5 w-1.5 rounded-full bg-mist-500/60" />
          <span className="h-1.5 w-7 rounded-full bg-brand-400 shadow-[0_0_10px_rgba(56,189,248,0.7)]" />
          <span className="h-1.5 w-1.5 rounded-full bg-mist-500/60" />
        </div>

        {/* 3D Robot Animated Scene */}
        <div className="relative mx-auto mb-2 w-full">
          <SceneLoader3D label={statusMessage} progress={progress} height={190} />
        </div>

        {/* Lesson Titles */}
        <h2 className="text-lg sm:text-xl font-bold tracking-tight text-mist-50 line-clamp-2">
          {lesson.title}
        </h2>
        <p className="mt-1 text-xs text-mist-400 line-clamp-1">
          {lesson.subject}
          {lesson.grade ? ` · ${lesson.grade}` : ""}
        </p>

        {/* Live Step Progress / Checklist */}
        <div className="mt-4 space-y-2 rounded-2xl border border-ink-700 bg-ink-950/80 p-3.5 text-xs text-left">
          <div className="flex items-center justify-between text-mist-400">
            <span>{t.progressLabel}</span>
            <span className="font-mono text-mist-200">{progress}%</span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-ink-800">
            <div
              className="h-full rounded-full bg-gradient-to-r from-brand-400 to-sky-300 transition-[width] duration-300"
              style={{ width: `${progress}%` }}
            />
          </div>
          <div className="flex items-center gap-2 pt-0.5 text-mist-300">
            {isDone ? (
              <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
            ) : (
              <LoaderCircle className="h-3.5 w-3.5 shrink-0 animate-spin text-brand-400" />
            )}
            <span className="truncate">{statusMessage}</span>
          </div>
        </div>

        {/* Cancel Button: Returns to Library without entering player */}
        <button
          type="button"
          onClick={onCancel}
          className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl border border-ink-700/80 bg-ink-800/80 px-4 py-2.5 text-xs font-medium text-mist-200 transition-colors hover:border-ink-600 hover:bg-ink-700/80 hover:text-mist-50 active:scale-[0.99]"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          <span>{t.cancelButton}</span>
        </button>
      </div>
    </div>
  );
}
