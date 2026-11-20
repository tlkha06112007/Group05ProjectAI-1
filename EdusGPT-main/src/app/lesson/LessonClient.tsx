"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, ChevronDown, Info, LoaderCircle } from "lucide-react";
import type { Lesson } from "@/lib/lesson/types";
import type { RunLogEntry } from "@/lib/lesson/run-log";
import { RunLog } from "@/components/studio/GenerationTimeline";
import { LessonPlayer } from "@/components/player/LessonPlayer";
import { SceneLoader3D } from "@/components/three/SceneLoader3D";
import { SAMPLE_LESSON, SAMPLE_LESSONS } from "@/lib/lesson/sample-lesson";
import { getActiveLessonId, loadStoredLessons, setActiveLessonId } from "@/lib/lesson/storage";
import { useCopy } from "@/i18n/provider";

const COPY = {
  en: {
    lessonLoading: "Loading lesson from library…",
    cancelButton: "Cancel & back to library",
    lessonLocalOnly:
      "This lesson is not on the server yet, so the copy in your browser is open. Press \"Save to library\" on the create page to keep it.",
    lessonMissing: "This lesson was not found in the library.",
    lessonLoadFailed: "The lesson could not be loaded from the server.",
    lessonSampleNotice: "Showing a sample lesson instead.",
    lessonLogTitle: "Generation log ({count} lines)",
  },
  vi: {
    lessonLoading: "Đang tải bài từ thư viện…",
    cancelButton: "Hủy & quay lại thư viện",
    lessonLocalOnly:
      "Bài này chưa được lưu lên máy chủ, đang mở bản trong trình duyệt. Bấm \"Lưu vào thư viện\" ở trang tạo bài để giữ lâu dài.",
    lessonMissing: "Không tìm thấy bài này trong thư viện.",
    lessonLoadFailed: "Không tải được bài từ máy chủ.",
    lessonSampleNotice: "Đang hiển thị bài mẫu thay thế.",
    lessonLogTitle: "Nhật ký tạo bài ({count} dòng)",
  },
};

/** Fills the one `{count}` slot in the run-log label. */
function logTitle(copy: string, count: number): string {
  return copy.replace("{count}", String(count));
}

/**
 * Why the lesson could not be fetched, kept as a dictionary key rather than a
 * sentence: a language switch then re-reads the message instead of leaving the
 * previous language on screen until the next fetch.
 */
type LoadErrorKey = keyof typeof COPY.en;

interface LessonClientProps {
  /** Resolved on the server from `?c=<id>`; null on the plain /lesson route. */
  courseId: string | null;
  /** Initial modal mode: "quiz" or "flashcard" */
  initialMode?: "quiz" | "flashcard" | null;
}

/**
 * The player is a client island because it must fetch a library course by id.
 * The id itself is resolved on the server, so the player still renders
 * server-side on the plain `/lesson` route — using `useSearchParams` here would
 * force the whole player behind a Suspense fallback on first paint.
 */
