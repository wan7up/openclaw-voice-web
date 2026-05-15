#!/usr/bin/env python3
import argparse
import json
import sys
import time


def main() -> int:
    parser = argparse.ArgumentParser(description="Transcribe an audio file with faster-whisper.")
    parser.add_argument("--file", required=True)
    parser.add_argument("--model", default="tiny")
    parser.add_argument("--language", default="")
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--compute-type", default="int8")
    parser.add_argument("--beam-size", type=int, default=1)
    args = parser.parse_args()

    started_at = time.time()
    try:
        from faster_whisper import WhisperModel

        model = WhisperModel(args.model, device=args.device, compute_type=args.compute_type)
        segments, info = model.transcribe(
            args.file,
            language=normalize_language(args.language),
            beam_size=args.beam_size,
            vad_filter=True,
        )
        text = "".join(segment.text for segment in segments).strip()
        print(
            json.dumps(
                {
                    "text": text,
                    "language": getattr(info, "language", None),
                    "languageProbability": getattr(info, "language_probability", None),
                    "durationSeconds": getattr(info, "duration", None),
                    "latencyMs": round((time.time() - started_at) * 1000),
                },
                ensure_ascii=False,
            )
        )
        return 0
    except Exception as error:
        print(json.dumps({"error": str(error)}, ensure_ascii=False), file=sys.stderr)
        return 1


def normalize_language(language: str) -> str | None:
    value = (language or "").strip()
    if not value or value.lower() == "auto":
        return None
    return value.split("-")[0].lower()


if __name__ == "__main__":
    raise SystemExit(main())
