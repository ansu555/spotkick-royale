#!/usr/bin/env python3
"""Convert packages/shared/vectors/derivation.json (TS reference) into the schema Golden.t.sol reads.
Run from repo root: python3 contracts/test/vectors/convert_shared.py"""
import json
src = json.load(open("packages/shared/vectors/derivation.json"))
table = json.load(open("packages/shared/save-table.json"))
table = table if isinstance(table, list) else table.get("saveBps") or table.get("table")
out = {"saveTable": table, "vectors": []}
for c in src:
    px, py, pk, autos = [0]*10, [0]*10, [0]*10, {}
    auto = {a["seat"]: (a["x"], a["y"]) for a in c["expected"]["autoPicks"]}
    for p in c["picks"]:
        s = p["seat"]
        if p["picked"]:
            px[s], py[s], pk[s] = p["x"], p["y"], 1
    for s, xy in auto.items():
        autos[str(s)] = list(xy)
    e = c["expected"]
    out["vectors"].append({
        "seed": c["seed"], "aliveMask": c["aliveMask"], "px": px, "py": py, "picked": pk, "autos": autos,
        "targetX": e["targetX"], "targetY": e["targetY"], "saveBps": e["saveBps"],
        "saved": 1 if e["outcome"] == "saved" else 0,
        "survivorMask": e["survivorMask"], "radiusMm": e["radiusMm"],
    })
json.dump(out, open("contracts/test/vectors/shared.json", "w"))
print("wrote", len(out["vectors"]), "vectors")