export default function LessonClient({ courseId, initialMode }: LessonClientProps) {
  const t = useCopy(COPY);
  const [lesson, setLesson] = useState<Lesson>(SAMPLE_LESSON);
  const [loading, setLoading] = useState(Boolean(courseId));
  const [loadError, setLoadError] = useState<LoadErrorKey | null>(null);
  /** The run log saved with the lesson, shown behind a toggle below. */
  const [runLog, setRunLog] = useState<RunLogEntry[]>([]);
  const [logOpen, setLogOpen] = useState(false);

  useEffect(() => {
    const targetId = courseId || getActiveLessonId();
    if (!targetId) {
      setLesson(SAMPLE_LESSON);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setLoadError(null);

    void (async () => {
      try {
        const response = await fetch(`/api/courses?id=${encodeURIComponent(targetId)}`, {
          cache: "no-store",
        });
        if (cancelled) return;
        if (response.status === 404) {
          const local = loadStoredLessons().find((item) => item.id === targetId);
          if (local) {
            setLesson(local);
            setActiveLessonId(local.id);
            setLoadError("lessonLocalOnly");
            return;
          }
          if (courseId) {
            setLoadError("lessonMissing");
          }
          setLesson(SAMPLE_LESSON);
          return;
        }
        const payload = (await response.json()) as { lesson?: Lesson; log?: RunLogEntry[] };
        if (!cancelled && payload.lesson) {
          setLesson(payload.lesson);
          setActiveLessonId(payload.lesson.id);
        }
        if (!cancelled && Array.isArray(payload.log)) setRunLog(payload.log);
      } catch {
        if (!cancelled) setLoadError("lessonLoadFailed");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [courseId]);

  if (loading) {
    return (
      <div className="relative flex min-h-[70vh] w-full flex-col items-center justify-center px-4 py-8">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 flex items-center justify-center overflow-hidden"
        >
          <div className="h-[380px] w-[380px] rounded-full bg-[radial-gradient(circle,rgba(56,189,248,0.15)_0%,rgba(14,165,233,0.06)_40%,transparent_70%)] blur-2xl" />
        </div>

        <div className="relative z-10 w-full max-w-md rounded-3xl border border-ink-700/80 bg-ink-900/95 p-6 sm:p-8 shadow-2xl backdrop-blur-2xl text-center">
          <div className="mb-4 flex items-center justify-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-mist-500/60" />
            <span className="h-1.5 w-7 rounded-full bg-brand-400 shadow-[0_0_10px_rgba(56,189,248,0.7)]" />
            <span className="h-1.5 w-1.5 rounded-full bg-mist-500/60" />
          </div>

          <div className="relative mx-auto mb-2 w-full">
            <SceneLoader3D label={t.lessonLoading} progress={30} height={190} />
          </div>

          <h2 className="text-lg sm:text-xl font-bold tracking-tight text-mist-50">
            {t.lessonLoading}
          </h2>

          <div className="mt-4 space-y-2 rounded-2xl border border-ink-700 bg-ink-950/80 p-3.5 text-xs text-left">
            <div className="flex items-center justify-between text-mist-400">
              <span>{t.lessonLoading}</span>
              <span className="font-mono text-mist-200">30%</span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-ink-800">
              <div
                className="h-full rounded-full bg-gradient-to-r from-brand-400 to-sky-300 transition-[width] duration-300"
                style={{ width: "30%" }}
              />
            </div>
            <div className="flex items-center gap-2 pt-0.5 text-mist-300">
              <LoaderCircle className="h-3.5 w-3.5 shrink-0 animate-spin text-brand-400" />
              <span className="truncate">{t.lessonLoading}</span>
            </div>
          </div>

          <Link
            href="/library"
            className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl border border-ink-700/80 bg-ink-800/80 px-4 py-2.5 text-xs font-medium text-mist-200 transition-colors hover:border-ink-600 hover:bg-ink-700/80 hover:text-mist-50 active:scale-[0.99]"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            <span>{t.cancelButton}</span>
          </Link>
        </div>
      </div>
    );
  }

  return (
    // A column, so the player can take the height the page hands it and the run
    // log below it can be capped rather than pushing the stage off the screen.
    <div className="flex min-h-0 flex-1 flex-col">
      {loadError ? (
        <div className="mb-3 flex items-center gap-2.5 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3.5 py-2 text-xs font-medium text-amber-900 dark:text-amber-200 shadow-xs">
          <Info className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
          <span>
            {t[loadError]} {t.lessonSampleNotice}
          </span>
        </div>
      ) : null}
      <LessonPlayer
        initialLesson={lesson}
        initialMode={initialMode}
        samples={SAMPLE_LESSONS.filter((item) => item.id !== lesson.id)}
      />
      {runLog.length > 0 ? (
        <div className="panel mt-4 p-4 lg:max-h-[28vh] lg:overflow-y-auto">
          <button
            type="button"
            onClick={() => setLogOpen((open) => !open)}
            className="flex w-full items-center justify-between gap-2 text-left"
            aria-expanded={logOpen}
          >
            <span className="text-sm font-semibold text-mist-100">
              {logTitle(t.lessonLogTitle, runLog.length)}
            </span>
            <ChevronDown
              className={`h-4 w-4 shrink-0 text-mist-400 transition-transform ${logOpen ? "rotate-180" : ""}`}
            />
          </button>
          {logOpen ? <RunLog log={runLog} /> : null}
        </div>
      ) : null}
    </div>
  );
}
