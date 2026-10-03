"""Reproducible Cocoa-attribute/lock regression archive; no external dependencies."""
import json
import zipfile
from pathlib import Path

alignments = [("LEFT", 0), ("CENTER", 2), ("RIGHT", 1), ("JUSTIFIED", 3)]
layers = []
for i, (name, alignment) in enumerate(alignments):
    content = "State " + name
    layers.append({
        "_class": "text", "do_objectID": "state-" + name, "name": name,
        "isVisible": True, "isLocked": name == "RIGHT",
        "frame": {"x": 20, "y": 40 + i * 40, "width": 200, "height": 24},
        "attributedString": {"string": content, "attributes": [{
            "location": 0, "length": len(content), "attributes": {
                "NSFontAttribute": {"name": "Inter", "size": 18},
                "NSKern": 2.25,
                "NSParagraphStyle": {"alignment": alignment, "maximumLineHeight": 27},
            },
        }]},
    })
target = Path(__file__).with_name("state-text.sketch")
with zipfile.ZipFile(target, "w") as archive:
    for path, data in [
        ("document.json", {"pages": [{"_ref": "pages/state"}]}),
        ("pages/state.json", {"_class": "page", "name": "State", "do_objectID": "state", "layers": layers}),
    ]:
        entry = zipfile.ZipInfo(path, date_time=(2026, 9, 27, 0, 0, 0))
        entry.compress_type = zipfile.ZIP_DEFLATED
        archive.writestr(entry, json.dumps(data, separators=(",", ":")))
print("wrote", target, target.stat().st_size, "bytes")
