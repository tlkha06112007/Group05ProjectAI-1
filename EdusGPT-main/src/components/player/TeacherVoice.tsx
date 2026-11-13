"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { Volume2, VolumeX, LoaderCircle } from "lucide-react";
import type { Timebase } from "@/hooks/useTimebase";
import { sceneIndexAt, type Lesson } from "@/lib/lesson/types";
import { approximateWords, decodeWordMarks, type WordMark } from "@/lib/karaoke";
import { useCopy, useLang } from "@/i18n/provider";

const COPY = {
  en: {
    voiceBlocked: "The browser blocked playback. Press again to listen.",
    voiceServerFallback: "The server could not read this. Using the browser voice.",
    voiceTurnOff: "Turn off the AI teacher voice",
    voiceTurnOn: "Turn on the AI teacher voice (TTS)",
    voiceChipLabel: "Voice:",
    voicePreparing: "preparing",
    voiceTeaching: "Teaching",
    voiceOn: "On",
    voiceOff: "Off",
    voiceSelectLabel: "Choose narration voice",
    voiceSelectTitle: "Narration voice",
  },
  vi: {
    voiceBlocked: "Trình duyệt chặn phát. Bấm lại để nghe.",
    voiceServerFallback: "Máy chủ không đọc được. Dùng giọng trình duyệt.",
    voiceTurnOff: "Tắt giọng đọc giáo viên AI",
    voiceTurnOn: "Bật giọng đọc giáo viên AI (TTS)",
    voiceChipLabel: "Giọng Việt:",
    voicePreparing: "đang chuẩn bị",
    voiceTeaching: "Đang giảng bài",
    voiceOn: "Bật",
    voiceOff: "Tắt",
    voiceSelectLabel: "Chọn giọng đọc tiếng Việt",
    voiceSelectTitle: "Giọng đọc tiếng Việt",
  },
};

interface TeacherVoiceProps {
  lesson: Lesson;
  timebase: Timebase;
  activeSceneIndex: number;
  /**
   * Reports which slide is being spoken and whether its audio is still being
   * fetched. A presenter needs to know the voice is one slide behind, not
   * silent — otherwise a gap in the audio looks like a broken app.
   */
  onVoiceState?: (state: VoiceState) => void;
  /**
   * True while the A→B loop is on.
   *
   * The silence skip below must stand down then: the loop owns the playhead
   * inside its region, and jumping to a scene boundary would cut the loop's
   * tail off on every pass.
   */
  loopEnabled?: boolean;
  /**
   * What the voice is doing right now, for the running subtitle: the playback
   * position within the slide it is reading, plus the word timings for a scene.
   *
   * The voice is a separate <audio> element, so the slide's own playhead knows
   * nothing about how far the reading has got. Without this the highlight would
   * have to be guessed from the slide clock, and it drifts the moment the two
   * fall out of step.
   */
  onNarration?: (update: NarrationUpdate) => void;
  onVoiceChange?: (voice: string) => void;
  /**
   * Called once a scene's real TTS audio length is measured so the lesson
   * timeline can match the audio 1:1 instead of cutting off or drifting.
   */
  onSceneDuration?: (sceneIndex: number, audioSeconds: number) => void;
}

/** One publication on the narration channel. */
export type NarrationUpdate =
  /** The voice is now reading this scene, and is this far into it. */
  | { type: "position"; sceneIndex: number; time: number }
  /** Timings arrived for a scene, fetched or served from cache. */
  | { type: "words"; sceneIndex: number; words: WordMark[] }
  /** Nothing is being read. */
  | { type: "stop" };

/** One slide's narration, as the running subtitle needs to see it. */
export interface NarrationProgress {
  /** Index into `lesson.scenes`. */
  sceneIndex: number;
  /** Seconds into this slide's narration. */
  time: number;
  words: WordMark[];
}

export interface VoiceState {
  status: "idle" | "preparing" | "speaking";
  /** Index into `lesson.scenes`, or null when nothing is being read. */
  sceneIndex: number | null;
  sceneTitle: string;
  voice: string;
}

interface VoiceOption {
  id: string;
  label: string;
}

const FALLBACK_VOICES: VoiceOption[] = [
  { id: "vi-VN-HoaiMyNeural", label: "Hoài My (nữ)" },
  { id: "vi-VN-HoaiMyNeural#cham", label: "Hoài My chậm (nữ)" },
  { id: "vi-VN-HoaiMyNeural#cao", label: "Hoài My cao (nữ)" },
  { id: "vi-VN-NamMinhNeural", label: "Nam Minh (nam)" },
  { id: "vi-VN-NamMinhNeural#tram", label: "Nam Minh trầm (nam)" },
  { id: "vi-VN-NamMinhNeural#cham", label: "Nam Minh chậm (nam)" },
];

