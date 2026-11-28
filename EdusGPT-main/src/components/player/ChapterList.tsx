"use client";

import { useState } from "react";
import {
  ChevronDown,
  ChevronUp,
  ListVideo,
  FileText,
  Maximize2,
  Minimize2,
  Play,
} from "lucide-react";
import type { Timebase } from "@/hooks/useTimebase";
import { sceneKindLabel, type Lesson } from "@/lib/lesson/types";
import { formatClock } from "@/lib/format";
import { useCopy, useLang } from "@/i18n/provider";
import { InlineText } from "./InlineText";

const COPY = {
  en: {
    chapterOutline: "Lesson chapters",
    tabOutline: "Chapters",
    tabTranscript: "Transcript",
    expandOutline: "Widen sidebar",
    collapseOutline: "Narrow sidebar",
    hideOutline: "Hide chapters (expand AI chat)",
    openOutline: "Open lesson chapters",
    openOutlineHint: "Click to show chapters & transcript",
    scenesUnit: "scenes",
  },
  vi: {
    chapterOutline: "Mục lục bài giảng",
    tabOutline: "Mục lục",
    tabTranscript: "Lời giảng",
    expandOutline: "Mở rộng cột bên",
    collapseOutline: "Thu gọn cột bên",
    hideOutline: "Ẩn mục lục (mở rộng khung AI)",
    openOutline: "Mở mục lục bài giảng",
    openOutlineHint: "Nhấn để mở mục lục & lời giảng",
    scenesUnit: "cảnh",
  },
};

interface ChapterListProps {
  lesson: Lesson;
  timebase: Timebase;
  activeScene: number;
  activeChapter: number;
  open?: boolean;
  onOpen?: () => void;
  onClose?: () => void;
  fullHeight?: boolean;
  expanded?: boolean;
  onToggleExpand?: () => void;
}

