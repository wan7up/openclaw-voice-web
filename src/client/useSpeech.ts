import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const replyPlaybackRate = 1.35;

export function useSpeech() {
  const [speakingId, setSpeakingId] = useState<string | null>(null);
  const supported = typeof window !== "undefined";
  const speakingIdRef = useRef<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const unlockedRef = useRef(false);

  const voices = useMemo(() => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return [];
    return window.speechSynthesis.getVoices();
  }, []);

  const stop = useCallback(() => {
    audioRef.current?.pause();
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
    speakingIdRef.current = null;
    setSpeakingId(null);
  }, []);

  const speak = useCallback(
    async (id: string, text: string, audioUrl?: string): Promise<boolean> => {
      if (!supported || !text.trim()) return false;
      stop();

      try {
        const url = audioUrl ?? (await createServerAudioUrl(text));
        const audio = getAudioElement();
        audio.pause();
        audio.src = url;
        audio.currentTime = 0;
        audio.muted = false;
        audio.volume = 1;
        audio.playbackRate = replyPlaybackRate;
        audio.preload = "auto";
        audio.onended = () => finishSpeaking(id);
        audio.onerror = () => finishSpeaking(id);
        audio.load();
        await audio.play();
        await waitForActualPlayback(audio);
        speakingIdRef.current = id;
        setSpeakingId(id);
        unlockedRef.current = true;
        return true;
      } catch {
        return await speakWithBrowser(id, text);
      }
    },
    [stop, supported, voices]
  );

  const unlock = useCallback(() => {
    if (!supported || unlockedRef.current) return;
    const audio = getAudioElement();
    audio.muted = true;
    audio.volume = 0;
    audio.src = silentAudioDataUrl;
    audio.play()
      .then(() => {
        audio.pause();
        audio.currentTime = 0;
        audio.muted = false;
        audio.volume = 1;
        unlockedRef.current = true;
      })
      .catch(() => undefined);
  }, [supported]);

  async function createServerAudioUrl(text: string): Promise<string> {
    const response = await fetch("api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text })
    });
    if (!response.ok) throw new Error("server tts failed");
    const payload = await response.json();
    if (typeof payload?.url !== "string") throw new Error("server tts returned no audio url");
    return payload.url;
  }

  function speakWithBrowser(id: string, text: string): Promise<boolean> {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) {
      finishSpeaking(id);
      return Promise.resolve(false);
    }

    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = "zh-CN";
    utterance.rate = replyPlaybackRate;
    const zhVoice = voices.find((voice) => voice.lang.toLowerCase().startsWith("zh"));
    if (zhVoice) utterance.voice = zhVoice;
    return new Promise((resolve) => {
      const timeout = window.setTimeout(() => {
        cleanup();
        window.speechSynthesis.cancel();
        resolve(false);
      }, 1800);

      const cleanup = () => {
        window.clearTimeout(timeout);
      };

      utterance.onstart = () => {
        cleanup();
        speakingIdRef.current = id;
        setSpeakingId(id);
        resolve(true);
      };
      utterance.onend = () => {
        cleanup();
        finishSpeaking(id);
      };
      utterance.onerror = () => {
        cleanup();
        finishSpeaking(id);
        resolve(false);
      };
      window.speechSynthesis.speak(utterance);
    });
  }

  function getAudioElement(): HTMLAudioElement {
    if (audioRef.current) return audioRef.current;
    const audio = new Audio();
    audio.preload = "auto";
    audio.playbackRate = replyPlaybackRate;
    audio.setAttribute("playsinline", "true");
    audioRef.current = audio;
    return audio;
  }

  function waitForActualPlayback(audio: HTMLAudioElement): Promise<void> {
    if (!audio.paused && audio.currentTime > 0) return Promise.resolve();

    return new Promise((resolve, reject) => {
      const startedAt = audio.currentTime;
      const timeout = window.setTimeout(() => {
        cleanup();
        if (!audio.paused && audio.currentTime > startedAt) {
          resolve();
          return;
        }
        audio.pause();
        reject(new Error("audio did not start"));
      }, 1800);

      const confirmStarted = () => {
        if (audio.paused) return;
        cleanup();
        resolve();
      };

      const confirmProgress = () => {
        if (audio.currentTime <= startedAt) return;
        cleanup();
        resolve();
      };

      const fail = () => {
        cleanup();
        reject(new Error("audio playback failed"));
      };

      const cleanup = () => {
        window.clearTimeout(timeout);
        audio.removeEventListener("playing", confirmStarted);
        audio.removeEventListener("timeupdate", confirmProgress);
        audio.removeEventListener("error", fail);
        audio.removeEventListener("stalled", fail);
        audio.removeEventListener("abort", fail);
      };

      audio.addEventListener("playing", confirmStarted);
      audio.addEventListener("timeupdate", confirmProgress);
      audio.addEventListener("error", fail);
      audio.addEventListener("stalled", fail);
      audio.addEventListener("abort", fail);
    });
  }

  function finishSpeaking(id: string) {
    if (speakingIdRef.current !== id) return;
    speakingIdRef.current = null;
    setSpeakingId(null);
  }

  useEffect(() => {
    return () => stop();
  }, [stop]);

  return { supported, speakingId, speak, stop, unlock };
}

const silentAudioDataUrl =
  "data:audio/wav;base64,UklGRigAAABXQVZFZm10IBAAAAABAAEAESsAACJWAAACABAAZGF0YQQAAAAAAA==";
