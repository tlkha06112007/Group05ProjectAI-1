"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  activeWordIndex,
  alignSentences,
  buildTrack,
  type AlignedSentence,
  type KaraokeTrack,
  type NarrationChannel,
} from "@/lib/karaoke";
import { InlineText } from "./InlineText";

/**
 * The narration for one slide, shown one sentence at a time.
 *
 * A slide's narration is a paragraph, and a caption that shows a paragraph is not
 * a caption: the reader gets the whole thing at once and has to work out which
 * clause the voice is on. So the text is split into sentences and the line on
 * screen is whichever sentence the voice is currently inside — read to the end,
 * then the next one. Two sentences are on screen only for the moment of the
 * handover, so a hand-off does not read as a flicker.
 *
 * Three visual states, because a line that only lights the current word is hard
 * to read: the eye needs the words already spoken to follow the sentence, and the
 * words not yet reached to know what is coming.
 *
 * The playhead is read from a ref inside this component's own rAF loop, never
 * from props. A slide holds a WebGL simulation and an interactive quiz; a state
 * update sixty times a second would re-render all of it and undo the work the
 * GSAP timeline does to keep playback off React.
 */
export function KaraokeSubtitle({
  text,
  sceneIndex,
  channel,
  floatingCard = false,
}: {
  text: string;
  sceneIndex: number;
  /** The shared voice channel: position now, timings per scene. */
  channel: NarrationChannel;
  /** When true, wraps the active sentence in a floating white pill card (sample style). */
  floatingCard?: boolean;
}) {
  // Sparse by design: punctuation and whitespace are rendered as bare text, so
  // some indices in this list never get a node.
  const wordsRef = useRef<(HTMLSpanElement | null)[]>([]);
  /** Timings for the current sentence, re-derived when the voice's marks arrive. */
  const trackRef = useRef<KaraokeTrack | null>(null);
  const lastLitRef = useRef(-2);
  const frameRef = useRef<number | null>(null);
  /** How many word marks the current alignment was built from. */
  const builtForRef = useRef<string | null>(null);

  /**
   * How many marks this scene's timings hold, as a string so a ref compare
   * decides whether anything changed.
   */
  const [marksVersion, setMarksVersion] = useState(0);

  useEffect(() => {
    const size = () => String(channel.words.get(sceneIndex)?.length ?? 0);
    let builtFor = size();
    if (builtFor !== builtForRef.current) {
      builtForRef.current = builtFor;
      setMarksVersion((value) => value + 1);
    }

    let waits = 0;
    const poll = window.setInterval(() => {
      const current = size();
      if (current === builtFor) {
        if ((waits += 1) > 80) window.clearInterval(poll);
        return;
      }
      builtFor = current;
      builtForRef.current = current;
      window.clearInterval(poll);
      setMarksVersion((value) => value + 1);
    }, 250);

    return () => window.clearInterval(poll);
  }, [channel, sceneIndex]);

  const sentences = useMemo<AlignedSentence[]>(
    () => alignSentences(text, channel.words.get(sceneIndex) ?? []),
    [text, sceneIndex, channel, marksVersion],
  );

  /**
   * The sentence covering the current timeline/audio offset.
   * Matches YouTube-style subtitle intervals so seeking anywhere immediately shows the right text.
   */
  const sentenceAt = (time: number): number => {
    if (sentences.length <= 1) return 0;
    let chosen = -1;
    for (let i = 0; i < sentences.length; i += 1) {
      const start = sentences[i].start;
      if (start === null) continue;
      if (start <= time) chosen = i;
      else break;
    }
    return chosen === -1 ? 0 : chosen;
  };

  /** Index of the sentence on screen, initialized to wherever playhead currently sits. */
  const initialTime =
    channel.live && channel.live.sceneIndex === sceneIndex ? channel.live.time : 0;
  const spokenIndexRef = useRef(sentenceAt(initialTime));

  /**
   * Which sentences are on screen, and a counter to re-render them.
   */
  const [shownVersion, setShownVersion] = useState(0);

  // Sync sentence when scene or sentences change
  useEffect(() => {
    const time = channel.live && channel.live.sceneIndex === sceneIndex ? channel.live.time : null;
    if (time !== null) {
      const targetSentence = sentenceAt(time);
      if (spokenIndexRef.current !== targetSentence) {
        spokenIndexRef.current = targetSentence;
        setShownVersion((v) => v + 1);
      }
    }
  }, [sentences, sceneIndex, channel.live]);

  const shown = useMemo(() => {
    const index = Math.min(Math.max(0, spokenIndexRef.current), Math.max(0, sentences.length - 1));
    return [sentences[index] ?? null, sentences[index + 1] ?? null] as const;
  }, [sentences, shownVersion]);

  useEffect(() => {
    const paint = () => {
      const live = channel.live;
      const nodes = wordsRef.current;
      const time = live && live.sceneIndex === sceneIndex ? live.time : null;

      if (time === null) {
        frameRef.current = requestAnimationFrame(paint);
        return;
      }

      // Where the caption is. This changes when crossing sentence boundary or seeking.
      const sentence = sentenceAt(time);
      if (sentence !== spokenIndexRef.current) {
        spokenIndexRef.current = sentence;
        setShownVersion((value) => value + 1);
        lastLitRef.current = -2;
        for (const node of nodes) if (node) node.dataset.state = "idle";
      }

      const track = trackRef.current;
      if (track) {
        const active = activeWordIndex(track, time);
        if (active !== lastLitRef.current) {
          const jumped = Math.abs(active - lastLitRef.current) > 1;
          if (jumped) {
            for (let i = 0; i < nodes.length; i += 1) {
              const node = nodes[i];
              if (!node) continue;
              node.dataset.state = i < active ? "said" : i === active ? "now" : "idle";
            }
          } else {
            const previous = lastLitRef.current;
            const leaving = previous >= 0 ? nodes[previous] : null;
            if (leaving) {
              leaving.dataset.state = previous < active ? "said" : "idle";
            }
            const entering = active >= 0 ? nodes[active] : null;
            if (entering) entering.dataset.state = "now";
          }
          lastLitRef.current = active;
        }
      }
      frameRef.current = requestAnimationFrame(paint);
    };

    frameRef.current = requestAnimationFrame(paint);
    return () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    };
  }, [channel, sceneIndex, sentences]);

  // The word track for whichever sentence is on screen, built from the tokens
  // that same sentence already owns. The spans rendered below are these exact
  // token objects, so a token index the track hands back always names the node
  // holding that word — previously the two lists were built by separate calls
  // and a mismatch would light the wrong words.
  useEffect(() => {
    const tokens = shown[0]?.tokens ?? [];
    trackRef.current = tokens.some((token) => token.start !== null)
      ? buildTrack(tokens)
      : null;
    lastLitRef.current = -2;
  }, [shown]);

  const current = shown[0];
  const next = shown[1];

  if (floatingCard) {
    return (
      <div className="scene-caption-stack pointer-events-none flex max-w-[88%] flex-col items-center gap-[0.6cqw] text-center">
        <div className="floating-subtitle-card pointer-events-none">
          <p className="scene-narration pointer-events-none overflow-hidden text-center">
            {(current?.tokens ?? []).map((token, index) => token.text.trim().length === 0 ? token.text : (
              <span
                key={index}
                ref={(node) => {
                  wordsRef.current[index] = node;
                }}
                data-state="idle"
                className="px-[1px]"
              >
                <InlineText text={token.text} />
              </span>
            ))}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="scene-caption-stack pointer-events-none flex max-w-[84%] flex-col items-center gap-[0.6cqw] text-center">
      <p className="scene-narration pointer-events-none overflow-hidden text-center">
        {/* No newlines between the spans. JSX collapses the indentation between
            expressions into real space text nodes, and since each token already
            carries its own trailing space, every word was separated by two. */}
        {(current?.tokens ?? []).map((token, index) => token.text.trim().length === 0 ? token.text : (
          <span
            key={index}
            ref={(node) => {
              // Indexed by token position, not by push order: the track hands
              // back token indexes and whitespace tokens have no node to point at.
              wordsRef.current[index] = node;
            }}
            data-state="idle"
            className="px-[1px]"
          >
            <InlineText text={token.text} />
          </span>
        ))}
      </p>
      {/* The sentence coming next, held back and faint. It tells the reader where
          the voice is going, and it is the same size as the live line so the
          hand-over does not jump.

          Rendered even on the last sentence, where it is empty and hidden. The
          row is part of the reserved height described in `.scene-caption-stack`,
          so removing it would shrink the block and slide the live line upward on
          exactly the frame the reader is looking at. */}
      <p
        className="scene-narration-next pointer-events-none overflow-hidden text-center"
        style={{ visibility: next ? "visible" : "hidden" }}
      >
        <InlineText text={next?.text ?? ""} />
      </p>
    </div>
  );
}