/** Clickable YouTube-style outline: chapter → scene with collapse/expand and transcript. */
export function ChapterList({
  lesson,
  timebase,
  activeScene,
  activeChapter,
  open = true,
  onOpen,
  onClose,
  fullHeight = false,
  expanded = false,
  onToggleExpand,
}: ChapterListProps) {
  const t = useCopy(COPY);
  const lang = useLang();
  const [activeTab, setActiveTab] = useState<"outline" | "transcript">("outline");

  // Single persistent panel container with synchronized CSS `height` calc()
  // values on desktop (lg:) and `max-height` on mobile so toggling either panel
  // glides the split line smoothly without ever snapping `max-height: none`.
  return (
    <div
      className={`panel relative flex flex-col overflow-hidden transition-[height,max-height,box-shadow] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] lg:flex-none lg:max-h-none lg:min-h-[3.5rem] ${
        open
          ? fullHeight
            ? "w-full max-h-[34rem] lg:h-[calc(100%-4.25rem)]"
            : "w-full max-h-[18rem] lg:h-[calc(42%-0.375rem)]"
          : "w-full max-h-[3.5rem] min-h-[3.5rem] lg:h-[3.5rem]"
      } ${open && expanded ? "ring-1 ring-brand-500/30" : ""}`}
    >
      <button
        type="button"
        onClick={onOpen}
        tabIndex={open ? -1 : 0}
        aria-hidden={open}
        aria-label={t.openOutline}
        aria-expanded={open}
        className={`group absolute inset-x-0 top-0 z-10 flex h-[3.375rem] w-full items-center gap-3 px-4 text-left transition-opacity duration-200 hover:bg-ink-850/40 ${
          open ? "pointer-events-none opacity-0" : "opacity-100 delay-100"
        }`}
      >
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-amber-500/15 text-amber-600 dark:text-amber-400 transition-colors group-hover:bg-amber-500/25">
          <ListVideo className="h-4 w-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-mist-100">
            <span className="truncate">{t.chapterOutline}</span>
            <span className="shrink-0 rounded bg-ink-800 px-1.5 py-0.5 font-mono text-[10px] font-normal normal-case text-mist-400">
              {lesson.scenes.length} {t.scenesUnit}
            </span>
          </span>
          <span className="block truncate text-[11px] text-mist-400 group-hover:text-mist-200 transition-colors">
            {t.openOutlineHint}
          </span>
        </span>
        <ChevronDown className="h-4 w-4 shrink-0 text-mist-400 group-hover:text-mist-200 transition-colors" />
      </button>

      <div
        inert={!open || undefined}
        aria-hidden={!open}
        className={`flex min-h-0 flex-1 flex-col transition-[opacity,transform] ease-[cubic-bezier(0.22,1,0.36,1)] ${
          open
            ? "duration-300 delay-75 translate-y-0 opacity-100"
            : "duration-150 -translate-y-2 pointer-events-none opacity-0"
        }`}
      >
        {/* Header: Title, duration, tabs, and expand/hide toggles */}
      <div className="shrink-0 flex flex-col gap-2 border-b border-ink-700/70 bg-ink-950/60 p-3 sm:px-4">
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <ListVideo className="h-4 w-4 shrink-0 text-amber-500 dark:text-amber-400" />
            <h3 className="truncate text-sm font-bold text-mist-100">{t.chapterOutline}</h3>
            <span className="shrink-0 rounded bg-ink-800 px-1.5 py-0.5 font-mono text-[10px] text-mist-400">
              {lesson.scenes.length} {t.scenesUnit} · {formatClock(lesson.duration, false)}
            </span>
          </div>

          <div className="flex shrink-0 items-center gap-1">
            {onToggleExpand && (
              <button
                type="button"
                onClick={onToggleExpand}
                className="btn-icon h-7 w-7 rounded-md text-mist-300 hover:text-mist-50"
                title={expanded ? t.collapseOutline : t.expandOutline}
                aria-label={expanded ? t.collapseOutline : t.expandOutline}
              >
                {expanded ? (
                  <Minimize2 className="h-3.5 w-3.5" />
                ) : (
                  <Maximize2 className="h-3.5 w-3.5" />
                )}
              </button>
            )}
            {onClose && (
              <button
                type="button"
                onClick={onClose}
                className="btn-icon h-7 w-7 rounded-md text-mist-300 hover:text-mist-50"
                title={t.hideOutline}
                aria-label={t.hideOutline}
              >
                <ChevronUp className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>

        {/* Tab switch: Chapters vs Full Transcript */}
        <div className="flex rounded-lg border border-ink-700/70 bg-ink-900/80 p-0.5">
          <button
            type="button"
            onClick={() => setActiveTab("outline")}
            className={`flex flex-1 items-center justify-center gap-1.5 rounded-md py-1 text-xs font-semibold transition-colors ${
              activeTab === "outline"
                ? "bg-ink-800 text-mist-50 shadow-sm"
                : "text-mist-400 hover:text-mist-200"
            }`}
          >
            <ListVideo className="h-3.5 w-3.5" />
            <span>{t.tabOutline}</span>
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("transcript")}
            className={`flex flex-1 items-center justify-center gap-1.5 rounded-md py-1 text-xs font-semibold transition-colors ${
              activeTab === "transcript"
                ? "bg-ink-800 text-mist-50 shadow-sm"
                : "text-mist-400 hover:text-mist-200"
            }`}
          >
            <FileText className="h-3.5 w-3.5" />
            <span>{t.tabTranscript}</span>
          </button>
        </div>
      </div>

      {/* Content list - scrollable inside with independent scrollbar */}
      <div className="flex-1 min-h-0 overflow-y-auto px-2 py-2">
        {activeTab === "outline" ? (
          lesson.chapters.map((chapter, chapterIndex) => {
            const scenes = lesson.scenes.filter((scene) =>
              chapter.sceneIds.includes(scene.id),
            );
            const isChapterActive = chapterIndex === activeChapter;

            return (
              <div key={chapter.id} className="mb-3">
                {/* Chapter title header */}
                <button
                  type="button"
                  onClick={() => timebase.seek(chapter.start)}
                  className={`flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-left text-xs font-bold uppercase tracking-wide transition-colors ${
                    isChapterActive
                      ? "text-amber-600 dark:text-amber-400 bg-brand-500/10 border-l-2 border-amber-500"
                      : "text-mist-400 hover:bg-ink-850 hover:text-mist-200"
                  }`}
                >
                  <span className="truncate">{chapter.title}</span>
                  <span className="font-mono text-[10px] text-mist-500">
                    {formatClock(chapter.start, false)}
                  </span>
                </button>

                {/* Scene items in YouTube chapter style */}
                <ul className="mt-1 space-y-1">
                  {scenes.map((scene) => {
                    const index = lesson.scenes.findIndex((item) => item.id === scene.id);
                    const isCurrent = index === activeScene;

                    return (
                      <li key={scene.id}>
                        <button
                          type="button"
                          onClick={() => timebase.seek(scene.start)}
                          className={`group flex w-full items-start gap-2.5 rounded-lg p-2 text-left transition-all ${
                            isCurrent
                              ? "border-l-4 border-amber-500 bg-brand-500/15 dark:bg-brand-950/40 text-mist-50 shadow-sm font-semibold"
                              : "border-l-4 border-transparent text-mist-300 hover:bg-ink-850 hover:text-mist-100"
                          }`}
                        >
                          {/* Timestamp pill / Play icon */}
                          <div
                            className={`flex shrink-0 items-center justify-center rounded px-2 py-1 font-mono text-[11px] font-semibold transition-colors ${
                              isCurrent
                                ? "bg-gradient-to-br from-brand-500 to-amber-500 text-white shadow-sm"
                                : "bg-ink-800 text-mist-300 group-hover:bg-brand-500/20 group-hover:text-amber-600 dark:group-hover:text-amber-400"
                            }`}
                          >
                            {isCurrent ? (
                              <Play className="h-3 w-3 fill-current" />
                            ) : (
                              formatClock(scene.start, false)
                            )}
                          </div>

                          <div className="min-w-0 flex-1">
                            <div className="flex items-center justify-between gap-2">
                              <span
                                className={`truncate text-xs font-semibold ${
                                  isCurrent ? "text-mist-50" : "text-mist-200"
                                }`}
                              >
                                {scene.title}
                              </span>
                              <span className="shrink-0 font-mono text-[10px] text-mist-500">
                                {scene.duration.toFixed(0)}s
                              </span>
                            </div>

                            <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-mist-400">
                              <span className="rounded bg-ink-800/80 px-1 py-0.2">
                                {sceneKindLabel(scene.kind, lang)}
                              </span>
                              {scene.narration ? (
                                <>
                                  <span>·</span>
                                  <span className="truncate italic text-mist-500">
                                    <InlineText text={scene.narration} />
                                  </span>
                                </>
                              ) : null}
                            </div>
                          </div>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })
        ) : (
          /* Full transcript tab with clickable scene jumps */
          <div className="space-y-3 p-1">
            {lesson.scenes.map((scene, idx) => {
              const isCurrent = idx === activeScene;
              return (
                <div
                  key={scene.id}
                  onClick={() => timebase.seek(scene.start)}
                  className={`cursor-pointer rounded-lg p-2.5 transition-colors ${
                    isCurrent
                      ? "border-l-4 border-amber-400 bg-brand-950/40"
                      : "border-l-4 border-transparent hover:bg-ink-850"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span
                      className={`rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold ${
                        isCurrent
                          ? "bg-gradient-to-br from-brand-500 to-amber-500 text-white shadow-sm"
                          : "bg-ink-800 text-mist-400"
                      }`}
                    >
                      {formatClock(scene.start, false)}
                    </span>
                    <span
                      className={`text-xs font-semibold ${
                        isCurrent ? "text-mist-50" : "text-mist-200"
                      }`}
                    >
                      <InlineText text={scene.title} />
                    </span>
                  </div>
                  {scene.narration && (
                    <p className="mt-1.5 text-xs italic leading-relaxed text-mist-300">
                      <InlineText text={scene.narration} />
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
      </div>
    </div>
  );
}
