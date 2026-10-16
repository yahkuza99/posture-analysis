"""Nightly backup of the posture server's case folder.

    python server/backup.py --data D:/AHG/posture/cases --zip-dir D:/AHG/backup/posture --keep 30 \
        --mirror C:/Users/User/OneDrive/AHG-Backup/posture

1. a dated ZIP of every case (+ clinic settings, deleted cases in .trash) — kept --keep deep;
   the same layout the app's "restore from backup" reads (cases/<name>.json, settings.json)
2. --mirror: an up-to-date copy of the folder somewhere else (e.g. a synced cloud folder);
   files removed from the source are removed from the mirror too, the ZIPs keep history
A ZIP is checked by reading it back before older ones are pruned.
"""
import argparse
import datetime
import json
import os
import shutil
import sys
import zipfile


def make_zip(data, zip_dir):
    os.makedirs(zip_dir, exist_ok=True)
    name = "posture-backup_%s.zip" % datetime.datetime.now().strftime("%Y-%m-%d_%H%M")
    path = os.path.join(zip_dir, name)
    tmp = path + ".part"
    n = 0
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as z:
        for entry in sorted(os.listdir(data)):
            full = os.path.join(data, entry)
            if os.path.isfile(full) and entry.lower().endswith(".json") and not entry.startswith("."):
                z.write(full, "cases/" + entry)
                n += 1
        settings = os.path.join(data, ".settings.json")
        if os.path.isfile(settings):
            z.write(settings, "settings.json")
        trash = os.path.join(data, ".trash")
        if os.path.isdir(trash):
            for entry in sorted(os.listdir(trash)):
                z.write(os.path.join(trash, entry), "deleted/" + entry)
        z.writestr("README.txt", "Posture Analysis server backup %s\ncases: %d\n"
                   "Restore: app > Settings > restore from backup file\n" % (datetime.datetime.now().isoformat(" ", "seconds"), n))
    with zipfile.ZipFile(tmp) as z:              # read it all back before trusting it
        bad = z.testzip()
        if bad:
            raise RuntimeError("backup zip is damaged at " + bad)
        for info in z.infolist():
            if info.filename.startswith("cases/"):
                json.loads(z.read(info))
    os.replace(tmp, path)
    return path, n


def prune(zip_dir, keep):
    zips = sorted(f for f in os.listdir(zip_dir) if f.startswith("posture-backup_") and f.endswith(".zip"))
    for old in zips[:-keep] if keep > 0 else []:
        os.remove(os.path.join(zip_dir, old))
    return max(0, len(zips) - keep)


def mirror(src, dst):
    os.makedirs(dst, exist_ok=True)
    copied = removed = 0
    for root, _dirs, files in os.walk(src):
        rel = os.path.relpath(root, src)
        out = os.path.normpath(os.path.join(dst, rel))
        os.makedirs(out, exist_ok=True)
        for f in files:
            if ".tmp-" in f:
                continue
            s, d = os.path.join(root, f), os.path.join(out, f)
            if not os.path.isfile(d) or os.path.getsize(d) != os.path.getsize(s) or os.path.getmtime(d) < os.path.getmtime(s):
                shutil.copy2(s, d)
                copied += 1
    for root, _dirs, files in os.walk(dst):
        rel = os.path.relpath(root, dst)
        for f in files:
            if not os.path.exists(os.path.join(src, rel, f)):
                os.remove(os.path.join(root, f))
                removed += 1
    return copied, removed


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True)
    ap.add_argument("--zip-dir", required=True)
    ap.add_argument("--keep", type=int, default=30)
    ap.add_argument("--mirror")
    a = ap.parse_args()
    stamp = datetime.datetime.now().isoformat(" ", "seconds")
    path, n = make_zip(a.data, a.zip_dir)
    pruned = prune(a.zip_dir, a.keep)
    msg = "%s zip %s cases=%d size=%dKB pruned=%d" % (stamp, os.path.basename(path), n, os.path.getsize(path) // 1024, pruned)
    if a.mirror:
        try:
            c, r = mirror(a.data, a.mirror)
            msg += " mirror copied=%d removed=%d" % (c, r)
        except OSError as exc:                  # the ZIP is already safe; report and fail the task
            print(msg + " MIRROR FAILED: %s" % exc, flush=True)
            return 2
    print(msg, flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