function formatVoiceLabel(label: string, lang: "en" | "vi"): string {
  if (lang === "vi") return label;
  return label
    .replace(/\(nữ\)/g, "(female)")
    .replace(/\(nam\)/g, "(male)")
    .replace(/chậm/g, "slow")
    .replace(/cao/g, "high")
    .replace(/trầm/g, "deep");
}

/** One slide's synthesised narration, kept so it is never fetched twice. */
interface CachedNarration {
  url: string;
  /** Per-word timings, empty when the server sent no boundaries. */
  words: WordMark[];
  /** Exact measured duration of the audio clip in seconds. */
  duration: number;
}

/** Measures the real media duration of a cached audio blob URL. */
function measureAudioDuration(url: string): Promise<number> {
  return new Promise((resolve) => {
    const probe = new Audio(url);
    let settled = false;
    const finish = (seconds: number) => {
      if (settled) return;
      settled = true;
      probe.removeAttribute("src");
      probe.load();
      resolve(Number.isFinite(seconds) && seconds > 0 ? seconds : 0);
    };
    probe.addEventListener("loadedmetadata", () => finish(probe.duration), { once: true });
    probe.addEventListener("error", () => finish(0), { once: true });
    window.setTimeout(() => finish(0), 5000);
  });
}

/**
 * Returns the timeline point just before a slide begins fading into the next
 * scene, where playback holds until the current slide's narration completes.
 */
function sceneSpeechHold(lesson: Lesson, sceneIndex: number): number | null {
  const scene = lesson.scenes[sceneIndex];
  if (!scene) return null;
  const fade = Math.min(2, scene.duration / 2);
  const isLast = sceneIndex >= lesson.scenes.length - 1;
  const margin = isLast ? 0.05 : fade + 0.05;
  return scene.start + Math.max(0.2, scene.duration - margin);
}

/**
 * Browser speech is the safety net when the server cannot reach the voice service.
 *
 * The browser reports boundary events but no timings and no total duration, so
 * there is nothing to scale a highlight against. Rather than leave the subtitle
 * dead on this path, the caller is told the scene's length and lays an even
 * sweep over it — approximate, and marked as such at the call site, but a rough
 * guide beats a frozen line.
 */
function speakWithBrowser(
  text: string,
  language: string | undefined,
  onDone: () => void,
  onError: () => void,
): void {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) {
    onError();
    return;
  }
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  const isEn = language === "en";
  utterance.lang = isEn ? "en-US" : "vi-VN";
  utterance.rate = 1.05;
  const prefix = isEn ? "en" : "vi";
  const matched = window.speechSynthesis
    .getVoices()
    .find((v) => v.lang.toLowerCase().startsWith(prefix));
  if (matched) utterance.voice = matched;
  utterance.onend = onDone;
  utterance.onerror = onError;
  window.speechSynthesis.speak(utterance);
}

