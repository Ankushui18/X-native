#!/usr/bin/env python3
"""Build a portable native-app archive. Does not sign, notarize or publish."""
import argparse
import hashlib
import os
from pathlib import Path
import platform
import shutil
import subprocess
import zipfile

root = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument("--skip-build", action="store_true")
args = parser.parse_args()
if not args.skip_build:
    subprocess.run(["cargo", "build", "--release", "--locked", "-p", "x-designer", "--bin", "x_native_app"], cwd=root, check=True)
exe = "x_native_app.exe" if os.name == "nt" else "x_native_app"
binary = root / "target" / "release" / exe
if not binary.is_file():
    raise SystemExit(f"Missing release binary: {binary}")
name = f"x-native-{platform.system().lower()}-{platform.machine()}"
folder = root / "artifacts" / name
folder.mkdir(parents=True, exist_ok=True)
shutil.copy2(binary, folder / exe)
shutil.copy2(root / "docs" / "RELIABILITY.md", folder / "README.md")
shutil.copytree(root / "apps" / "x-designer" / "assets" / "fonts" / "licenses", folder / "font-licenses", dirs_exist_ok=True)
shutil.copy2(root / "THIRD_PARTY_NOTICES.md", folder / "THIRD_PARTY_NOTICES.md")
license_file = root / "LICENSE"
if license_file.is_file():
    shutil.copy2(license_file, folder / "LICENSE")
else:
    (folder / "DISTRIBUTION-NOTICE.txt").write_text("Internal evaluation build. A project code license has not been supplied by the maintainer. Font licenses do not license the application code.\n")
archive = folder.with_suffix(".zip")
with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as z:
    for f in sorted(folder.rglob("*")):
        if f.is_file():
            z.write(f, f.relative_to(folder.parent))
archive.with_suffix(".zip.sha256").write_text(hashlib.sha256(archive.read_bytes()).hexdigest() + "  " + archive.name + "\n")
print(archive)
