"""Extract only what we need from the whale-girl tarball, with explicit UTF-8 path handling.

bsdtar on this box mangles the Chinese motion/expression filenames and leaves a wedged
directory behind, so we decode members ourselves and write them one by one.
"""
import os
import sys
import tarfile

SRC = "vendor/_downloads/whale-girl.tar.gz"
PREFIX = "dsh-whale-girl-live2d-main/"
DEST = "vendor/whale-girl"
SKIP_DIRS = ("docs/share/", ".git/")

written = 0
skipped = 0
archive = tarfile.open(SRC, "r:gz")
for member in archive:
    name = member.name
    if not name.startswith(PREFIX):
        continue
    rel = name[len(PREFIX):]
    if not rel or any(rel.startswith(d) for d in SKIP_DIRS):
        continue
    target = os.path.join(DEST, *rel.rstrip("/").split("/"))
    if member.isdir():
        os.makedirs(target, exist_ok=True)
        continue
    if not member.isfile():
        skipped += 1
        continue
    os.makedirs(os.path.dirname(target), exist_ok=True)
    data = archive.extractfile(member)
    if data is None:
        skipped += 1
        continue
    with open(target, "wb") as fh:
        fh.write(data.read())
    written += 1

print(f"written={written} skipped={skipped}")
for root, dirs, files in os.walk(DEST):
    depth = root[len(DEST):].count(os.sep)
    if depth <= 1:
        print(f"{'  ' * depth}{os.path.basename(root) or '.'}/  ({len(files)} files)")