export function TeacherVoice({
  lesson,
  timebase,
  activeSceneIndex,
  onVoiceState,
  loopEnabled = false,
  onNarration,
  onVoiceChange,
  onSceneDuration,
}: TeacherVoiceProps) {
  const t = useCopy(COPY);
  const currentLang = useLang();
  const [enabled, setEnabled] = useState(true);
  const [speaking, setSpeaking] = useState(false);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [voices, setVoices] = useState<VoiceOption[]>(FALLBACK_VOICES);
  // Starts on the voice the studio picked, so a deck opens speaking in the voice
  // its author chose by ear rather than in whatever the component defaults to.
  // The voice list arrives a moment later and replaces the fallback labels; if
  // the stored id is not among them, the server's own default takes over.
  const [voice, setVoice] = useState(lesson.voice ?? FALLBACK_VOICES[0].id);
  const voiceRef = useRef(voice);
  voiceRef.current = voice;

  const lessonRef = useRef(lesson);
  lessonRef.current = lesson;
  const timebaseRef = useRef(timebase);
  timebaseRef.current = timebase;

  const lastSpokenSceneRef = useRef<number | null>(null);
  const lastSeenTimeRef = useRef<number | null>(null);
  const lastSeekSeqRef = useRef<number | null>(null);
  const audioFinishedSceneRef = useRef<number | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const activeAudioRef = useRef<{
    audio: HTMLAudioElement;
    sceneIndex: number;
    duration: number;
    seekApplied: boolean;
  } | null>(null);

  const rateRef = useRef(timebase.rate);
  const volumeRef = useRef(timebase.volume);
  const mutedRef = useRef(timebase.muted);
  rateRef.current = timebase.rate;
  volumeRef.current = timebase.volume;
  mutedRef.current = timebase.muted;
  const abortRef = useRef<AbortController | null>(null);
  /** sceneId|voice -> synthesised narration. Re-reading must not re-synthesise. */
  const cacheRef = useRef(new Map<string, CachedNarration>());
  /** Prefetches already in flight, so warming never doubles up on one slide. */
  const warmingRef = useRef(new Set<string>());
  /** rAF handle driving the subtitle highlight from the audio's own clock. */
  const trackFrameRef = useRef<number | null>(null);
  /** Latest narration & duration callbacks, so loops read them without re-binding. */
  const narrationRef = useRef(onNarration);
  narrationRef.current = onNarration;
  const onSceneDurationRef = useRef(onSceneDuration);
  onSceneDurationRef.current = onSceneDuration;

  /**
   * Pushes the audio's playback position out for the running subtitle.
   */
  const stopTracking = useCallback(() => {
    if (trackFrameRef.current !== null) {
      cancelAnimationFrame(trackFrameRef.current);
      trackFrameRef.current = null;
    }
    narrationRef.current?.({ type: "stop" });
  }, []);

  const track = useCallback((audio: HTMLAudioElement, sceneIndex: number) => {
    if (trackFrameRef.current !== null) cancelAnimationFrame(trackFrameRef.current);
    const tick = () => {
      narrationRef.current?.({ type: "position", sceneIndex, time: audio.currentTime });
      trackFrameRef.current = requestAnimationFrame(tick);
    };
    trackFrameRef.current = requestAnimationFrame(tick);
  }, []);

  /**
   * Rides along on a lookahead fetch for the same slide+voice, if one is already
   * running, instead of synthesising twice.
   *
   * Returns null when there is nothing to ride (warmer failed or gave up), and
   * the caller falls through to its own fetch. The warmer always removes its
   * key when it settles, so waiting on the key alone can never hang past the
   * timeout — and a switch aborts through the same signal.
   */
  const waitForWarm = useCallback(
    async (key: string, signal: AbortSignal): Promise<CachedNarration | null> => {
      const start = Date.now();
      for (;;) {
        if (signal.aborted) return null;
        const hit = cacheRef.current.get(key);
        if (hit) return hit;
        // The warmer finished without caching: it failed, and waiting longer
        // only delays the retry that actually reports the failure.
        if (!warmingRef.current.has(key)) return null;
        if (Date.now() - start > 150_000) return null;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    },
    [],
  );

  useEffect(() => {
    fetch("/api/tts")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!data?.voices?.length) return;
        setVoices(data.voices);
        // A stored voice from an older build, or one the service has since
        // retired, would be sent to the API and come back as a request it
        // rejects. Falling back to the server's own default keeps the deck
        // audible rather than silent with a notice nobody asked for.
        setVoice((current) =>
          data.voices.some((entry: VoiceOption) => entry.id === current)
            ? current
            : (data.default ?? FALLBACK_VOICES[0].id),
        );
      })
      .catch(() => {
        /* keep the built-in list; the server is optional */
      });
  }, []);

  useEffect(() => {
    const cache = cacheRef.current;
    const urls = Array.from(cache.values()).map((entry) => entry.url);
    return () => {
      stopTracking();
      abortRef.current?.abort();
      audioRef.current?.pause();
      urls.forEach((url) => URL.revokeObjectURL(url));
      cache.clear();
    };
  }, []);

  const browserSweepRef = useRef<number | null>(null);

  const stop = useCallback((reportVoice?: string) => {
    abortRef.current?.abort();
    abortRef.current = null;
    if (browserSweepRef.current !== null) {
      window.clearInterval(browserSweepRef.current);
      browserSweepRef.current = null;
    }
    const tb = timebaseRef.current;
    tb.bufferingRef.current = false;
    tb.speechHoldRef.current = null;
    tb.masterClockRef.current = null;
    activeAudioRef.current = null;
    audioRef.current?.pause();
    audioRef.current = null;
    stopTracking();
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
    setSpeaking(false);
    setLoading(false);
    // The voice that is actually done, not the one from the closure: after a
    // switch the stale id would flash on the chip until the new fetch lands.
    onVoiceState?.({ status: "idle", sceneIndex: null, sceneTitle: "", voice: reportVoice ?? voice });
  }, [onVoiceState, stopTracking, voice]);

  /** Hands a decoded narration to the player and locks it 1:1 to the timeline. */
  const play = useCallback(
    (
      entry: CachedNarration,
      sceneIndex: number,
      sceneTitle: string,
      text: string,
      /** Seconds into the slide to begin at; 0 for ordinary forward playback. */
      startAt = 0,
    ) => {
      const tb = timebaseRef.current;
      if (!tb.playing) return;

      const audio = new Audio(entry.url);
      audioRef.current = audio;
      const meta = {
        audio,
        sceneIndex,
        duration: entry.duration,
        seekApplied: startAt <= 0,
      };
      activeAudioRef.current = meta;

      // Exact 1:1 playback speed with the timeline rate (no artificial speed warp).
      audio.playbackRate = rateRef.current;
      if ("preservesPitch" in audio) audio.preservesPitch = true;
      audio.volume = volumeRef.current;
      audio.muted = mutedRef.current;

      // Arm the speech completion gate so the slide NEVER advances until the script ends.
      tb.speechHoldRef.current = sceneSpeechHold(lessonRef.current, sceneIndex);
      tb.bufferingRef.current = true;

      // Publish word timings immediately (or generate approximate ones once duration loads).
      if (entry.words.length > 0) {
        narrationRef.current?.({ type: "words", sceneIndex, words: entry.words });
      } else if (entry.duration > 0) {
        narrationRef.current?.({
          type: "words",
          sceneIndex,
          words: approximateWords(text, entry.duration),
        });
      }

      if (entry.duration > 0) {
        onSceneDurationRef.current?.(sceneIndex, entry.duration);
      }

      // Lock the timebase playhead to this audio element's hardware clock.
      tb.masterClockRef.current = () => {
        const cur = activeAudioRef.current;
        if (!cur || cur.audio !== audio || !cur.seekApplied) return null;
        if (audio.paused || audio.ended || audio.seeking) return null;
        const currentScene = lessonRef.current.scenes[cur.sceneIndex];
        if (!currentScene) return null;
        return currentScene.start + audio.currentTime;
      };

      const applyStartSeek = () => {
        if (activeAudioRef.current?.audio !== audio) return;
        const clipLen =
          Number.isFinite(audio.duration) && audio.duration > 0
            ? audio.duration
            : entry.duration;
        if (clipLen > 0) {
          meta.duration = clipLen;
          if (entry.duration <= 0) {
            entry.duration = clipLen;
            onSceneDurationRef.current?.(sceneIndex, clipLen);
            if (entry.words.length === 0) {
              narrationRef.current?.({
                type: "words",
                sceneIndex,
                words: approximateWords(text, clipLen),
              });
            }
          }
          tb.speechHoldRef.current = sceneSpeechHold(lessonRef.current, sceneIndex);
        }
        if (startAt > 0) {
          const maxSeek = clipLen > 0 ? Math.max(0, clipLen - 0.05) : startAt;
          audio.currentTime = Math.min(startAt, maxSeek);
        }
        meta.seekApplied = true;
      };

      if (audio.readyState >= 1) applyStartSeek();
      else audio.addEventListener("loadedmetadata", applyStartSeek, { once: true });

      const unbufferIfReady = () => {
        if (activeAudioRef.current?.audio !== audio) return;
        if (meta.seekApplied && !audio.paused && !audio.seeking) {
          tb.bufferingRef.current = false;
        }
      };

      audio.onplaying = () => {
        if (activeAudioRef.current?.audio !== audio) return;
        unbufferIfReady();
        setLoading(false);
        setSpeaking(true);
        track(audio, sceneIndex);
        onVoiceState?.({ status: "speaking", sceneIndex, sceneTitle, voice });
      };
      audio.onwaiting = () => {
        if (activeAudioRef.current?.audio !== audio) return;
        tb.bufferingRef.current = true;
      };
      audio.onseeked = () => {
        unbufferIfReady();
      };
      audio.onended = () => {
        if (activeAudioRef.current?.audio !== audio) return;
        activeAudioRef.current = null;
        audioRef.current = null;
        audioFinishedSceneRef.current = sceneIndex;
        tb.masterClockRef.current = null;
        tb.bufferingRef.current = false;
        tb.speechHoldRef.current = null;
        setSpeaking(false);
        setLoading(false);
        stopTracking();
        onVoiceState?.({ status: "idle", sceneIndex: null, sceneTitle: "", voice });

        // Snap cleanly to the end of speech (the start of the outgoing 2s fade)
        // if the scene still had residual silence left over.
        if (!loopEnabled) {
          const latestScene = lessonRef.current.scenes[sceneIndex];
          const sceneEnd = latestScene ? latestScene.start + latestScene.duration : Number.POSITIVE_INFINITY;
          const now = tb.timeRef.current;
          const total = tb.duration;
          if (
            latestScene &&
            sceneEnd - now > 2.5 &&
            sceneEnd < total - 0.3 &&
            now < sceneEnd
          ) {
            const target = sceneEnd - 2;
            lastSeenTimeRef.current = target;
            tb.seek(target);
          }
        }
      };
      audio.onerror = () => {
        if (activeAudioRef.current?.audio !== audio) return;
        activeAudioRef.current = null;
        tb.masterClockRef.current = null;
        tb.bufferingRef.current = false;
        tb.speechHoldRef.current = null;
        setSpeaking(false);
        setLoading(false);
        stopTracking();
      };

      void audio.play().catch(() => {
        if (activeAudioRef.current?.audio !== audio) return;
        tb.bufferingRef.current = false;
        tb.speechHoldRef.current = null;
        tb.masterClockRef.current = null;
        setNotice(t.voiceBlocked);
      });
    },
    // `t` is the active dictionary object itself, so its identity only changes
    // with the language — naming it here cannot restart the reader per frame.
    [onVoiceState, stopTracking, track, voice, t, loopEnabled],
  );

  const speak = useCallback(
    async (
      text: string,
      sceneId: string,
      sceneIndex: number,
      sceneTitle: string,
      sceneSeconds: number,
      startAt = 0,
      explicitVoice?: string,
    ) => {
      stop();
      const tb = timebaseRef.current;
      const voiceToUse = explicitVoice || voiceRef.current;
      const key = `${sceneId}|${voiceToUse}`;
      const cached = cacheRef.current.get(key);
      const controller = new AbortController();
      abortRef.current = controller;

      if (cached) {
        play(cached, sceneIndex, sceneTitle, text, startAt);
        return;
      }

      // Hold playback in sync while fetching/warming so video doesn't run ahead silently.
      tb.bufferingRef.current = true;
      tb.speechHoldRef.current = sceneSpeechHold(lessonRef.current, sceneIndex);

      if (warmingRef.current.has(key)) {
        setLoading(true);
        onVoiceState?.({ status: "preparing", sceneIndex, sceneTitle, voice: voiceToUse });
        const rode = await waitForWarm(key, controller.signal);
        if (controller.signal.aborted || !timebaseRef.current.playing) {
          timebaseRef.current.bufferingRef.current = false;
          timebaseRef.current.speechHoldRef.current = null;
          return;
        }
        if (rode) {
          const curScene = lessonRef.current.scenes[sceneIndex];
          const freshOffset = curScene
            ? Math.max(0, timebaseRef.current.timeRef.current - curScene.start)
            : startAt;
          play(rode, sceneIndex, sceneTitle, text, freshOffset <= 0.2 ? 0 : freshOffset);
          return;
        }
      }

      warmingRef.current.add(key);
      const release = () => warmingRef.current.delete(key);

      setLoading(true);
      onVoiceState?.({ status: "preparing", sceneIndex, sceneTitle, voice: voiceToUse });
      try {
        const response = await fetch("/api/tts", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text, voice: voiceToUse }),
          signal: controller.signal,
        });
        if (controller.signal.aborted) {
          release();
          timebaseRef.current.bufferingRef.current = false;
          timebaseRef.current.speechHoldRef.current = null;
          return;
        }

        if (!response.ok) {
          const detail = (await response.json().catch(() => null)) as { error?: string } | null;
          throw new Error(detail?.error ?? `HTTP ${response.status}`);
        }

        const words = await decodeWordMarks(response.headers.get("x-tts-words"));
        const blob = await response.blob();
        if (controller.signal.aborted) {
          release();
          timebaseRef.current.bufferingRef.current = false;
          timebaseRef.current.speechHoldRef.current = null;
          return;
        }
        const url = URL.createObjectURL(blob);
        const wordEnd = words.length > 0 ? words[words.length - 1].end : 0;
        const mediaDuration = await measureAudioDuration(url);
        const duration = Math.max(wordEnd, mediaDuration);
        if (controller.signal.aborted) {
          URL.revokeObjectURL(url);
          release();
          timebaseRef.current.bufferingRef.current = false;
          timebaseRef.current.speechHoldRef.current = null;
          return;
        }
        const entry: CachedNarration = { url, words, duration };
        cacheRef.current.set(key, entry);
        release();
        if (!timebaseRef.current.playing) {
          timebaseRef.current.bufferingRef.current = false;
          timebaseRef.current.speechHoldRef.current = null;
          return;
        }
        const curScene = lessonRef.current.scenes[sceneIndex];
        const freshOffset = curScene
          ? Math.max(0, timebaseRef.current.timeRef.current - curScene.start)
          : startAt;
        play(entry, sceneIndex, sceneTitle, text, freshOffset <= 0.2 ? 0 : freshOffset);
      } catch (error) {
        release();
        if (controller.signal.aborted) return;
        setLoading(false);
        timebaseRef.current.bufferingRef.current = false;
        if (error instanceof Error && error.name === "AbortError") {
          timebaseRef.current.speechHoldRef.current = null;
          return;
        }
        // Fallback to browser synthesis while still keeping the speech-completion gate armed.
        setNotice(t.voiceServerFallback);
        const guess = approximateWords(text, sceneSeconds);
        narrationRef.current?.({ type: "words", sceneIndex, words: guess });
        const startedAt = performance.now() - startAt * 1000;
        if (browserSweepRef.current !== null) window.clearInterval(browserSweepRef.current);
        browserSweepRef.current = window.setInterval(() => {
          narrationRef.current?.({
            type: "position",
            sceneIndex,
            time: ((performance.now() - startedAt) / 1000) * rateRef.current,
          });
        }, 120);
        setSpeaking(true);
        speakWithBrowser(
          text,
          lessonRef.current.language,
          () => {
            if (browserSweepRef.current !== null) {
              window.clearInterval(browserSweepRef.current);
              browserSweepRef.current = null;
            }
            audioFinishedSceneRef.current = sceneIndex;
            timebaseRef.current.speechHoldRef.current = null;
            setSpeaking(false);
            stopTracking();
          },
          () => {
            if (browserSweepRef.current !== null) {
              window.clearInterval(browserSweepRef.current);
              browserSweepRef.current = null;
            }
            timebaseRef.current.speechHoldRef.current = null;
            setSpeaking(false);
            stopTracking();
          },
        );
      }
    },
    [onVoiceState, play, stop, stopTracking, t, waitForWarm],
  );

  /**
   * Fetches one slide's narration into the cache without playing it, and
   * immediately syncs its word marks and duration to the timeline.
   */
  const warmScene = useCallback(
    (index: number, explicitVoice?: string) => {
      const scene = lesson.scenes[index];
      if (!scene?.narration) return;
      const voiceToUse = explicitVoice || voiceRef.current;
      const key = `${scene.id}|${voiceToUse}`;
      const existing = cacheRef.current.get(key);
      if (existing) {
        if (voiceToUse === voiceRef.current) {
          if (existing.words.length > 0) {
            narrationRef.current?.({ type: "words", sceneIndex: index, words: existing.words });
          }
          if (existing.duration > 0) {
            onSceneDurationRef.current?.(index, existing.duration);
          }
        }
        return;
      }
      if (warmingRef.current.has(key)) return;

      warmingRef.current.add(key);
      fetch("/api/tts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: scene.narration, voice: voiceToUse }),
      })
        .then(async (response) => {
          if (response.ok) {
            const words = await decodeWordMarks(response.headers.get("x-tts-words"));
            const url = URL.createObjectURL(await response.blob());
            const wordEnd = words.length > 0 ? words[words.length - 1].end : 0;
            const mediaDuration = await measureAudioDuration(url);
            const duration = Math.max(wordEnd, mediaDuration);
            cacheRef.current.set(key, { url, words, duration });
            if (voiceToUse === voiceRef.current) {
              if (words.length > 0) {
                narrationRef.current?.({ type: "words", sceneIndex: index, words });
              } else if (duration > 0) {
                narrationRef.current?.({
                  type: "words",
                  sceneIndex: index,
                  words: approximateWords(scene.narration ?? "", duration),
                });
              }
              if (duration > 0) {
                onSceneDurationRef.current?.(index, duration);
              }
            }
          }
        })
        .catch(() => {
          // Warming is best effort; the real request retries on its own.
        })
        .finally(() => warmingRef.current.delete(key));
    },
    [lesson.scenes],
  );

  /**
   * Prefetches the current and next slide as soon as the lesson loads so their
   * durations and word timings sync before playback even begins.
   */
  useEffect(() => {
    if (!enabled) return;
    warmScene(activeSceneIndex);
    warmScene(activeSceneIndex + 1);
  }, [activeSceneIndex, enabled, lesson.scenes, voice, warmScene]);

  /**
   * Warms the next two slides' audio while the current one is playing.
   *
   * Synthesis is seconds of latency; without this a presenter reaches the next
   * slide and hears nothing. Two slides instead of one because a short slide
   * can finish before the single lookahead lands. Cached hits are free, and
   * misses only move work earlier rather than adding to it.
   */
  useEffect(() => {
    if (!enabled || !timebase.playing) return;
    warmScene(activeSceneIndex + 1);
    warmScene(activeSceneIndex + 2);
  }, [activeSceneIndex, enabled, lesson.scenes, timebase.playing, voice, warmScene]);

  /**
   * Everything the playhead subscription needs, published after `speak` exists.
   *
   * Kept in a ref so the subscription is not rebuilt when a parent passes a new
   * callback identity down — see the note on the sync effect for why that would
   * loop.
   */
  const liveRef = useRef({
    lesson,
    speakNow: speak,
  });
  liveRef.current = { lesson, speakNow: speak };

  /**
   * Synchronizes the AI teacher voice 1:1 with the single video timeline.
   *
   * - Entering a slide or starting playback calls `speakNow` (holding the
   *   clock via `bufferingRef` while TTS fetches so audio and video never drift).
   * - Seeking within the same slide seeks `<audio>.currentTime` in place
   *   with zero audio stutter or element recreation.
   * - `speechHoldRef` prevents automatic transition to the next slide until the
   *   current slide's script finishes speaking completely.
   */
  useEffect(() => {
    const tb = timebaseRef.current;
    if (!enabled) {
      lastSpokenSceneRef.current = null;
      lastSeenTimeRef.current = null;
      lastSeekSeqRef.current = null;
      audioFinishedSceneRef.current = null;
      return;
    }
    if (!tb.playing) {
      stop();
      lastSpokenSceneRef.current = null;
      lastSeenTimeRef.current = null;
      lastSeekSeqRef.current = null;
      audioFinishedSceneRef.current = null;
      return;
    }

    return tb.subscribe((time, meta) => {
      const { lesson: currentLesson, speakNow } = liveRef.current;
      const sceneIndex = sceneIndexAt(currentLesson, time);
      const scene = currentLesson.scenes[sceneIndex];

      lastSeenTimeRef.current = time;
      const userSeeked =
        lastSeekSeqRef.current !== null && meta.seekSeq !== lastSeekSeqRef.current;
      lastSeekSeqRef.current = meta.seekSeq;
      const isNewScene = lastSpokenSceneRef.current !== sceneIndex;
      const firstRun = lastSpokenSceneRef.current === null;

      if (!scene?.narration?.trim()) {
        if (activeAudioRef.current || isNewScene) {
          stop();
        }
        lastSpokenSceneRef.current = sceneIndex;
        audioFinishedSceneRef.current = null;
        tb.speechHoldRef.current = null;
        tb.bufferingRef.current = false;
        return;
      }

      const offset = Math.max(0, time - scene.start);

      // Once narration finished on this scene, stay quiet during the outgoing 2s fade
      // unless the user actively scrubbed back into the slide.
      if (!userSeeked && !isNewScene && audioFinishedSceneRef.current === sceneIndex) {
        return;
      }

      if (!firstRun && !isNewScene && !userSeeked) {
        return;
      }

      const curAudio = activeAudioRef.current;
      const key = `${scene.id}|${voiceRef.current}`;
      const cached = cacheRef.current.get(key);

      // Smooth in-place seek inside the same slide when audio is already loaded.
      if (
        userSeeked &&
        !isNewScene &&
        curAudio &&
        curAudio.sceneIndex === sceneIndex &&
        cached
      ) {
        const clipLen = cached.duration > 0 ? cached.duration : curAudio.duration;
        if (clipLen > 0 && offset >= clipLen - 0.08) {
          audioFinishedSceneRef.current = sceneIndex;
          stop();
          narrationRef.current?.({ type: "position", sceneIndex, time: offset });
          return;
        }
        audioFinishedSceneRef.current = null;
        tb.speechHoldRef.current = sceneSpeechHold(currentLesson, sceneIndex);
        const maxSeek =
          Number.isFinite(curAudio.audio.duration) && curAudio.audio.duration > 0
            ? Math.max(0, curAudio.audio.duration - 0.05)
            : offset;
        curAudio.audio.currentTime = Math.min(offset, maxSeek);
        narrationRef.current?.({ type: "position", sceneIndex, time: offset });
        if (curAudio.audio.paused && tb.playing) {
          void curAudio.audio.play().catch(() => setNotice(t.voiceBlocked));
        }
        return;
      }

      // If user scrubbed into the trailing fade zone of a scene whose audio duration
      // is already known, don't start re-speaking the tail.
      if (cached && cached.duration > 0 && offset >= cached.duration - 0.08) {
        if (activeAudioRef.current) stop();
        lastSpokenSceneRef.current = sceneIndex;
        audioFinishedSceneRef.current = sceneIndex;
        tb.speechHoldRef.current = null;
        tb.bufferingRef.current = false;
        narrationRef.current?.({ type: "position", sceneIndex, time: offset });
        return;
      }

      lastSpokenSceneRef.current = sceneIndex;
      audioFinishedSceneRef.current = null;
      const startAt =
        offset <= 0.2 || (!firstRun && isNewScene && !userSeeked) ? 0 : offset;
      void speakNow(
        scene.narration,
        scene.id,
        sceneIndex,
        scene.title,
        scene.duration,
        startAt,
      );
    });
  }, [enabled, stop, timebase.playing, t]);

  // Rate or volume changed mid-sentence: update the active audio element 1:1.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.playbackRate !== timebase.rate) audio.playbackRate = timebase.rate;
    if (audio.volume !== timebase.volume) audio.volume = timebase.volume;
    if (audio.muted !== timebase.muted) audio.muted = timebase.muted;
  }, [timebase.rate, timebase.volume, timebase.muted]);

  // Keep speechHoldRef updated when onSceneDuration adjusts scene durations mid-flight.
  useEffect(() => {
    const cur = activeAudioRef.current;
    if (cur && timebaseRef.current.playing) {
      timebaseRef.current.speechHoldRef.current = sceneSpeechHold(lesson, cur.sceneIndex);
    }
  }, [lesson]);

  // A different lesson brings its own voice (the one picked in Studio).
  useEffect(() => {
    if (lesson.voice) {
      setVoice(lesson.voice);
      lastSpokenSceneRef.current = null;
      lastSeenTimeRef.current = null;
      lastSeekSeqRef.current = null;
      audioFinishedSceneRef.current = null;
      setNotice(null);
      stop();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lesson.id]);

  // Switching voice immediately stops old audio and starts new voice
  const changeVoice = (next: string) => {
    voiceRef.current = next;
    setVoice(next);
    onVoiceChange?.(next);
    lastSpokenSceneRef.current = null;
    lastSeenTimeRef.current = null;
    lastSeekSeqRef.current = null;
    audioFinishedSceneRef.current = null;
    setNotice(null);
    stop(next);

    // Pre-warm the current and next scenes with the newly selected voice
    warmScene(activeSceneIndex, next);
    warmScene(activeSceneIndex + 1, next);

    // If deck is currently playing, immediately start reading the current scene with the new voice
    if (timebase.playing) {
      const scene = lesson.scenes[activeSceneIndex];
      if (scene?.narration) {
        lastSpokenSceneRef.current = activeSceneIndex;
        const offset = Math.max(0, timebase.timeRef.current - scene.start);
        const startAt = offset <= 0.2 ? 0 : offset;
        void speak(
          scene.narration,
          scene.id,
          activeSceneIndex,
          scene.title,
          scene.duration,
          startAt,
          next,
        );
      }
    }
  };

  const toggle = () => {
    if (enabled) stop();
    else {
      lastSpokenSceneRef.current = null;
      lastSeenTimeRef.current = null;
      lastSeekSeqRef.current = null;
      audioFinishedSceneRef.current = null;
    }
    setEnabled(!enabled);
  };

  return (
    /* min-w-0 + flex-wrap: at 390px this group was the one thing in the
       toolbar that could not wrap, and it pushed the whole page 19px wide
       (the export group next to it already wrapped this way). */
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
      <button
        type="button"
        onClick={toggle}
        className={`chip transition-colors ${
          enabled
            ? "border-brand-500 bg-brand-500/15 text-brand-100"
            : "border-ink-700 bg-ink-900/60 text-mist-500 hover:text-mist-300"
        }`}
        title={enabled ? t.voiceTurnOff : t.voiceTurnOn}
      >
        {loading ? (
          <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
        ) : enabled ? (
          <Volume2 className={`h-3.5 w-3.5 ${speaking ? "animate-pulse text-gold-300" : ""}`} />
        ) : (
          <VolumeX className="h-3.5 w-3.5" />
        )}
        <span>
          {t.voiceChipLabel}{" "}
          {loading ? t.voicePreparing : speaking ? t.voiceTeaching : enabled ? t.voiceOn : t.voiceOff}
        </span>
      </button>

      {enabled && (
        <>
          <label className="sr-only" htmlFor="tts-voice">
            {t.voiceSelectLabel}
          </label>
          <select
            id="tts-voice"
            value={voice}
            onChange={(e) => changeVoice(e.target.value)}
            title={notice ?? t.voiceSelectTitle}
            /* A native select sizes to its longest option; capped so one long
               voice name cannot widen the toolbar past the screen again. */
            className="chip max-w-full border-ink-700 bg-ink-900/60 text-mist-300 hover:text-mist-100"
          >
            {voices.map((v) => (
              <option key={v.id} value={v.id}>
                {formatVoiceLabel(v.label, currentLang)}
              </option>
            ))}
          </select>
        </>
      )}
    </div>
  );
}
