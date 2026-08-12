#!/usr/bin/env python3
"""Render the Canopy Sacred Grove Bells arrangement.

The foundation is yd's CC0 loop "Shrine" from OpenGameArt. The temple bell
and small suzu layers are deterministic original synthesis generated here; no
audio or melody from the operator's YouTube reference is used.
"""

from __future__ import annotations

import argparse
import hashlib
import math
import shutil
import struct
import subprocess
import tempfile
import urllib.request
import wave
from array import array
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SOURCE_URL = "https://opengameart.org/sites/default/files/shrine_0.ogg"
SOURCE_SHA256 = "35a3051a7b6d4fddda564624cff960b77722fd8bcf4a3e07ceceb060b6c0f080"
DEFAULT_OUTPUT = ROOT / "public" / "assets" / "audio" / "tracks" / "sacred-grove-bells.mp3"
SAMPLE_RATE = 44_100
DURATION_SECONDS = 108.5


def source_hash(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def obtain_source(explicit: Path | None, temporary_root: Path) -> Path:
    source = explicit.resolve() if explicit else temporary_root / "shrine.ogg"
    if not explicit:
        urllib.request.urlretrieve(SOURCE_URL, source)
    actual_hash = source_hash(source)
    if actual_hash != SOURCE_SHA256:
        raise RuntimeError(f"Unexpected Shrine source hash: {actual_hash}")
    return source


def pan_gains(pan: float) -> tuple[float, float]:
    angle = (max(-1.0, min(1.0, pan)) + 1.0) * math.pi / 4
    return math.cos(angle), math.sin(angle)


def add_bell(
    left: array,
    right: array,
    *,
    start: float,
    frequency: float,
    amplitude: float,
    decay: float,
    pan: float,
    temple: bool = False,
) -> None:
    ratios = (1.0, 2.01, 2.67, 3.93, 5.41) if temple else (1.0, 1.93, 2.76, 4.08, 5.47)
    weights = (1.0, 0.62, 0.38, 0.24, 0.12) if temple else (1.0, 0.56, 0.32, 0.17, 0.07)
    partial_decays = (1.0, 0.72, 0.54, 0.39, 0.28) if temple else (1.0, 0.74, 0.57, 0.40, 0.25)
    duration = min(DURATION_SECONDS - start, decay * (4.0 if temple else 3.2))
    if duration <= 0:
        return
    start_frame = max(0, int(start * SAMPLE_RATE))
    frame_count = min(len(left) - start_frame, int(duration * SAMPLE_RATE))
    left_gain, right_gain = pan_gains(pan)
    for offset in range(frame_count):
        time = offset / SAMPLE_RATE
        attack = 1.0 - math.exp(-time * (34.0 if temple else 68.0))
        shimmer_left = 0.0
        shimmer_right = 0.0
        for partial_index, (ratio, weight, partial_decay) in enumerate(zip(ratios, weights, partial_decays)):
            envelope = math.exp(-time / max(0.08, decay * partial_decay))
            phase = 2 * math.pi * frequency * ratio * time
            stereo_phase = 0.0 if temple else (partial_index + 1) * 0.035
            shimmer_left += weight * envelope * math.sin(phase - stereo_phase)
            shimmer_right += weight * envelope * math.sin(phase + stereo_phase)
        frame = start_frame + offset
        left[frame] += amplitude * attack * shimmer_left * left_gain
        right[frame] += amplitude * attack * shimmer_right * right_gain


def add_suzu_cluster(left: array, right: array, start: float, frequency: float, pan: float) -> None:
    # A kagura-suzu gesture: three softer strikes placed at different depths.
    # Keep the highest partials restrained so the middle phrases stay spacious
    # instead of turning into a sharp, stacked transient.
    for index, (delay, interval, level) in enumerate(((0.0, 1.0, 0.075), (0.17, 1.24, 0.050), (0.36, 1.5, 0.034))):
        add_bell(
            left,
            right,
            start=start + delay,
            frequency=frequency * interval,
            amplitude=level,
            decay=1.55 + index * 0.22,
            pan=max(-0.92, min(0.92, pan + (index - 1) * 0.32)),
        )


def write_stereo_wave(path: Path, left: array, right: array) -> None:
    peak = max(max(abs(value) for value in left), max(abs(value) for value in right), 0.001)
    scale = min(0.88 / peak, 1.0)
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as output:
        output.setnchannels(2)
        output.setsampwidth(2)
        output.setframerate(SAMPLE_RATE)
        block = bytearray()
        for left_value, right_value in zip(left, right):
            block.extend(struct.pack("<hh", int(left_value * scale * 32767), int(right_value * scale * 32767)))
            if len(block) >= 1024 * 1024:
                output.writeframesraw(block)
                block.clear()
        if block:
            output.writeframesraw(block)


def render_temple_bells(path: Path) -> None:
    frame_count = int(DURATION_SECONDS * SAMPLE_RATE)
    left = array("f", [0.0]) * frame_count
    right = array("f", [0.0]) * frame_count

    # Bonsho-like low bells divide the two passes through the ancient shrine.
    add_bell(left, right, start=0.65, frequency=73.42, amplitude=0.19, decay=5.4, pan=-0.05, temple=True)
    add_bell(left, right, start=54.75, frequency=55.0, amplitude=0.16, decay=6.0, pan=0.08, temple=True)
    add_bell(left, right, start=82.1, frequency=73.42, amplitude=0.085, decay=4.5, pan=-0.18, temple=True)
    write_stereo_wave(path, left, right)


def render_suzu_bells(path: Path) -> None:
    frame_count = int(DURATION_SECONDS * SAMPLE_RATE)
    left = array("f", [0.0]) * frame_count
    right = array("f", [0.0]) * frame_count

    # D/E/G/A/B pentatonic suzu phrases, kept sparse so the scene stays calm.
    phrases = (
        (7.8, 587.33, -0.62),
        (15.4, 880.0, 0.48),
        (25.2, 659.25, -0.18),
        (34.8, 783.99, 0.68),
        (44.0, 493.88, -0.52),
        (50.1, 587.33, 0.24),
        (62.4, 880.0, -0.44),
        (70.7, 783.99, 0.56),
        (78.0, 659.25, -0.68),
        (89.2, 493.88, 0.38),
        (97.0, 587.33, -0.24),
        (103.2, 880.0, 0.64),
    )
    for start, frequency, pan in phrases:
        add_suzu_cluster(left, right, start, frequency, pan)
    write_stereo_wave(path, left, right)


def encode_arrangement(source: Path, temple_bells: Path, suzu_bells: Path, output: Path) -> None:
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise RuntimeError("ffmpeg is required to render Sacred Grove Bells")
    output.parent.mkdir(parents=True, exist_ok=True)
    filter_graph = (
        f"[0:a]atrim=duration={DURATION_SECONDS},asetpts=PTS-STARTPTS,volume=0.82[shrine];"
        "[1:a]highpass=f=70,lowpass=f=7000,volume=1.0,"
        "aecho=0.82:0.40:110|260|510|820:0.24|0.15|0.09|0.05[temple];"
        "[2:a]highpass=f=190,lowpass=f=10500,"
        "equalizer=f=5200:t=q:w=0.7:g=-4,"
        "acompressor=threshold=0.08:ratio=2.5:attack=12:release=180:makeup=1,"
        "volume=0.68,aecho=0.76:0.22:135|330|650:0.14|0.08|0.04,"
        "stereowiden=delay=24:feedback=0.08:crossfeed=0.16:drymix=0.92[suzu];"
        "[shrine][temple][suzu]amix=inputs=3:duration=shortest:normalize=0,"
        "highpass=f=32,lowpass=f=17500,loudnorm=I=-13:LRA=9:TP=-1.2[out]"
    )
    result = subprocess.run(
        [
            ffmpeg,
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-stream_loop",
            "1",
            "-i",
            str(source),
            "-i",
            str(temple_bells),
            "-i",
            str(suzu_bells),
            "-filter_complex",
            filter_graph,
            "-map",
            "[out]",
            "-ar",
            str(SAMPLE_RATE),
            "-ac",
            "2",
            "-c:a",
            "libmp3lame",
            "-b:a",
            "192k",
            "-metadata",
            "title=Sacred Grove Bells",
            "-metadata",
            "artist=yd · Canopy arrangement",
            "-metadata",
            "comment=CC0 Shrine foundation with original synthesized temple bells and suzu",
            str(output),
        ],
        capture_output=True,
        text=True,
        check=False,
        timeout=600,
    )
    if result.returncode:
        raise RuntimeError(result.stderr.strip() or "ffmpeg failed")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, help="Use an already downloaded verified shrine.ogg")
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    with tempfile.TemporaryDirectory(prefix="canopy-sacred-grove-") as temp_dir:
        temporary_root = Path(temp_dir)
        source = obtain_source(args.source, temporary_root)
        temple_bells = temporary_root / "sacred-grove-temple-bells.wav"
        suzu_bells = temporary_root / "sacred-grove-suzu-bells.wav"
        render_temple_bells(temple_bells)
        render_suzu_bells(suzu_bells)
        encode_arrangement(source, temple_bells, suzu_bells, args.output.resolve())
    print(args.output.resolve())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
