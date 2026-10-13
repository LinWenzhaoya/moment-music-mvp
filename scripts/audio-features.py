"""Local, free audio measurements for every available track: tempo (BPM) and integrated loudness (LUFS).

The model is asked for a felt tempo (慢/中/快); requests like "跑步 160 BPM" or "睡前要轻" need real numbers,
which signal processing measures better than a language model guesses.

    ../music-downloader/.venv/bin/python scripts/audio-features.py [--workers 8] [--limit N]

Incremental: a track is re-measured only when its file mtime changed. Needs librosa + ffmpeg.
"""
import argparse
import os
import re
import sqlite3
import subprocess
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
DB = Path(os.environ.get('MUSIC_DATABASE_PATH', HERE / 'local-music' / 'music-library.sqlite'))


def library_root():
    if os.environ.get('MUSIC_LIBRARY_PATH'):
        return Path(os.environ['MUSIC_LIBRARY_PATH'])
    for line in (HERE / '.env.local').read_text(encoding='utf-8').splitlines():
        if line.startswith('MUSIC_LIBRARY_PATH='):
            return Path(line.split('=', 1)[1].strip())
    return HERE.parent / 'music-repo'


def loudness(path):
    result = subprocess.run(['ffmpeg', '-nostats', '-i', str(path), '-filter_complex', 'ebur128', '-f', 'null', '-'],
                            capture_output=True, text=True)
    found = re.findall(r'I:\s+(-?\d+(?:\.\d+)?) LUFS', result.stderr)
    return float(found[-1]) if found else None


def tempo(path):
    import librosa
    import numpy as np
    # 22.05 kHz mono and the middle 2 minutes: intros/outros often have no beat and skew the estimate.
    duration = librosa.get_duration(path=str(path))
    offset = max(0.0, duration / 2 - 60)
    y, sr = librosa.load(str(path), sr=22050, mono=True, offset=offset, duration=120)
    bpm = librosa.feature.tempo(y=y, sr=sr, aggregate=np.median)
    return round(float(bpm[0]), 1) if len(bpm) else None


def measure(job):
    track_id, path, mtime = job
    try:
        return track_id, tempo(path), loudness(path), mtime, None
    except Exception as error:  # one bad file must not stop the run
        return track_id, None, None, mtime, str(error)[:200]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--workers', type=int, default=os.cpu_count() or 4)
    parser.add_argument('--limit', type=int, default=0)
    args = parser.parse_args()
    root = library_root()
    db = sqlite3.connect(DB, timeout=30)
    db.execute('''CREATE TABLE IF NOT EXISTS track_audio_features (
      track_id INTEGER PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
      bpm REAL, loudness_lufs REAL, modified_at INTEGER, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)''')
    if 'bpm_perceived' not in {row[1] for row in db.execute('PRAGMA table_info(track_audio_features)')}:
        db.execute('ALTER TABLE track_audio_features ADD COLUMN bpm_perceived REAL')
    rows = db.execute('''SELECT t.id, t.relative_path, t.modified_at FROM tracks t
      LEFT JOIN track_audio_features f ON f.track_id=t.id
      WHERE t.available=1 AND (f.track_id IS NULL OR f.modified_at IS NOT t.modified_at)''').fetchall()
    jobs = [(track_id, root / relative, mtime) for track_id, relative, mtime in rows][: args.limit or None]
    print(f'Library: {root}\nTracks to measure: {len(jobs)}', flush=True)
    done = failed = 0
    with ProcessPoolExecutor(max_workers=args.workers) as pool:
        for track_id, bpm, lufs, mtime, error in pool.map(measure, jobs, chunksize=4):
            if error:
                failed += 1
                print(f'failed {track_id}: {error}', flush=True)
                continue
            db.execute('''INSERT INTO track_audio_features (track_id, bpm, loudness_lufs, modified_at) VALUES (?, ?, ?, ?)
              ON CONFLICT(track_id) DO UPDATE SET bpm=excluded.bpm, loudness_lufs=excluded.loudness_lufs,
              modified_at=excluded.modified_at, updated_at=CURRENT_TIMESTAMP''', (track_id, bpm, lufs, mtime))
            db.commit()  # commit per track: the tagging script writes to the same database concurrently
            done += 1
            if done % 200 == 0:
                print(f'[{done}/{len(jobs)}] failed {failed}', flush=True)
    db.commit()
    print(f'Measured {done}, failed {failed}', flush=True)
    # Beat trackers often lock onto hi-hats and report double time for ballads (年轮: 143.6 measured, ~72 felt).
    # The model's felt tempo (慢/中/快) breaks the tie; re-run this pass after tagging.
    db.execute('''UPDATE track_audio_features SET bpm_perceived = CASE
        WHEN bpm IS NULL THEN NULL
        WHEN (SELECT tempo FROM song_tags_v2 v WHERE v.track_id=track_audio_features.track_id)='慢' AND bpm >= 115 THEN round(bpm / 2, 1)
        WHEN (SELECT tempo FROM song_tags_v2 v WHERE v.track_id=track_audio_features.track_id)='中' AND bpm >= 135 THEN round(bpm / 2, 1)
        WHEN (SELECT tempo FROM song_tags_v2 v WHERE v.track_id=track_audio_features.track_id)='快' AND bpm < 80 THEN round(bpm * 2, 1)
        ELSE bpm END''')
    db.commit()


if __name__ == '__main__':
    main()
